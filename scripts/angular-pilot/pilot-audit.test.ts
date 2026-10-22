import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Row } from './pilot-analysis.ts';
import {
  keyEntries,
  normalizePath,
  rescoreRows,
  scenarioSummary,
  evidencePlan,
  instanceCounts,
  verdictCounts,
  validateVerdicts,
  type Keys,
  type NotExact,
  type VerdictEntry,
} from './pilot-audit-lib.ts';

const row = (over: Partial<Row>): Row => ({ jobId: 'j', condition: 'G', questionId: 'p-1', category: 'callers', run: 1, status: 'ok', billable: 100, atlasCalls: 0, exact: true, matched: 2, missing: 0, extra: 0, ...over });

describe('normalizePath', () => {
  it('adds the leading packages/ only when it is missing', () => {
    assert.equal(normalizePath('compiler/src/a.ts'), 'packages/compiler/src/a.ts');
    assert.equal(normalizePath('packages/compiler/src/a.ts'), 'packages/compiler/src/a.ts');
    assert.equal(normalizePath('./packages/x.ts'), 'packages/x.ts');
  });
});

describe('keyEntries', () => {
  const items = [{ file: 'packages/a.ts', line: 3, symbol: 'X' }, { file: 'packages/a.ts', line: 9, symbol: 'Y' }, { file: 'packages/a.ts', line: 9, symbol: 'Y' }];
  it('follows the granularity of the question', () => {
    assert.deepEqual(keyEntries({ granularity: 'file', items }), ['packages/a.ts']);
    assert.deepEqual(keyEntries({ granularity: 'file+symbol', items }), ['packages/a.ts#X', 'packages/a.ts#Y']);
    assert.deepEqual(keyEntries({ granularity: 'file+line', items }), ['packages/a.ts:3', 'packages/a.ts:9']);
  });
});

describe('rescoreRows', () => {
  const original: Keys = { 'p-1': ['packages/a.ts', 'packages/b.ts'], 'p-2': ['packages/c.ts'] };
  const rows = [
    row({ jobId: 'e1', questionId: 'p-1' }),
    row({ jobId: 'n1', questionId: 'p-1', exact: false, matched: 1, missing: 1, extra: 1 }),
    row({ jobId: 'n2', questionId: 'p-2', exact: false, matched: 0, missing: 1, extra: 1 }),
  ];
  const notExact: NotExact[] = [
    { jobId: 'n1', questionId: 'p-1', missingFiles: ['packages/b.ts'], extraFiles: ['packages/z.ts'] },
    { jobId: 'n2', questionId: 'p-2', missingFiles: ['packages/c.ts'], extraFiles: ['c.ts'] },
  ];

  it('reproduces the original scoring with the original keys and no normalisation', () => {
    const out = rescoreRows(rows, notExact, original, { keys: original, normalize: false });
    assert.deepEqual(out.map((r) => [r.exact, r.matched, r.missing, r.extra]), [[true, 2, 0, 0], [false, 1, 1, 1], [false, 0, 1, 1]]);
  });

  it('normalising a path-prefix session makes it exact', () => {
    const out = rescoreRows(rows, notExact, original, { keys: original, normalize: true });
    assert.deepEqual(out.map((r) => r.exact), [true, false, true]);
    assert.equal(out[2]!.matched, 1);
  });

  it('a corrected key that adds the extra file turns the session exact and an exact session into one with a missing file', () => {
    const corrected: Keys = { ...original, 'p-1': ['packages/a.ts', 'packages/b.ts', 'packages/z.ts'] };
    const out = rescoreRows(rows, notExact, original, { keys: corrected, normalize: false });
    assert.deepEqual(out.map((r) => [r.exact, r.matched, r.missing, r.extra]), [[false, 2, 1, 0], [false, 2, 1, 0], [false, 0, 1, 1]]);
  });

  it('leaves an unreadable answer (exact null) as it is', () => {
    const out = rescoreRows([row({ jobId: 'u', exact: null, matched: 0, missing: 0, extra: 0 })], [], original, { keys: original, normalize: true });
    assert.equal(out[0]!.exact, null);
  });

  it('fails when a not-exact row has no detail', () => {
    assert.throws(() => rescoreRows(rows, [], original, { keys: original, normalize: false }), /no detail/);
  });
});

describe('scenarioSummary', () => {
  const mk = (cond: 'G' | 'A-ts' | 'A-reg', q: string, billable: number, exact: boolean, atlasCalls = 0): Row => row({ jobId: `${cond}-${q}`, condition: cond, questionId: q, billable, exact, atlasCalls });
  const rows = [
    mk('G', 'p-1', 100, true), mk('G', 'p-2', 100, false),
    mk('A-ts', 'p-1', 200, true), mk('A-ts', 'p-2', 200, true),
    mk('A-reg', 'p-1', 300, true, 1), mk('A-reg', 'p-2', 300, true, 1),
  ];
  it('computes R, correctness and the class from the registered rules', () => {
    const s = scenarioSummary(rows, 0, 'passed');
    assert.equal(s.r['A-ts'], 2);
    assert.equal(s.r['A-reg'], 3);
    assert.deepEqual(s.correctness, { G: 0.5, 'A-ts': 1, 'A-reg': 1 });
    assert.equal(s.classification.class, 'stop and reconsider the token gate');
  });
});

