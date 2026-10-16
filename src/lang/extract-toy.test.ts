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
