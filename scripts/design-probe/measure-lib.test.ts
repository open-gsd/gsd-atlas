import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateTokens, extractFiles, fileSetOfKey, scoreSets, utf8Bytes } from './measure-lib.ts';

describe('estimateTokens', () => {
  it('is bytes divided by four, rounded up', () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(4), 1);
    assert.equal(estimateTokens(5), 2);
    assert.equal(estimateTokens(1000), 250);
  });
});

describe('utf8Bytes', () => {
  it('counts bytes, not code units', () => {
    assert.equal(utf8Bytes('abc'), 3);
    assert.equal(utf8Bytes('é'), 2);
    assert.equal(utf8Bytes('\u{1F600}'), 4);
  });
});

describe('extractFiles', () => {
  it('finds repo-relative .ts paths under the prefix, once each, sorted', () => {
    const text = 'x packages/core/src/a.ts:12 and "packages/core/src/a.ts" and packages/forms/b.spec.ts; other/c.ts';
    assert.deepEqual(extractFiles(text, 'packages/'), ['packages/core/src/a.ts', 'packages/forms/b.spec.ts']);
  });
  it('strips a checkout root prefix', () => {
    const text = '/tmp/co/packages/core/src/a.ts#L3';
    assert.deepEqual(extractFiles(text, 'packages/', '/tmp/co/'), ['packages/core/src/a.ts']);
  });
  it('ignores .d.ts files', () => {
    assert.deepEqual(extractFiles('packages/core/x.d.ts packages/core/y.ts', 'packages/'), ['packages/core/y.ts']);
  });
});

describe('fileSetOfKey', () => {
  it('collapses items to files for file granularity', () => {
    const items = [{ file: 'a.ts', line: 1, symbol: 'f' }, { file: 'a.ts', line: 9, symbol: 'g' }, { file: 'b.ts', line: 2, symbol: 'h' }];
    assert.deepEqual([...fileSetOfKey(items, 'file')].sort(), ['a.ts', 'b.ts']);
  });
  it('keeps file and symbol for file+symbol granularity', () => {
    const items = [{ file: 'a.ts', line: 1, symbol: 'f' }, { file: 'a.ts', line: 9, symbol: 'f' }];
    assert.deepEqual([...fileSetOfKey(items, 'file+symbol')], ['a.ts#f']);
  });
});

describe('scoreSets', () => {
  it('counts matched, missing and extra, and exact equality', () => {
    const s = scoreSets(new Set(['a', 'b', 'x']), new Set(['a', 'b', 'c']));
    assert.deepEqual({ m: s.matched, mi: s.missing, e: s.extra, x: s.exact }, { m: 2, mi: 1, e: 1, x: false });
    assert.equal(scoreSets(new Set(['a']), new Set(['a'])).exact, true);
  });
  it('reports recall, with an empty key counting as full recall', () => {
    assert.equal(scoreSets(new Set(['a']), new Set(['a', 'b'])).recall, 0.5);
    assert.equal(scoreSets(new Set(), new Set()).recall, 1);
  });
});
