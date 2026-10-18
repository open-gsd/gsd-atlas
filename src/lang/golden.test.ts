import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CitationSite } from '../facts/index.ts';
import { createGrammarEngine, extractFileFacts } from '../grammar-engine/index.ts';
import type { Capture } from '../grammar-engine/index.ts';
import { GOLDEN_CONVENTION, compareGolden, renderGolden, serializeGolden } from './golden.ts';
import { readModuleInputs } from './module-files.ts';

const capture = (name: string, line: number, from: number, to: number, text: string): Capture => ({
  query: 'tags',
  name,
  match: 0,
  span: { startLine: line, startColumn: from, endLine: line, endColumn: to },
  text,
});

const run = {
  hadBom: false,
  captures: [capture('definition.function', 1, 0, 20, 'fn main {\n}'), capture('name', 1, 3, 7, 'main')],
};

describe('renderGolden', () => {
  it('renders the documented shape with the fixed convention text', () => {
    const golden = renderGolden('basic.toy', run);
    assert.equal(golden.schema, 1);
    assert.equal(golden.fixture, 'basic.toy');
    assert.equal(golden.convention, '0-based line, 0-based UTF-16 column, end exclusive');
    assert.equal(golden.convention, GOLDEN_CONVENTION);
    assert.equal(golden.hadBom, false);
    assert.deepEqual(golden.captures[1], {
      query: 'tags',
      name: 'name',
      startLine: 1,
      startColumn: 3,
      endLine: 1,
      endColumn: 7,
      text: 'main',
    });
  });

  it('keeps the capture order the engine produced', () => {
    const golden = renderGolden('basic.toy', run);
    assert.deepEqual(
      golden.captures.map((c) => c.name),
      ['definition.function', 'name'],
    );
  });

  it('serialises as LF-terminated, two-space indented JSON that parses back to the same document', () => {
    const golden = renderGolden('basic.toy', run);
    const text = serializeGolden(golden);
    assert.ok(text.endsWith('}\n'));
    assert.ok(!text.includes('\r'));
    assert.deepEqual(JSON.parse(text), golden);
  });
});

