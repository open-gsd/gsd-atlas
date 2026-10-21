import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildQuestion, orderCandidates, pickFresh } from './questions.ts';
import type { Candidate } from './questions.ts';

const cand = (kind: 'callers' | 'references' | 'impact', symbol: string, definedIn: string, files = 5): Candidate =>
  ({ kind, symbol, definedIn, files }) as Candidate;

describe('buildQuestion', () => {
  it('states the counting rules of the v2 wording for callers', () => {
    const q = buildQuestion('pq-001', cand('callers', 'foo', 'src/a.cts'));
    assert.equal(q.category, 'callers');
    assert.match(q.text, /`foo`/);
    assert.match(q.text, /renamed import/);
    assert.match(q.text, /List each file once/);
    assert.match(q.text, /required JSON form/);
    assert.deepEqual(q.key, { kind: 'callers', symbol: 'foo', definedIn: 'src/a.cts', granularity: 'file', equality: 'exact-set' });
  });

  it('states that a string literal is not a use for references', () => {
    const q = buildQuestion('pq-002', cand('references', 'BAR', 'src/b.cts'));
    assert.match(q.text, /string literal that merely spells the name/);
    assert.equal(q.key.kind, 'references');
  });

  it('names depth two and the exclusion of the defining file for impact', () => {
    const q = buildQuestion('pq-003', cand('impact', 'baz', 'src/c.cts'));
    assert.match(q.text, /to depth two/);
    assert.match(q.text, /leave out `src\/c\.cts` itself/);
    assert.deepEqual(q.key, { kind: 'impact', symbol: 'baz', definedIn: 'src/c.cts', depth: 2, granularity: 'file', equality: 'exact-set' });
  });

  it('builds an emit path question and an emit consumers question', () => {
    const path = buildQuestion('pq-004', { kind: 'emit', source: 'src/d.cts', files: 1 });
    assert.deepEqual(path.key, { kind: 'emit', source: 'src/d.cts', granularity: 'file', equality: 'exact-set' });
    const consumers = buildQuestion('pq-005', { kind: 'emit-consumers', source: 'src/e.cts', files: 4 });
    assert.match(consumers.text, /import x = require/);
    assert.equal(consumers.category, 'emit');
    assert.equal(consumers.key.kind, 'emit-consumers');
  });
});

describe('pickFresh', () => {
  it('never returns a used symbol or source and respects the per-kind quota', () => {
    const pool: Candidate[] = [
      cand('callers', 'used', 'src/a.cts'),
      cand('callers', 'c1', 'src/a.cts'),
      cand('callers', 'c2', 'src/b.cts'),
      cand('references', 'r1', 'src/a.cts'),
      cand('impact', 'i1', 'src/z.cts'),
      { kind: 'emit', source: 'src/used.cts', files: 1 },
      { kind: 'emit', source: 'src/e1.cts', files: 1 },
    ];
    const picked = pickFresh(pool, new Set(['used', 'src/used.cts']), { callers: 2, references: 1, impact: 1, emit: 1 }, 7);
    assert.equal(picked.filter((c) => c.kind === 'callers').length, 2);
    assert.ok(!picked.some((c) => ('source' in c ? c.source === 'src/used.cts' : c.symbol === 'used')));
    assert.equal(picked.length, 5);
  });

  it('is deterministic for a seed and takes one candidate per symbol name', () => {
    const pool: Candidate[] = [cand('callers', 'same', 'src/a.cts'), cand('references', 'same', 'src/a.cts'), cand('callers', 'other', 'src/b.cts')];
    const one = pickFresh(pool, new Set(), { callers: 2, references: 1, impact: 0, emit: 0 }, 11);
    const two = pickFresh(pool, new Set(), { callers: 2, references: 1, impact: 0, emit: 0 }, 11);
    assert.deepEqual(one, two);
    const names = one.map((c) => ('source' in c ? c.source : c.symbol));
    assert.equal(new Set(names).size, names.length);
  });
});

describe('orderCandidates', () => {
  it('orders by a seeded hash, not by input order', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => cand('callers', s, 'src/x.cts'));
    const a = orderCandidates(pool, 1).map((c) => (c.kind === 'callers' ? c.symbol : ''));
    const b = orderCandidates([...pool].reverse(), 1).map((c) => (c.kind === 'callers' ? c.symbol : ''));
    assert.deepEqual(a, b);
  });
});
