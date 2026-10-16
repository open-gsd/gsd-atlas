import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createGrammarEngine, GrammarLoadError, GrammarRunError } from './index.ts';
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