describe('compareGolden', () => {
  it('returns null for equal documents, whether they come from JSON.parse or from renderGolden', () => {
    const actual = renderGolden('basic.toy', run);
    assert.equal(compareGolden(actual, actual), null);
    assert.equal(compareGolden(JSON.parse(serializeGolden(actual)), actual), null);
  });

  it('names the first differing capture and field with both values', () => {
    const actual = renderGolden('basic.toy', run);
    const expected = JSON.parse(serializeGolden(actual)) as { captures: Array<Record<string, unknown>> };
    expected.captures[1]!['endColumn'] = 8;
    assert.deepEqual(compareGolden(expected, actual), { index: 1, field: 'endColumn', expected: 8, actual: 7 });
  });

  it('reports the earliest of several differences', () => {
    const actual = renderGolden('basic.toy', run);
    const expected = JSON.parse(serializeGolden(actual)) as { captures: Array<Record<string, unknown>> };
    expected.captures[0]!['text'] = 'other';
    expected.captures[1]!['startColumn'] = 9;
    const difference = compareGolden(expected, actual);
    assert.equal(difference?.index, 0);
    assert.equal(difference?.field, 'text');
  });

  it('reports a header difference with index -1', () => {
    const actual = renderGolden('basic.toy', { ...run, hadBom: true });
    const expected = JSON.parse(serializeGolden(renderGolden('basic.toy', run)));
    assert.deepEqual(compareGolden(expected, actual), { index: -1, field: 'hadBom', expected: false, actual: true });
  });

  it('reports a missing capture and an extra capture at the index where the lists diverge', () => {
    const actual = renderGolden('basic.toy', run);
    const shorter = JSON.parse(serializeGolden(actual)) as { captures: unknown[] };
    shorter.captures.pop();
    const missing = compareGolden(shorter, actual);
    assert.equal(missing?.index, 1);
    assert.equal(missing?.field, 'capture');
    assert.equal(missing?.expected, 'absent');

    const longer = JSON.parse(serializeGolden(actual)) as { captures: unknown[] };
    longer.captures.push(longer.captures[0]);
    const extra = compareGolden(longer, actual);
    assert.equal(extra?.index, 2);
    assert.equal(extra?.field, 'capture');
    assert.equal(extra?.actual, 'absent');
  });

  it('treats a key the golden has and the run lacks as a difference', () => {
    const actual = renderGolden('basic.toy', run);
    const expected = JSON.parse(serializeGolden(actual)) as { captures: Array<Record<string, unknown>> };
    expected.captures[0]!['extra'] = true;
    const difference = compareGolden(expected, actual);
    assert.equal(difference?.index, 0);
    assert.equal(difference?.field, 'extra');
  });

  it('never throws on a document that is not an object', () => {
    const actual = renderGolden('basic.toy', run);
    for (const bad of [null, 3, 'x', [], { captures: 'no' }]) {
      const difference = compareGolden(bad, actual);
      assert.notEqual(difference, null);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// ADR citations of the built-in modules (plan 03-24): the `adr` fixture of each module through the real engine.

const MODULES = fileURLToPath(new URL('../../modules/', import.meta.url));

const at = (startLine: number, startColumn: number, endColumn: number) => ({
  startLine,
  startColumn,
  endLine: startLine,
  endColumn,
});

async function runFixture(moduleName: string, fixture: string) {
  const dir = path.join(MODULES, moduleName);
  const inputs = readModuleInputs(dir);
  assert.ok(inputs.ok, `the ${moduleName} module is readable`);
  const text = fs.readFileSync(path.join(dir, 'fixtures', fixture), 'utf8');
  const engine = createGrammarEngine();
  try {
    const grammar = await engine.load(inputs.input);
    const result = await grammar.run(text);
    const { facts, diagnostics } = extractFileFacts({
      path: `fixtures/${fixture}`,
      contentHash: 'c'.repeat(40),
      module: moduleName,
      grammarVersion: 'test',
      run: result,
    });
    return { dir, result, facts, diagnostics };
  } finally {
    await engine.dispose();
  }
}

/** The numbers the `adr` fixtures hold in comments, with their exact spans (0-based line, UTF-16 column). */
function expectedCitations(lines: {
  readonly header: number;
  readonly jsdoc: number;
  readonly block: number;
  readonly trailing: number;
  readonly pair: number;
  readonly history: number;
  readonly headerColumn: number;
}): CitationSite[] {
  return [
    { number: 2143, detail: '§3', span: at(lines.header, lines.headerColumn, lines.headerColumn + 11) },
    { number: 3473, span: at(lines.jsdoc, 23, 32), enclosing: 0 },
    { number: 1, span: at(lines.block, 5, 13), enclosing: 0 },
    { number: 12, span: at(lines.trailing, 26, 32), enclosing: 0 },
    { number: 7, span: at(lines.pair, 3, 8), enclosing: 1 },
    { number: 8, span: at(lines.pair, 13, 18), enclosing: 1 },
    { number: 5057, span: at(lines.history, 3, 11) },
  ];
}

describe('ADR citations of the built-in modules', () => {
  it('typescript adr fixture: the citations golden, strings and templates excluded, attachments by the two rules', async () => {
    const { dir, result, facts, diagnostics } = await runFixture('typescript', 'adr.ts');
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      facts.citations,
      expectedCitations({ header: 0, headerColumn: 20, jsdoc: 3, block: 7, trailing: 9, pair: 13, history: 17 }),
    );
    assert.deepEqual(
      facts.symbols.map((s) => s.name),
      ['load', 'note', 'memo'],
    );
    const golden = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'adr.ts.golden.json'), 'utf8')) as unknown;
    assert.equal(compareGolden(golden, renderGolden('adr.ts', result)), null);
  });

  it('javascript adr fixture: the same eight cases in CommonJS style give the same kinds of citations', async () => {
    const { dir, result, facts, diagnostics } = await runFixture('javascript', 'adr.cjs');
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      facts.citations,
      expectedCitations({ header: 0, headerColumn: 40, jsdoc: 4, block: 8, trailing: 10, pair: 14, history: 18 }),
    );
    assert.deepEqual(
      facts.symbols.map((s) => s.name),
      ['load', 'note', 'memo'],
    );
    const golden = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'adr.cjs.golden.json'), 'utf8')) as unknown;
    assert.equal(compareGolden(golden, renderGolden('adr.cjs', result)), null);
  });
});