describe('verdicts', () => {
  const v: VerdictEntry[] = [
    { questionId: 'p-1', file: 'packages/a.ts', side: 'extra', verdict: 'a', reason: 'depth three', evidence: 'oracle' },
    { questionId: 'p-1', file: 'packages/b.ts', side: 'missing', verdict: 'c', reason: 'genuine', evidence: 'oracle' },
  ];
  it('counts per verdict', () => {
    assert.deepEqual(verdictCounts(v), { a: 1, b: 0, c: 1, d: 0 });
  });
  it('requires a verdict for every missing and extra file of the not-exact sessions', () => {
    const ne: NotExact[] = [{ jobId: 'j', questionId: 'p-1', missingFiles: ['packages/b.ts'], extraFiles: ['packages/a.ts', 'packages/q.ts'] }];
    assert.deepEqual(validateVerdicts(v, ne), ['p-1 extra packages/q.ts has no verdict']);
    assert.deepEqual(validateVerdicts(v, ne.slice(0, 0)), []);
  });
  it('treats a prefix-less path as covered by the verdict of its prefixed file', () => {
    const ne: NotExact[] = [{ jobId: 'j', questionId: 'p-1', missingFiles: [], extraFiles: ['a.ts'] }];
    assert.deepEqual(validateVerdicts(v, ne), []);
  });
});

describe('path-format sessions', () => {
  const v: VerdictEntry[] = [{ questionId: 'p-1', file: 'packages/b.ts', side: 'missing', verdict: 'c', reason: 'genuine omission', evidence: 'oracle' }];
  // a session that answered 'a.ts' and 'x.ts' for the key a.ts, b.ts: both extras are the prefix-less key files, b is a real omission
  const ne: NotExact[] = [{ jobId: 'pf', questionId: 'p-1', missingFiles: ['packages/a.ts', 'packages/b.ts'], extraFiles: ['a.ts'] }];
  it('needs verdicts only for what is still missing after the prefix is restored', () => {
    assert.deepEqual(validateVerdicts([], ne, ['pf']), ['p-1 missing packages/b.ts has no verdict']);
    assert.deepEqual(validateVerdicts(v, ne, ['pf']), []);
  });
  it('counts the prefix instances as d and the residual by the file verdict', () => {
    assert.deepEqual(instanceCounts(v, ne, ['pf']), { a: 0, b: 0, c: 1, d: 2 });
  });
});

describe('evidencePlan', () => {
  it('lists each question and normalised file once, sorted', () => {
    const v: VerdictEntry[] = [
      { questionId: 'p-2', file: 'packages/z.ts', side: 'extra', verdict: 'a', reason: '', evidence: '' },
      { questionId: 'p-1', file: 'packages/b.ts', side: 'missing', verdict: 'c', reason: '', evidence: '' },
      { questionId: 'p-1', file: 'packages/b.ts', side: 'missing', verdict: 'c', reason: '', evidence: '' },
    ];
    assert.deepEqual(evidencePlan(v), [{ questionId: 'p-1', file: 'packages/b.ts' }, { questionId: 'p-2', file: 'packages/z.ts' }]);
  });
});

describe('the committed pilot data', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'docs', 'eval', 'angular-pilot', 'v2');
  const rows = fs.readFileSync(path.join(dir, 'pilot', 'pilot-sessions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Row);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'pilot', 'summary.json'), 'utf8')) as { notExact: NotExact[]; ratio: Record<string, { r: number }>; byCond: Record<string, { correctness: number; matched: number; missing: number; extra: number }>; classification: { class: string } };
  const answers = JSON.parse(fs.readFileSync(path.join(dir, 'pilot-answers.json'), 'utf8')) as { answers: { questionId: string; granularity: string; items: { file?: string; line?: number; symbol?: string }[] }[] };
  const keys: Keys = Object.fromEntries(answers.answers.map((a) => [a.questionId, keyEntries(a)]));

  it('rescoring with the original keys reproduces summary.json exactly', () => {
    const out = rescoreRows(rows, summary.notExact, keys, { keys, normalize: false });
    const s = scenarioSummary(out, 1);
    assert.equal(s.r['A-ts'], summary.ratio['A-ts']!.r);
    assert.equal(s.r['A-reg'], summary.ratio['A-reg']!.r);
    for (const c of ['G', 'A-ts', 'A-reg'] as const) {
      assert.equal(s.correctness[c], summary.byCond[c]!.correctness);
      assert.deepEqual([s.sums[c].matched, s.sums[c].missing, s.sums[c].extra], [summary.byCond[c]!.matched, summary.byCond[c]!.missing, summary.byCond[c]!.extra]);
    }
    assert.equal(s.classification.class, summary.classification.class);
  });

  it('normalisation turns exactly the two path-prefix sessions that were wrong only by the prefix into exact matches', () => {
    const out = rescoreRows(rows, summary.notExact, keys, { keys, normalize: true });
    const flipped = out.filter((r, i) => r.exact !== rows[i]!.exact).map((r) => r.jobId).sort();
    assert.deepEqual(flipped, ['ang-A-ts-p-305-r2', 'ang-G-p-307-r2']);
  });
});
