import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ambiguousNames, isPilotSource, supplyByCategory } from './census.ts';

const d = (name: string, file: string, kind: 'class' | 'function' | 'const' | 'interface' | 'type' | 'enum' = 'function') => ({ name, kind, file, line: 1 });

describe('isPilotSource', () => {
  it('keeps packages non-test sources and drops specs, test dirs, schematics, d.ts and examples', () => {
    assert.equal(isPilotSource('packages/core/src/x.ts'), true);
    assert.equal(isPilotSource('packages/core/testing/src/x.ts'), true);
    assert.equal(isPilotSource('packages/core/test/x.ts'), false);
    assert.equal(isPilotSource('packages/core/src/x.spec.ts'), false);
    assert.equal(isPilotSource('packages/core/schematics/x.ts'), false);
    assert.equal(isPilotSource('packages/core/src/x.d.ts'), false);
    assert.equal(isPilotSource('packages/examples/core/x.ts'), false);
    assert.equal(isPilotSource('adev/src/x.ts'), false);
  });
});

describe('ambiguousNames', () => {
  it('keeps names declared in at least two distinct files, with the files sorted', () => {
    const out = ambiguousNames([d('a', 'p/2.ts'), d('a', 'p/1.ts'), d('a', 'p/1.ts'), d('b', 'p/1.ts'), d('c', 'p/3.ts'), d('c', 'p/4.ts', 'class')]);
    assert.deepEqual(
      out.map((r) => [r.name, r.files, r.kinds]),
      [
        ['a', ['p/1.ts', 'p/2.ts'], ['function']],
        ['c', ['p/3.ts', 'p/4.ts'], ['class', 'function']],
      ],
    );
  });
});

describe('supplyByCategory', () => {
  it('counts, per category, the ambiguous names whose grep file count is inside the answerable window', () => {
    const rows = [
      { name: 'f', files: ['a', 'b'], kinds: ['function'], grepFiles: 30, callSiteFiles: 5, subtypeCount: 0 },
      { name: 'K', files: ['a', 'b'], kinds: ['class'], grepFiles: 12, callSiteFiles: 0, subtypeCount: 3 },
      { name: 'g', files: ['a', 'b'], kinds: ['function'], grepFiles: 400, callSiteFiles: 9, subtypeCount: 0 },
    ];
    const s = supplyByCategory(rows, { minGrepFiles: 10, maxGrepFiles: 150, minKey: 2, maxKey: 40 });
    assert.deepEqual(s, { callers: 1, references: 2, heritage: 1, definition: 2 });
  });
});
