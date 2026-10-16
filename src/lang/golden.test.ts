import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Capture } from '../grammar-engine/index.ts';
import { GOLDEN_CONVENTION, compareGolden, renderGolden, serializeGolden } from './golden.ts';

const capture = (name: string, line: number, from: number, to: number, text: string): Capture => ({
  query: 'tags',
  name,
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
