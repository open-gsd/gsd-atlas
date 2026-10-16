import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateCorpora } from './corpus.ts';

const GSD_CORE_SHA = '10ac3a7a947903ba50f538a907af036744d759d5';

function validEntry(): Record<string, unknown> {
  return {
    id: 'gsd-core',
    repo: 'open-gsd/gsd-core',
    ref: 'next',
    sha: GSD_CORE_SHA,
    status: 'pinned',
    role: 'primary validation corpus',
    pinnedAt: '2026-10-15',
  };
}

function manifestOf(...entries: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: 1, corpora: entries };
}

test('accepts a manifest with one fully pinned entry', () => {
  assert.deepEqual(validateCorpora(manifestOf(validEntry())), []);
});

// One row per behaviour bullet of FND-08: every mutation must yield at least one error.
const mutations: { name: string; build: () => unknown }[] = [
  {
    name: 'short sha',
    build: () => manifestOf({ ...validEntry(), sha: GSD_CORE_SHA.slice(0, 7) }),
  },
  {
    name: 'uppercase sha',
    build: () => manifestOf({ ...validEntry(), sha: GSD_CORE_SHA.toUpperCase() }),
  },
  {
    name: 'branch name as sha',
    build: () => manifestOf({ ...validEntry(), sha: 'next' }),
  },
  {
    name: 'null sha on a pinned entry',
    build: () => manifestOf({ ...validEntry(), sha: null }),
  },
  {
    name: 'empty string sha',
    build: () => manifestOf({ ...validEntry(), sha: '' }),
  },
  {
    name: 'sha with a non-hex character',
    build: () => manifestOf({ ...validEntry(), sha: `${GSD_CORE_SHA.slice(0, 39)}g` }),
  },
  {
    name: 'repo without a slash',
    build: () => manifestOf({ ...validEntry(), repo: 'gsd-core' }),
  },
  {
    name: 'empty ref on a pinned entry',
    build: () => manifestOf({ ...validEntry(), ref: '' }),
  },
  {
    name: 'empty role on a pinned entry',
    build: () => manifestOf({ ...validEntry(), role: '' }),
  },
  {
    name: 'duplicate id',
    build: () => manifestOf(validEntry(), validEntry()),
  },
  {
    name: 'unknown key',
    build: () => manifestOf({ ...validEntry(), branch: 'next' }),
  },
  {
    name: 'unknown top-level key',
    build: () => ({ ...manifestOf(validEntry()), extra: true }),
  },
  {
    name: 'schemaVersion 2',
    build: () => ({ schemaVersion: 2, corpora: [validEntry()] }),
  },
  {
    name: 'invalid id',
    build: () => manifestOf({ ...validEntry(), id: 'GSD Core' }),
  },
  {
    name: 'unknown status',
    build: () => manifestOf({ ...validEntry(), status: 'maybe' }),
  },
  {
    name: 'corpora not an array',
    build: () => ({ schemaVersion: 1, corpora: {} }),
  },
  {
    name: 'manifest not an object',
    build: () => [],
  },
];

for (const { name, build } of mutations) {
  test(`rejects ${name}`, () => {
    const errors = validateCorpora(build());
    assert.ok(errors.length >= 1, `expected at least one error for "${name}", got none`);
    for (const e of errors) assert.equal(typeof e, 'string');
  });
}

test('accepts a 64-hex sha for SHA-256 repositories', () => {
  const entry = { ...validEntry(), sha: 'a'.repeat(64) };
  assert.deepEqual(validateCorpora(manifestOf(entry)), []);
});

test('the committed corpora/corpora.json passes validation', () => {
  const url = new URL('../corpora/corpora.json', import.meta.url);
  const json: unknown = JSON.parse(readFileSync(url, 'utf8'));
  assert.deepEqual(validateCorpora(json), []);
});

interface CommittedEntry {
  id: string;
  repo: string | null;
  ref: string | null;
  sha: string | null;
  status: string;
  role: string;
  pinnedAt?: string;
  note?: string;
}

function readCommitted(): { schemaVersion: number; corpora: CommittedEntry[] } {
  const url = new URL('../corpora/corpora.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as { schemaVersion: number; corpora: CommittedEntry[] };
}

const EXPECTED_PINS: Record<string, { repo: string; ref: string; sha: string }> = {
  'gsd-core': { repo: 'open-gsd/gsd-core', ref: 'next', sha: GSD_CORE_SHA },
  'gsd-pi': { repo: 'open-gsd/gsd-pi', ref: 'main', sha: 'bb86b6ca2d3d047899092d845d574beeb5a21965' },
  'gsd-path': { repo: 'open-gsd/gsd-path', ref: 'main', sha: '73bf62e34f1adb8e9d86ae43378c8dd1200539bc' },
  'gsd-graph': { repo: 'open-gsd/gsd-graph', ref: 'main', sha: 'b105e4deb1fc3aaafba2cb65f4dfa6405597f799' },
};

test('the committed manifest has exactly five entries: four pinned and the unselected Swift app', () => {
  const { corpora } = readCommitted();
  assert.equal(corpora.length, 5);
  assert.deepEqual(corpora.map((c) => c.id).sort(), [
    'gsd-core',
    'gsd-graph',
    'gsd-path',
    'gsd-pi',
    'swift-reference-app',
  ]);
  assert.equal(corpora.filter((c) => c.status === 'pinned').length, 4);
  assert.equal(corpora.filter((c) => c.status === 'unselected').length, 1);
});

for (const [id, expected] of Object.entries(EXPECTED_PINS)) {
  test(`the committed manifest pins ${id} to the recorded sha`, () => {
    const entry = readCommitted().corpora.find((c) => c.id === id);
    assert.ok(entry, `${id} entry is missing`);
    assert.equal(entry.status, 'pinned');
    assert.equal(entry.repo, expected.repo);
    assert.equal(entry.ref, expected.ref);
    assert.equal(entry.sha, expected.sha);
    assert.ok(entry.role.trim() !== '', `${id} needs a role`);
    assert.equal(entry.pinnedAt, '2026-10-15');
  });
}

test('the Swift reference app is explicit but unselected, with no repo, ref or sha (SWF-05)', () => {
  const entry = readCommitted().corpora.find((c) => c.id === 'swift-reference-app');
  assert.ok(entry, 'swift-reference-app entry is missing');
  assert.equal(entry.status, 'unselected');
  assert.equal(entry.repo, null);
  assert.equal(entry.ref, null);
  assert.equal(entry.sha, null);
  assert.match(entry.note ?? '', /SWF-05/);
});

test('rejects an unselected entry that carries a sha', () => {
  const unselected = {
    id: 'swift-reference-app',
    repo: null,
    ref: null,
    sha: GSD_CORE_SHA,
    status: 'unselected',
    role: 'Swift reference app',
  };
  const errors = validateCorpora(manifestOf(unselected));
  assert.ok(errors.length >= 1);
  assert.ok(errors.some((e) => e.includes('sha')));
});

test('accepts an unselected entry with null repo, ref and sha', () => {
  const unselected = {
    id: 'swift-reference-app',
    repo: null,
    ref: null,
    sha: null,
    status: 'unselected',
    role: 'Swift reference app',
    note: 'chosen and pinned in Phase 5 (SWF-05)',
  };
  assert.deepEqual(validateCorpora(manifestOf(unselected)), []);
});

test('corpora/README.md documents SWF-05 and the re-measure warning', () => {
  const readme = readFileSync(new URL('../corpora/README.md', import.meta.url), 'utf8');
  assert.match(readme, /SWF-05/);
  assert.match(readme, /re-measure/i);
});
