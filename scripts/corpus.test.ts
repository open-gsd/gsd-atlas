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

test('the committed manifest pins gsd-core to the recorded sha', () => {
  const url = new URL('../corpora/corpora.json', import.meta.url);
  const json = JSON.parse(readFileSync(url, 'utf8')) as {
    corpora: { id: string; sha: string | null; status: string }[];
  };
  const core = json.corpora.find((c) => c.id === 'gsd-core');
  assert.ok(core, 'gsd-core entry is missing');
  assert.equal(core.status, 'pinned');
  assert.equal(core.sha, GSD_CORE_SHA);
});
