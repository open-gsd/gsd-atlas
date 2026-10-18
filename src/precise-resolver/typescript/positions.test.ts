import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lineStarts, offsetOf, positionOf, stripBom } from './positions.ts';

/** A small seeded generator (mulberry32), so the property case is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('positions (the grammar tier line model, never the compiler line map)', () => {
  it('lineStarts counts LF only: CRLF gives [0, 3, 5] for "a\\r\\nb\\n"', () => {
    assert.deepEqual(lineStarts('a\r\nb\n'), [0, 3, 5]);
  });

  it('a leading BOM is stripped before counting', () => {
    assert.equal(stripBom('﻿abc'), 'abc');
    assert.equal(stripBom('abc'), 'abc');
    assert.deepEqual(lineStarts('﻿a\nb'), lineStarts('a\nb'));
    assert.deepEqual(lineStarts('﻿a\nb'), [0, 2]);
  });

  it('offsetOf(starts, 1, 0) is the start of the second row', () => {
    const starts = lineStarts('a\r\nb\n');
    assert.equal(offsetOf(starts, 1, 0), 3);
    assert.equal(offsetOf(starts, 0, 0), 0);
    assert.equal(offsetOf(starts, 2, 0), 5);
  });

  it('a column counts UTF-16 code units, so an emoji before the column is two units', () => {
    const text = 'const x = "\u{1F600}"; compute(1);\n';
    const starts = lineStarts(text);
    const col = text.indexOf('compute');
    assert.equal(col, 'const x = "\u{1F600}"; '.length);
    assert.equal(text.slice(offsetOf(starts, 0, col), (offsetOf(starts, 0, col) as number) + 7), 'compute');
    // The code-point count would be one lower: that is the bug the unit rule prevents.
    assert.notEqual([...text.slice(0, col)].length, col);
  });

  it('U+2028, U+2029, U+0085 and a lone CR do not start a new row', () => {
    const text = 'a b c\u0085d\re\nf';
    assert.deepEqual(lineStarts(text), [0, text.indexOf('f')]);
  });

  it('a row that does not exist and a column past the end of the row give undefined', () => {
    const starts = lineStarts('ab\ncd');
    assert.equal(offsetOf(starts, 5, 0), undefined);
    assert.equal(offsetOf(starts, 0, 3), undefined);
    assert.equal(offsetOf(starts, 0, 2), 2);
    assert.equal(offsetOf(starts, -1, 0), undefined);
    assert.equal(offsetOf(starts, 0, -1), undefined);
    assert.equal(offsetOf(starts, 0.5, 0), undefined);
    assert.equal(offsetOf(starts, 1, 1), 4);
  });

  it('positionOf inverts offsetOf for every offset of a mixed-ending sample, and for 200 seeded random positions', () => {
    const pieces = ['alpha', ' ', '\n', '\r\n', '\u{1F600}', ' ', 'beta()', '\t', '\r', 'γ'];
    const next = seeded(20261018);
    let text = '';
    for (let i = 0; i < 400; i += 1) text += pieces[Math.floor(next() * pieces.length)] as string;
    const starts = lineStarts(text);
    for (let offset = 0; offset < text.length; offset += 1) {
      const { row, col } = positionOf(starts, offset);
      assert.equal(offsetOf(starts, row, col), offset, `offset ${String(offset)}`);
    }
    for (let i = 0; i < 200; i += 1) {
      const row = Math.floor(next() * starts.length);
      const end = (starts[row + 1] ?? text.length + 1) - 1;
      const width = Math.max(0, end - (starts[row] as number));
      const col = Math.floor(next() * (width + 1));
      const offset = offsetOf(starts, row, col);
      assert.notEqual(offset, undefined, `row ${String(row)} col ${String(col)}`);
      assert.deepEqual(positionOf(starts, offset as number), { row, col });
    }
  });
});
