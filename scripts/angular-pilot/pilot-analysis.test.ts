import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOTSTRAP,
  adoptionOf,
  bootstrapRatio,
  calledVsMatchedG,
  classify,
  correctnessOf,
  mulberry32,
  premiseOf,
  questionMeans,
  type ClassInput,
  type Row,
} from './pilot-analysis.ts';

const row = (over: Partial<Row>): Row => ({ jobId: 'j', condition: 'G', questionId: 'p-301', category: 'callers', run: 1, status: 'ok', billable: 100, atlasCalls: 0, exact: true, matched: 1, missing: 0, extra: 0, ...over });

describe('constants pre-declared in pilot-run-plan.md', () => {
  it('has 10,000 draws, seed 20261021 and a 90 percent interval', () => {
    assert.deepEqual(BOOTSTRAP, { draws: 10_000, seed: 20261021, lowerIndex: 499, upperIndex: 9_499 });
  });
});

describe('mulberry32', () => {
  it('is deterministic and uniform in [0,1)', () => {
    const a = mulberry32(20261021);
    const b = mulberry32(20261021);
    const xs = Array.from({ length: 1000 }, () => a());
    assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    // first output of the standard mulberry32 for seed 1 (0.6270739405881613)
    const c = mulberry32(1);
    assert.equal(Math.round(c() * 1e9), 627_073_941);
  });
});

describe('questionMeans', () => {
  it('averages the runs of a question and keeps question order', () => {
    const rows = [row({ questionId: 'p-302', billable: 10, run: 1 }), row({ questionId: 'p-302', billable: 30, run: 2 }), row({ questionId: 'p-301', billable: 4, run: 1 }), row({ questionId: 'p-301', billable: 6, run: 2 })];
    assert.deepEqual(questionMeans(rows, 'G', ['p-301', 'p-302']), [5, 20]);
  });
  it('throws when a question has no session in the condition', () => {
    assert.throws(() => questionMeans([row({})], 'G', ['p-301', 'p-999']), /p-999/);
  });
});

describe('bootstrapRatio', () => {
  it('is the ratio of means with a percentile interval that is reproducible', () => {
    const g = [10, 20, 30, 40];
    const a = [5, 10, 15, 20];
    const r1 = bootstrapRatio(a, g);
    const r2 = bootstrapRatio(a, g);
    assert.equal(r1.r, 0.5);
    assert.deepEqual(r1, r2);
    // every question has the same ratio, so every resample has it
    assert.ok(Math.abs(r1.lo - 0.5) < 1e-12 && Math.abs(r1.hi - 0.5) < 1e-12);
  });
  it('widens when ratios differ across questions', () => {
    const r = bootstrapRatio([1, 9, 2, 8], [10, 10, 10, 10]);
    assert.equal(r.r, 0.5);
    assert.ok(r.lo < 0.5 && r.hi > 0.5);
  });
});

describe('correctness and adoption', () => {
  it('counts exact-set sessions and sessions with an atlas call', () => {
    const rows = [row({ exact: true }), row({ exact: false, atlasCalls: 2 }), row({ exact: null, atlasCalls: 0 }), row({ exact: true, atlasCalls: 1 })];
    assert.equal(correctnessOf(rows), 0.5);
    assert.equal(adoptionOf(rows), 0.5);
  });
});

describe('premiseOf', () => {
  it('passes at 68,000, fails below 55,000, judgement in between', () => {
    assert.equal(premiseOf(68_000), 'passed');
    assert.equal(premiseOf(67_999), 'between');
    assert.equal(premiseOf(55_000), 'between');
    assert.equal(premiseOf(54_999), 'failed');
  });
});

