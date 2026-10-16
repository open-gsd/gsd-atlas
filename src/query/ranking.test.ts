import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { compareRanked, cwdHintDir, directoryDistance, nameAndTier, sortKeyOf, tierOf } from './ranking.ts';
import type { RankInput, SortKey } from './ranking.ts';

const base: RankInput = {
  tier: 0,
  isReference: false,
  confidence: 'EXTRACTED',
  exported: true,
  distance: 0,
  path: 'src/a.ts',
  line: 10,
  col: 5,
  handle: 'h1',
};

const keyOf = (overrides: Partial<RankInput>): SortKey => sortKeyOf({ ...base, ...overrides });

/** True when `first` sorts strictly before `second`. */
const before = (first: SortKey, second: SortKey): boolean => compareRanked(first, second) < 0;

describe('tiers: how a name matches the query', () => {
  it('exact tier: the same characters', () => {
    assert.equal(tierOf('config', 'config'), 0);
  });

  it('case-insensitive exact tier: the same letters in another case', () => {
    assert.equal(tierOf('Config', 'config'), 1);
    assert.equal(tierOf('CONFIG', 'config'), 1);
  });

  it('prefix tier: the name starts with the query, in any case', () => {
    assert.equal(tierOf('configure', 'config'), 2);
    assert.equal(tierOf('ConfigLoader', 'config'), 2);
  });

  it('substring tier: the query is inside the name', () => {
    assert.equal(tierOf('loadConfig', 'config'), 3);
  });

  it('no tier when the query is not in the name', () => {
    assert.equal(tierOf('other', 'config'), null);
  });

  it('simple lower-casing handles non-ASCII letters on both sides', () => {
    assert.equal(tierOf('ÉCOLE', 'école'), 1);
  });
});

describe('nameAndTier: the symbol name behind a qualified name', () => {
  it('a name found by the exact read is the query and sits in the exact tier', () => {
    assert.deepEqual(nameAndTier('Job.run', 'run', true), { name: 'run', tier: 0 });
    assert.deepEqual(nameAndTier('module.exports', 'module.exports', true), { name: 'module.exports', tier: 0 });
  });

  it('otherwise the last segment of the qualified name is the name, and the tier cannot be exact', () => {
    assert.deepEqual(nameAndTier('Job.runAll', 'run', false), { name: 'runAll', tier: 2 });
    assert.deepEqual(nameAndTier('Job.Run', 'run', false), { name: 'Run', tier: 1 });
    assert.deepEqual(nameAndTier('loadConfig', 'config', false), { name: 'loadConfig', tier: 3 });
  });

  it('a name that matches no tier is still returned, in the substring tier', () => {
    assert.deepEqual(nameAndTier('unrelated', 'zzz', false), { name: 'unrelated', tier: 3 });
  });
});

describe('sort key: the order inside a result list', () => {
  it('the four tiers order exact, case-insensitive exact, prefix, substring', () => {
    const keys = [3, 1, 0, 2].map((tier) => keyOf({ tier: tier as 0 | 1 | 2 | 3, handle: `h${String(tier)}` }));
    const sorted = [...keys].sort(compareRanked);
    assert.deepEqual(
      sorted.map((key) => key[0]),
      [0, 1, 2, 3],
    );
  });

  it('a tier outranks everything after it in the key', () => {
    assert.ok(before(keyOf({ tier: 0, isReference: true, exported: false, confidence: 'INFERRED', distance: 9 }), keyOf({ tier: 1 })));
  });

  it('definitions come before references inside a tier', () => {
    assert.ok(before(keyOf({ isReference: false }), keyOf({ isReference: true })));
  });

  it('EXTRACTED comes before INFERRED', () => {
    assert.ok(before(keyOf({ confidence: 'EXTRACTED' }), keyOf({ confidence: 'INFERRED' })));
  });

  it('exported comes before local', () => {
    assert.ok(before(keyOf({ exported: true }), keyOf({ exported: false })));
  });

  it('a nearer directory comes first', () => {
    assert.ok(before(keyOf({ distance: 1 }), keyOf({ distance: 3 })));
  });

  it('then path, line, column and handle in code-unit order', () => {
    assert.ok(before(keyOf({ path: 'a/z.ts' }), keyOf({ path: 'b/a.ts' })));
    assert.ok(before(keyOf({ path: 'B.ts' }), keyOf({ path: 'a.ts' })), 'upper case sorts before lower case');
    assert.ok(before(keyOf({ line: 9 }), keyOf({ line: 10 })), 'numbers compare as numbers, not text');
    assert.ok(before(keyOf({ col: 4 }), keyOf({ col: 12 })));
    assert.ok(before(keyOf({ handle: 'h1' }), keyOf({ handle: 'h2' })));
  });

  it('there is no usage-count boost: two otherwise equal results differ only by position and handle', () => {
    assert.equal(keyOf({}).length, 9);
    assert.equal(compareRanked(keyOf({}), keyOf({})), 0);
  });
});

