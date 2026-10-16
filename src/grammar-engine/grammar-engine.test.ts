import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Language, Parser } from 'web-tree-sitter';

import { defineGrammarEngineContract, loadToyScenarios } from './contract.ts';
import { createFakeGrammarEngine, createGrammarEngine, GrammarLoadError, GrammarRunError } from './index.ts';
import type { Capture, GrammarInput } from './index.ts';
import { withTree } from './with-tree.ts';

const toyDir = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

const lock = JSON.parse(fs.readFileSync(path.join(toyDir, 'grammar.lock'), 'utf8')) as {
  name: string;
  abi: number;
  wasm: { sha256: string };
};

function readQuery(name: string): string {
  return fs.readFileSync(path.join(toyDir, 'queries', `${name}.scm`), 'utf8');
}

function toyInput(overrides: Partial<GrammarInput> = {}): GrammarInput {
  return {
    name: lock.name,
    wasm: new Uint8Array(fs.readFileSync(path.join(toyDir, 'grammar.wasm'))),
    expectedSha256: lock.wasm.sha256,
    queries: { tags: readQuery('tags'), refs: readQuery('refs'), imports: readQuery('imports') },
    ...overrides,
  };
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(toyDir, 'fixtures', name), 'utf8');
}

/** (query, name, text) triples keep the assertions readable; spans are asserted separately. */
function summarise(captures: readonly Capture[]): Array<[string, string, string]> {
  return captures.map((c) => [c.query, c.name, c.text]);
}

function span(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  return { startLine, startColumn, endLine, endColumn };
}

async function withToyGrammar<T>(fn: (grammar: Awaited<ReturnType<ReturnType<typeof createGrammarEngine>['load']>>) => Promise<T>): Promise<T> {
  const engine = createGrammarEngine();
  const grammar = await engine.load(toyInput());
  try {
    return await fn(grammar);
  } finally {
    await grammar.dispose();
    await engine.dispose();
  }
}

describe('real engine: load', () => {
  it('loads the committed toy wasm with the hash from grammar.lock', async () => {
    await withToyGrammar(async (grammar) => {
      assert.equal(grammar.abi, lock.abi);
      assert.equal(grammar.name, 'atlas_toy');
    });
  });

  it('rejects a different expected hash with wasm_hash_mismatch before instantiating the wasm', async () => {
    const engine = createGrammarEngine();
    // Garbage bytes: if the engine instantiated them first the code would be wasm_invalid.
    const garbage = new Uint8Array([1, 2, 3, 4]);
    await assert.rejects(
      engine.load(toyInput({ wasm: garbage, expectedSha256: 'a'.repeat(64) })),
      (error: unknown) => error instanceof GrammarLoadError && error.code === 'wasm_hash_mismatch',
    );
    await assert.rejects(
      engine.load(toyInput({ expectedSha256: 'b'.repeat(64) })),
      (error: unknown) => error instanceof GrammarLoadError && error.code === 'wasm_hash_mismatch',
    );
    await engine.dispose();
  });

  it('rejects a query with a misspelled field with query_error carrying the engine text', async () => {
    const engine = createGrammarEngine();
    await assert.rejects(
      engine.load(
        toyInput({ queries: { tags: '(definition kind: "fn" nme: (identifier) @name) @definition.function' } }),
      ),
      (error: unknown) =>
        error instanceof GrammarLoadError && error.code === 'query_error' && /nme/.test(error.message),
    );
    await engine.dispose();
  });
});

describe('real engine: run', () => {
  it('returns the tags, refs and imports captures for basic.toy', async () => {
    await withToyGrammar(async (grammar) => {
      const result = await grammar.run(fixture('basic.toy'));
      assert.equal(result.hadBom, false);
      assert.deepEqual(summarise(result.captures), [
        ['imports', 'import.path', '"lib/util"'],
        ['tags', 'definition.function', 'fn main {\n  helper();\n}'],
        ['tags', 'name', 'main'],
        ['refs', 'reference.call', 'helper'],
        ['tags', 'definition.type', 'type Widget {\n}'],
        ['tags', 'name', 'Widget'],
      ]);
      assert.deepEqual(
        result.captures.map((c) => c.span),
        [span(1, 4, 1, 14), span(2, 0, 4, 1), span(2, 3, 2, 7), span(3, 2, 3, 8), span(5, 0, 6, 1), span(5, 5, 5, 11)],
      );
    });
  });

  it('counts an emoji as two UTF-16 units: string import columns 4 to 10', async () => {
    await withToyGrammar(async (grammar) => {
      const result = await grammar.run(fixture('emoji.toy'));
      const byName = (name: string) => result.captures.filter((c) => c.name === name);
      const [string] = byName('import.path');
      assert.ok(string);
      assert.deepEqual(string.span, span(1, 4, 1, 10));
      assert.equal(string.text.length, 6);
      assert.equal(string.text, '"a\u{1F600}b"');
      const [name] = byName('name');
      assert.ok(name);
      assert.deepEqual(name.span, span(2, 3, 2, 8));
      assert.equal(name.text, 'héllo');
      const [call] = byName('reference.call');
      assert.ok(call);
      assert.deepEqual(call.span, span(3, 2, 3, 6));
    });
  });

  it('gives CRLF input the same spans as LF input', async () => {
    await withToyGrammar(async (grammar) => {
      const lf = await grammar.run(fixture('basic.toy'));
      const crlf = await grammar.run(fixture('crlf.toy'));
      assert.deepEqual(
        crlf.captures.map((c) => [c.query, c.name, c.span]),
        lf.captures.map((c) => [c.query, c.name, c.span]),
      );
    });
  });

  it('strips a leading BOM, reports hadBom, and leaves line 0 columns as the editor shows them', async () => {
    await withToyGrammar(async (grammar) => {
      const result = await grammar.run(fixture('bom.toy'));
      assert.equal(result.hadBom, true);
      const name = result.captures.find((c) => c.name === 'name');
      assert.ok(name);
      assert.deepEqual(name.span, span(0, 3, 0, 4));
      assert.equal(name.text, 'a');
    });
  });

  it('rejects a source over the 2 MiB cap with source_too_large', async () => {
    await withToyGrammar(async (grammar) => {
      await assert.rejects(
        grammar.run('#'.repeat(2 * 1024 * 1024 + 1)),
        (error: unknown) => error instanceof GrammarRunError && error.code === 'source_too_large',
      );
    });
  });
});

