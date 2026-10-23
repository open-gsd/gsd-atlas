import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOTSTRAP,
  averageRanks,
  bootstrapRatio,
  breakEven,
  componentCosts,
  fitPrices,
  mulberry32,
  olsLogLog,
  parsePilotRow,
  parseRegisteredRow,
  questionMeans,
  spearman,
  splitHalfPoints,
  weightedTokens,
  bootstrapRegression,
  type Session,
} from './lib.ts';

const session = (over: Partial<Session>): Session => ({
  dataset: 't',
  arm: 'G',
  questionId: 'q1',
  category: 'c',
  run: 1,
  input: 0,
  cacheCreation: 0,
  cacheRead: 0,
  output: 0,
  billable: 0,
  costUsd: 1,
  calls: 1,
  ...over,
});

describe('constants fixed before looking at the numbers', () => {
  it('uses 10,000 draws, seed 20261022 and a 90 percent percentile interval', () => {
    assert.deepEqual(BOOTSTRAP, { draws: 10_000, seed: 20261022, lowerIndex: 499, upperIndex: 9_499 });
  });
});

describe('mulberry32', () => {
  it('is the standard generator: deterministic, in [0,1), first output for seed 1', () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    assert.deepEqual(Array.from({ length: 50 }, () => a()), Array.from({ length: 50 }, () => b()));
    assert.equal(Math.round(mulberry32(1)() * 1e9), 627_073_941);
  });
});

describe('row parsers', () => {
  it('reads a pilot row, using the logged cost and the tool-call count as logged', () => {
    const s = parsePilotRow({
      condition: 'A-ts', questionId: 'p-1', category: 'heritage', run: 2, status: 'ok', billable: 33537,
      input: 8, cacheCreation: 5341, cacheRead: 27574, output: 614, toolCalls: 3, costUsd: 0.0302774,
    });
    assert.equal(s.arm, 'A-ts');
    assert.equal(s.calls, 3);
    assert.equal(s.costUsd, 0.0302774);
    assert.equal(s.billable, 8 + 5341 + 27574 + 614);
  });
  it('reads a registered row, mapping grep to G and atlas to A-reg and dropping the final StructuredOutput call', () => {
    const base = {
      questionId: 'q-1', category: 'adr', run: 1, status: 'ok', usage: { input: 8, output: 474, cacheCreation: 9524, cacheRead: 22134 },
      billableTokens: 32140, costUsd: 0.045, toolCalls: 4, toolCallsByName: { Bash: 3, StructuredOutput: 1 },
    };
    assert.equal(parseRegisteredRow({ ...base, arm: 'grep' }).arm, 'G');
    assert.equal(parseRegisteredRow({ ...base, arm: 'atlas' }).arm, 'A-reg');
    assert.equal(parseRegisteredRow({ ...base, arm: 'grep' }).calls, 3);
  });
  it('refuses a row with no logged cost rather than inventing one', () => {
    assert.throws(() => parsePilotRow({ condition: 'G', questionId: 'p', category: 'c', run: 1, status: 'ok', billable: 1, input: 0, cacheCreation: 0, cacheRead: 0, output: 1, toolCalls: 1 }), /costUsd/);
  });
});

describe('questionMeans', () => {
  it('averages the runs of one arm per question in id order', () => {
    const rows = [
      session({ questionId: 'b', costUsd: 2, run: 1 }), session({ questionId: 'b', costUsd: 4, run: 2 }),
      session({ questionId: 'a', costUsd: 10 }), session({ questionId: 'a', arm: 'A-reg', costUsd: 99 }),
    ];
    assert.deepEqual(questionMeans(rows, 'G', ['a', 'b'], (s) => s.costUsd), [10, 3]);
  });
  it('throws when a question has no session in the arm', () => {
    assert.throws(() => questionMeans([session({})], 'G', ['q1', 'zz'], (s) => s.costUsd), /zz/);
  });
});

describe('bootstrapRatio (paired by question)', () => {
  it('is deterministic and collapses to the ratio when every question has the same ratio', () => {
    const r = bootstrapRatio([5, 10, 15, 20], [10, 20, 30, 40]);
    assert.equal(r.r, 0.5);
    assert.ok(Math.abs(r.lo - 0.5) < 1e-12 && Math.abs(r.hi - 0.5) < 1e-12);
    assert.deepEqual(r, bootstrapRatio([5, 10, 15, 20], [10, 20, 30, 40]));
  });
  it('brackets the point estimate when the ratios differ, and stays paired (pairs move together)', () => {
    const r = bootstrapRatio([1, 9, 2, 8], [10, 10, 10, 10]);
    assert.equal(r.r, 0.5);
    assert.ok(r.lo < 0.5 && r.hi > 0.5);
    // perfectly proportional pairs with different sizes: pairing keeps every resample at exactly 2
    const p = bootstrapRatio([2, 40, 6], [1, 20, 3]);
    assert.ok(Math.abs(p.lo - 2) < 1e-12 && Math.abs(p.hi - 2) < 1e-12);
  });
  it('rejects unequal or empty inputs', () => {
    assert.throws(() => bootstrapRatio([1], [1, 2]));
    assert.throws(() => bootstrapRatio([], []));
  });
});

