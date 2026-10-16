import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { validateFileFacts } from '../facts/index.ts';
import type { FileFacts } from '../facts/index.ts';
import { createGrammarEngine, extractFileFacts } from '../grammar-engine/index.ts';
import type { GrammarEngine, GrammarRunResult, LoadedGrammar } from '../grammar-engine/index.ts';
import { readModuleInputs } from './module-files.ts';

// LNG-08: the second, non-TypeScript language goes through the same extractor as the built-in modules.
const toyDir = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

let engine: GrammarEngine;
let grammar: LoadedGrammar;
let moduleName = '';
let moduleVersion = '';

before(async () => {
  const inputs = readModuleInputs(toyDir);
  assert.ok(inputs.ok, 'the toy module must be readable');
  moduleName = inputs.manifest.name;
  moduleVersion = inputs.manifest.version ?? 'unversioned';
  engine = createGrammarEngine();
  grammar = await engine.load(inputs.input);
});

after(async () => {
  await engine.dispose();
});

function fixture(name: string): string {
  return fs.readFileSync(path.join(toyDir, 'fixtures', name), 'utf8');
}

async function extractToy(source: string, file = 'a.toy'): Promise<{ facts: FileFacts; run: GrammarRunResult }> {
  const run = await grammar.run(source);
  const { facts, diagnostics } = extractFileFacts({
    path: file,
    contentHash: 'a'.repeat(40),
    module: moduleName,
    grammarVersion: moduleVersion,
    run,
  });
  assert.deepEqual(diagnostics, []);
  return { facts, run };
}

describe('toy module through extractFileFacts: definitions', () => {
  it('extracts main (function) and Widget (type) from basic.toy with the capture spans and validated FileFacts', async () => {
    const { facts, run } = await extractToy(fixture('basic.toy'), 'basic.toy');
    assert.deepEqual(validateFileFacts(facts), []);
    assert.deepEqual(
      facts.symbols.map((s) => [s.name, s.kind, s.qualifiedName, s.parent]),
      [
        ['main', 'function', 'main', undefined],
        ['Widget', 'type', 'Widget', undefined],
      ],
    );
    const definitionSpans = run.captures.filter((c) => c.name.startsWith('definition.')).map((c) => c.span);
    assert.deepEqual(
      facts.symbols.map((s) => s.span),
      definitionSpans,
    );
    assert.deepEqual(facts.parse, { errorBytes: run.errorBytes, totalBytes: run.totalBytes });
    assert.equal(facts.module, 'toy');
    assert.equal(facts.path, 'basic.toy');
  });

  it('nests a toy fn inside another fn: parent is the outer index and the qualified name is outer.inner', async () => {
    const { facts } = await extractToy('fn outer {\n  fn inner {\n  }\n}\n');
    assert.deepEqual(validateFileFacts(facts), []);
    assert.deepEqual(
      facts.symbols.map((s) => [s.name, s.qualifiedName, s.parent]),
      [
        ['outer', 'outer', undefined],
        ['inner', 'outer.inner', 0],
      ],
    );
  });
});

describe('toy module through extractFileFacts: imports, references and text policy', () => {
  it('extracts the use statement of basic.toy as an es import with the unquoted path and the statement span', async () => {
    const { facts } = await extractToy(fixture('basic.toy'), 'basic.toy');
    assert.deepEqual(facts.imports, [
      { path: 'lib/util', span: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 15 }, style: 'es' },
    ]);
    assert.deepEqual(facts.exports ?? [], []);
    // helper() is neither defined here, imported by name nor exported: the scope filter drops it.
    assert.deepEqual(facts.refSites, []);
  });

  it('keeps a call to a top-level definition with its enclosing symbol and drops a call to an unknown name', async () => {
    const { facts } = await extractToy('fn a {\n}\nfn b {\n  a();\n  zzz();\n}\n');
    assert.deepEqual(validateFileFacts(facts), []);
    assert.deepEqual(facts.refSites, [
      { name: 'a', span: { startLine: 3, startColumn: 2, endLine: 3, endColumn: 3 }, kind: 'call', enclosing: 1 },
    ]);
  });

  it('emoji.toy: the identifier is stored exactly and the columns are UTF-16 units, not UTF-8 byte offsets', async () => {
    const { facts, run } = await extractToy(fixture('emoji.toy'), 'emoji.toy');
    assert.deepEqual(validateFileFacts(facts), []);
    assert.equal(facts.symbols[0]?.name, 'héllo');
    assert.equal(facts.imports[0]?.path, 'a\u{1F600}b');
    const statement = 'use "a\u{1F600}b";';
    const endColumn = facts.imports[0]?.span.endColumn;
    assert.equal(endColumn, statement.length);
    assert.equal(endColumn, 11);
    assert.equal(Buffer.byteLength(statement, 'utf8'), 13, 'the same position is byte offset 13');
    assert.notEqual(endColumn, Buffer.byteLength(statement, 'utf8'));
    const engineSpan = run.captures.find((c) => c.name === 'import.es')?.span;
    assert.deepEqual(facts.imports[0]?.span, engineSpan);
  });

  it("bom.toy: the symbol's span equals the golden's definition span, with the BOM stripped", async () => {
    const { facts, run } = await extractToy(fixture('bom.toy'), 'bom.toy');
    assert.equal(run.hadBom, true);
    const golden = JSON.parse(fs.readFileSync(path.join(toyDir, 'fixtures', 'bom.toy.golden.json'), 'utf8')) as {
      captures: Array<{ name: string; startLine: number; startColumn: number; endLine: number; endColumn: number }>;
    };
    const definition = golden.captures.find((c) => c.name === 'definition.function');
    assert.ok(definition);
    assert.deepEqual(facts.symbols.map((s) => s.span), [
      {
        startLine: definition.startLine,
        startColumn: definition.startColumn,
        endLine: definition.endLine,
        endColumn: definition.endColumn,
      },
    ]);
    assert.equal(facts.symbols[0]?.span.startColumn, 0);
    assert.equal(facts.parse.totalBytes, Buffer.byteLength('fn a {\n}\n', 'utf8'));
  });

  it('crlf.toy: the same symbols, imports and references as its LF twin, with equal line numbers', async () => {
    const lf = await extractToy(fixture('basic.toy'), 'basic.toy');
    const crlf = await extractToy(fixture('crlf.toy'), 'basic.toy');
    assert.ok(fixture('crlf.toy').includes('\r\n'));
    assert.deepEqual(crlf.facts.symbols, lf.facts.symbols);
    assert.deepEqual(crlf.facts.imports, lf.facts.imports);
    assert.deepEqual(crlf.facts.refSites, lf.facts.refSites);
  });

  it('an empty file yields a valid FileFacts with empty arrays and parse.totalBytes 0', async () => {
    const { facts } = await extractToy('');
    assert.deepEqual(validateFileFacts(facts), []);
    assert.deepEqual([facts.symbols, facts.refSites, facts.imports], [[], [], []]);
    assert.deepEqual(facts.parse, { errorBytes: 0, totalBytes: 0 });
  });
});