/** A small seeded generator (mulberry32), so the shuffles below are the same on every run. */
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

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const held = out[i] as T;
    out[i] = out[j] as T;
    out[j] = held;
  }
  return out;
}

describe('total order', () => {
  it('200 generated results always sort to the same sequence however they arrive', () => {
    const random = seeded(2026);
    const generated: SortKey[] = [];
    for (let i = 0; i < 200; i += 1) {
      generated.push(
        keyOf({
          tier: Math.floor(random() * 4) as 0 | 1 | 2 | 3,
          isReference: random() < 0.3,
          confidence: random() < 0.5 ? 'EXTRACTED' : 'INFERRED',
          exported: random() < 0.5,
          distance: Math.floor(random() * 4),
          path: `src/${String(Math.floor(random() * 6))}/f${String(Math.floor(random() * 5))}.ts`,
          line: Math.floor(random() * 20),
          col: Math.floor(random() * 10),
          handle: `h${String(i)}`,
        }),
      );
    }
    const expected = [...generated].sort(compareRanked);
    for (let round = 0; round < 10; round += 1) {
      const sorted = shuffled(generated, seeded(round + 1)).sort(compareRanked);
      assert.deepEqual(sorted, expected, `shuffle ${String(round)}`);
    }
  });

  it('the comparator is antisymmetric and sorts distinct keys strictly', () => {
    const a = keyOf({ handle: 'a' });
    const b = keyOf({ handle: 'b' });
    assert.equal(Math.sign(compareRanked(a, b)), -Math.sign(compareRanked(b, a)));
    assert.notEqual(compareRanked(a, b), 0);
  });
});

describe('directory distance to the cwd hint', () => {
  it('counts the path segments between the two directories', () => {
    assert.equal(directoryDistance('src/a', 'src/a'), 0);
    assert.equal(directoryDistance('src/a', 'src/b'), 2);
    assert.equal(directoryDistance('src/a/deep', 'src'), 2);
    assert.equal(directoryDistance('', 'src/a'), 2);
    assert.equal(directoryDistance('src', ''), 1);
  });

  it('no hint means every file is at distance 0', () => {
    assert.equal(directoryDistance('src/a', null), 0);
    assert.equal(directoryDistance('', null), 0);
  });
});

describe('cwdHintDir: the hint as a repo-relative directory', () => {
  const root = path.resolve(path.sep, 'work', 'repo');

  it('turns an absolute directory inside the worktree into a POSIX relative one', () => {
    assert.equal(cwdHintDir(root, path.join(root, 'src', 'b')), 'src/b');
    assert.equal(cwdHintDir(root, root), '');
  });

  it('accepts a relative directory as already repo-relative', () => {
    assert.equal(cwdHintDir(root, 'src/b'), 'src/b');
  });

  it('ignores a hint outside the worktree, a hint that climbs out of it, and no hint', () => {
    assert.equal(cwdHintDir(root, path.resolve(path.sep, 'elsewhere')), null);
    assert.equal(cwdHintDir(root, '../elsewhere'), null);
    assert.equal(cwdHintDir(root, undefined), null);
  });
});