describe('calledVsMatchedG', () => {
  it('compares atlas sessions that made a call with the G mean of the same questions, per session', () => {
    const rows = [
      row({ condition: 'G', questionId: 'p-301', billable: 100, run: 1 }),
      row({ condition: 'G', questionId: 'p-301', billable: 300, run: 2 }),
      row({ condition: 'G', questionId: 'p-302', billable: 1000, run: 1 }),
      row({ condition: 'G', questionId: 'p-302', billable: 1000, run: 2 }),
      row({ condition: 'A-ts', questionId: 'p-301', billable: 250, atlasCalls: 3 }),
      row({ condition: 'A-reg', questionId: 'p-302', billable: 900, atlasCalls: 1 }),
      row({ condition: 'A-reg', questionId: 'p-302', billable: 5000, atlasCalls: 0, run: 2 }),
    ];
    const c = calledVsMatchedG(rows);
    assert.ok(c !== null);
    assert.equal(c.n, 2);
    assert.equal(c.calledMean, 575);
    assert.equal(c.matchedGMean, 600);
    assert.equal(c.atLeastAsMuch, false);
    assert.equal(calledVsMatchedG(rows.filter((r) => r.atlasCalls === 0)), null);
  });
});

describe('classify', () => {
  const base: ClassInput = {
    premise: 'passed',
    r: { 'A-ts': 0.8, 'A-reg': 1.2 },
    correctness: { G: 0.6, 'A-ts': 0.55, 'A-reg': 0.6 },
    adoption: { 'A-ts': 0.6, 'A-reg': 0.7 },
    calledVsG: { atLeastAsMuch: false },
    keysChanged: 1,
  };
  it('is "worth" when one A condition meets all four tests together', () => {
    assert.equal(classify(base).class, 'worth a registered run');
  });
  it('does not mix tests across conditions', () => {
    // A-ts has R, A-reg has adoption, neither has both
    const r = classify({ ...base, adoption: { 'A-ts': 0.4, 'A-reg': 0.9 } });
    assert.equal(r.class, 'inconclusive');
  });
  it('needs correctness within 0.10 of G for the same condition', () => {
    assert.equal(classify({ ...base, correctness: { G: 0.7, 'A-ts': 0.59, 'A-reg': 0.7 } }).class, 'inconclusive');
    assert.equal(classify({ ...base, correctness: { G: 0.7, 'A-ts': 0.6, 'A-reg': 0.7 } }).class, 'worth a registered run');
  });
  it('is "stop" when both R are 1.10 or more with the premise passed', () => {
    const r = classify({ ...base, r: { 'A-ts': 1.1, 'A-reg': 1.3 } });
    assert.equal(r.class, 'stop and reconsider the token gate');
  });
  it('is "stop" when atlas sessions with a call cost at least as much as matched G, premise or not', () => {
    const r = classify({ ...base, premise: 'failed', r: { 'A-ts': 0.9, 'A-reg': 0.9 }, calledVsG: { atLeastAsMuch: true } });
    assert.equal(r.class, 'stop and reconsider the token gate');
  });
  it('is inconclusive in the middle band, with low adoption, low correctness or more than 3 changed keys', () => {
    const mid = classify({ ...base, r: { 'A-ts': 0.95, 'A-reg': 1.05 } });
    assert.equal(mid.class, 'inconclusive');
    assert.ok(mid.flags.includes('R between 0.85 and 1.10'));
    assert.ok(classify({ ...base, r: { 'A-ts': 0.95, 'A-reg': 1.05 }, adoption: { 'A-ts': 0.1, 'A-reg': 0.3 } }).flags.includes('adoption below 20%'));
    assert.ok(classify({ ...base, r: { 'A-ts': 0.95, 'A-reg': 1.05 }, correctness: { G: 0.4, 'A-ts': 0.6, 'A-reg': 0.6 } }).flags.includes('correctness below 50%'));
    assert.ok(classify({ ...base, r: { 'A-ts': 0.95, 'A-reg': 1.05 }, keysChanged: 4 }).flags.includes('more than 3 of 16 keys changed'));
  });
  it('worth is impossible when the premise did not pass; between reports both readings', () => {
    assert.equal(classify({ ...base, premise: 'failed' }).class, 'inconclusive');
    const b = classify({ ...base, premise: 'between' });
    assert.equal(b.ifPremisePassed, 'worth a registered run');
    assert.equal(b.ifPremiseNotPassed, 'inconclusive');
    assert.equal(b.class, 'judgement');
  });
  it('lists the plan order: worth wins over stop when both hold, and the stop flag is still reported', () => {
    const r = classify({ ...base, calledVsG: { atLeastAsMuch: true } });
    assert.equal(r.class, 'worth a registered run');
    assert.ok(r.flags.includes('stop clause 2 also holds'));
  });
});
