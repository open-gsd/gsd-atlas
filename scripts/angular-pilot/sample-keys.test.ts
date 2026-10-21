import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareKeyToGrep, parseSampleSpec } from './sample-keys.ts';

describe('compareKeyToGrep', () => {
  it('splits the files a whole-word search finds into key, mentioned-only and key-only', () => {
    const r = compareKeyToGrep(['a.ts', 'b.ts'], ['b.ts', 'c.ts', 'd.ts']);
    assert.deepEqual(r, { inBoth: ['b.ts'], keyOnly: ['a.ts'], grepOnly: ['c.ts', 'd.ts'] });
  });
});

describe('parseSampleSpec', () => {
  it('reads kind, name and the declaring file', () => {
    assert.deepEqual(parseSampleSpec('callers:findTightestNode@packages/x/y.ts'), { kind: 'callers', name: 'findTightestNode', file: 'packages/x/y.ts' });
  });
  it('rejects an unknown kind', () => {
    assert.throws(() => parseSampleSpec('emit:x@y.ts'), /kind/);
  });
});