describe('prices recovered from the log, weights, component costs', () => {
  const price = { input: 2e-6, cacheCreation: 4e-6, cacheRead: 1e-7, output: 1e-5 };
  const rows = [
    { input: 8, cacheCreation: 5000, cacheRead: 27000, output: 600 },
    { input: 6, cacheCreation: 9000, cacheRead: 12000, output: 100 },
    { input: 10, cacheCreation: 100, cacheRead: 90000, output: 2000 },
    { input: 7, cacheCreation: 7000, cacheRead: 500, output: 300 },
    { input: 9, cacheCreation: 300, cacheRead: 40000, output: 5000 },
  ].map((t) => session({ ...t, costUsd: t.input * price.input + t.cacheCreation * price.cacheCreation + t.cacheRead * price.cacheRead + t.output * price.output }));
  it('recovers per-token prices from the logged cost by least squares and reports the largest residual', () => {
    const fit = fitPrices(rows);
    assert.ok(Math.abs(fit.output - 1e-5) < 1e-12);
    assert.ok(Math.abs(fit.cacheRead - 1e-7) < 1e-12);
    assert.ok(Math.abs(fit.cacheCreation - 4e-6) < 1e-12);
    assert.ok(fit.maxResidual < 1e-12);
  });
  it('splits the logged cost into its four components that sum back to it', () => {
    const c = componentCosts(rows, fitPrices(rows));
    const total = rows.reduce((a, r) => a + r.costUsd, 0);
    assert.ok(Math.abs(c.input + c.cacheCreation + c.cacheRead + c.output - total) < 1e-12);
    assert.ok(Math.abs(c.cacheRead - 1e-7 * (27000 + 12000 + 90000 + 500 + 40000)) < 1e-12);
  });
  it('weights tokens with input 1, cache creation 2, output 5 and a chosen cache-read weight', () => {
    const s = session({ input: 10, cacheCreation: 100, cacheRead: 1000, output: 20 });
    assert.equal(weightedTokens(s, 1), 10 + 200 + 1000 + 100);
    assert.equal(weightedTokens(s, 0.05), 10 + 200 + 50 + 100);
  });
});

describe('Spearman and the log-log fit', () => {
  it('gives tied values their average rank', () => {
    assert.deepEqual(averageRanks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  });
  it('is +1 / -1 for monotone data and handles ties', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2, 3, 4], [9, 7, 3, 1]), -1);
    assert.ok(Math.abs(spearman([1, 2, 2, 3], [1, 2, 3, 4]) - 0.9486832980505138) < 1e-12);
  });
  it('recovers slope and intercept of an exact power law', () => {
    const x = [1, 2, 4, 8];
    const y = x.map((v) => 3 * v ** -0.5);
    const f = olsLogLog(x, y);
    assert.ok(Math.abs(f.slope + 0.5) < 1e-12);
    assert.ok(Math.abs(f.intercept - Math.log(3)) < 1e-12);
  });
  it('finds where the fitted ratio crosses a target, or null when it never does', () => {
    const f = { intercept: Math.log(3), slope: -0.5 };
    assert.ok(Math.abs((breakEven(f, 1) as number) - 9) < 1e-9);
    assert.ok(Math.abs((breakEven(f, 1.5) as number) - 4) < 1e-9);
    assert.equal(breakEven({ intercept: 0, slope: 0.2 }, 1.5), null);
    assert.equal(breakEven({ intercept: 0, slope: 0 }, 1), null);
  });
});

describe('bootstrapRegression', () => {
  const points = Array.from({ length: 12 }, (_, i) => {
    const x = 1 + i;
    return { questionId: `q${i}`, category: 'c', x, ratio: 3 * x ** -0.5 * (1 + 0.02 * ((i * 7) % 5 - 2)) };
  });
  it('is reproducible, brackets the estimate and reports how many draws had a usable break-even', () => {
    const a = bootstrapRegression(points);
    assert.deepEqual(a, bootstrapRegression(points));
    assert.ok(a.spearman.est < -0.9 && a.spearman.hi <= -0.5);
    assert.ok(a.slope.lo < a.slope.est && a.slope.est < a.slope.hi);
    assert.ok(a.slope.hi < 0);
    assert.ok(a.breakEven1.est > 7 && a.breakEven1.est < 11);
    assert.equal(a.breakEven1.usableDraws, BOOTSTRAP.draws);
    assert.ok(a.breakEven15.est < a.breakEven1.est);
  });
});

describe('splitHalfPoints (the regression-to-the-mean check)', () => {
  it('takes x from one G run and the denominator from the other G runs, with A over all its runs', () => {
    const rows = [
      session({ questionId: 'a', run: 1, calls: 2, costUsd: 10 }),
      session({ questionId: 'a', run: 2, calls: 4, costUsd: 30 }),
      session({ questionId: 'a', arm: 'A-reg', run: 1, costUsd: 40 }),
      session({ questionId: 'a', arm: 'A-reg', run: 2, costUsd: 60 }),
    ];
    const [p1] = splitHalfPoints(rows, 'G', 'A-reg', ['a'], (s) => s.costUsd, 1);
    assert.equal(p1?.x, 2);
    assert.equal(p1?.ratio, 50 / 30);
    const [p2] = splitHalfPoints(rows, 'G', 'A-reg', ['a'], (s) => s.costUsd, 2);
    assert.equal(p2?.x, 4);
    assert.equal(p2?.ratio, 50 / 10);
  });
});