describe('withTree', () => {
  function fakeParser(tree: { delete(): void } | null) {
    return { parse: (_source: string) => tree };
  }

  it('deletes the tree exactly once when the callback returns', () => {
    let deleted = 0;
    const tree = { delete: () => void (deleted += 1) };
    const value = withTree(fakeParser(tree), 'x', () => 42);
    assert.equal(value, 42);
    assert.equal(deleted, 1);
  });

  it('deletes the tree exactly once when the callback throws, and rethrows', () => {
    let deleted = 0;
    const tree = { delete: () => void (deleted += 1) };
    assert.throws(
      () =>
        withTree(fakeParser(tree), 'x', () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(deleted, 1);
  });

  it('turns a null tree into GrammarRunError parse_failed', () => {
    assert.throws(
      () => withTree(fakeParser(null), 'x', () => 1),
      (error: unknown) => error instanceof GrammarRunError && error.code === 'parse_failed',
    );
  });

  it('test helper sanity: the lock hash is the hash of the committed wasm bytes', () => {
    const digest = createHash('sha256').update(fs.readFileSync(path.join(toyDir, 'grammar.wasm'))).digest('hex');
    assert.equal(digest, lock.wasm.sha256);
  });
});

describe('real engine: load failures that need a real WASM runtime', () => {
  it('rejects garbage bytes whose sha256 matches the expected value with wasm_invalid', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const engine = createGrammarEngine();
    await assert.rejects(
      engine.load(toyInput({ wasm: garbage, expectedSha256: createHash('sha256').update(garbage).digest('hex') })),
      (error: unknown) => error instanceof GrammarLoadError && error.code === 'wasm_invalid',
    );
    await engine.dispose();
  });

  it('rejects a wasm over 8 MiB with wasm_too_large, ahead of the hash check', async () => {
    const engine = createGrammarEngine();
    await assert.rejects(
      engine.load(toyInput({ wasm: new Uint8Array(8 * 1024 * 1024 + 1) })),
      (error: unknown) => error instanceof GrammarLoadError && error.code === 'wasm_too_large',
    );
    await engine.dispose();
  });

  it('rejects a query over 256 KiB with query_too_large', async () => {
    const engine = createGrammarEngine();
    await assert.rejects(
      engine.load(toyInput({ queries: { tags: `; ${'x'.repeat(256 * 1024)}` } })),
      (error: unknown) => error instanceof GrammarLoadError && error.code === 'query_too_large',
    );
    await engine.dispose();
  });

  it('keeps working after a failed load (the engine is not poisoned)', async () => {
    const engine = createGrammarEngine();
    await assert.rejects(engine.load(toyInput({ expectedSha256: 'c'.repeat(64) })));
    const grammar = await engine.load(toyInput());
    assert.equal((await grammar.run(fixture('basic.toy'))).captures.length, 6);
    await engine.dispose();
  });

  it('withTree still deletes a real tree when the callback is deliberately faulty', async () => {
    await Parser.init();
    const language = await Language.load(toyInput().wasm);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      let deleted = 0;
      // Not a call to the parse method: lint allows parse calls only inside with-tree.ts.
      const realParse = parser.parse.bind(parser);
      const spying = {
        parse: (source: string) => {
          const tree = realParse(source);
          if (tree === null) return null;
          const realDelete = tree.delete.bind(tree);
          tree.delete = () => {
            deleted += 1;
            realDelete();
          };
          return tree;
        },
      };
      assert.throws(
        () =>
          withTree(spying, fixture('basic.toy'), () => {
            throw new Error('faulty callback');
          }),
        /faulty callback/,
      );
      assert.equal(deleted, 1);
    } finally {
      parser.delete();
    }
  });
});

describe('fake engine expectations are not echoed wrong data', () => {
  it('the scenarios the fake is scripted from equal hand-written expectations for emoji.toy', async () => {
    const scenarios = await loadToyScenarios();
    const emoji = scenarios.expected.get(scenarios.sources.emoji);
    assert.ok(emoji);
    assert.deepEqual(
      emoji.captures.map((c) => [c.query, c.name, c.span]),
      [
        ['imports', 'import.path', span(1, 4, 1, 10)],
        ['tags', 'definition.function', span(2, 0, 4, 1)],
        ['tags', 'name', span(2, 3, 2, 8)],
        ['refs', 'reference.call', span(3, 2, 3, 6)],
      ],
    );
    assert.equal(emoji.errorBytes, 0);
    assert.equal(emoji.hadBom, false);
    const bom = scenarios.expected.get(scenarios.sources.bom);
    assert.ok(bom);
    assert.equal(bom.hadBom, true);
    const broken = scenarios.expected.get(scenarios.sources.broken);
    assert.ok(broken);
    assert.ok(broken.errorBytes > 0);
  });
});

defineGrammarEngineContract('real engine', () => createGrammarEngine());
defineGrammarEngineContract('fake engine', (scenarios) =>
  createFakeGrammarEngine({ abi: scenarios.abi, results: scenarios.expected }),
);
