import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapDistribution, mean, mulberry32, pairedClusterBootstrap, percentile, wilsonInterval } from './stats.ts';

/** The published mulberry32 recurrence, written out a second time so the production code is compared with it. */
function reference(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('mulberry32', () => {
  test('mulberry32 equals the published recurrence for seed 42', () => {
    const actual = mulberry32(42);
    const expected = reference(42);
    for (let i = 0; i < 1000; i += 1) assert.equal(actual(), expected());
  });

  test('mulberry32 first three outputs for seed 42 are pinned', () => {
    const next = mulberry32(42);
    assert.deepEqual([next(), next(), next()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
    const zero = mulberry32(0);
    assert.deepEqual([zero(), zero(), zero()], [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]);
  });

  test('mulberry32 outputs lie in [0, 1)', () => {
    const next = mulberry32(12345);
    for (let i = 0; i < 20_000; i += 1) {
      const value = next();
      assert.ok(value >= 0 && value < 1, `output ${String(value)} is outside [0, 1)`);
    }
  });

  test('mulberry32 differs between seeds', () => {
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });
});

describe('percentile', () => {
  const hundred = Array.from({ length: 101 }, (_, i) => i);

  test('percentile 0.05 over 0..100 is 5 and 0.95 is 95', () => {
    assert.equal(percentile(hundred, 0.05), 5);
    assert.equal(percentile(hundred, 0.95), 95);
  });

  test('percentile 0.05 over [0, 1] is 0', () => {
    assert.equal(percentile([0, 1], 0.05), 0);
  });

  test('percentile uses sorted[floor(p * (n - 1))]: 2000 values, p 0.05 reads index 99', () => {
    const values = Array.from({ length: 2000 }, (_, i) => i);
    assert.equal(percentile(values, 0.05), 99); // floor(0.05 * 1999) = floor(99.95)
    assert.equal(percentile(values, 0.95), 1899); // floor(0.95 * 1999) = floor(1899.05)
  });

  test('percentile ends: p 0 is the first value and p 1 the last', () => {
    assert.equal(percentile([3, 4, 9], 0), 3);
    assert.equal(percentile([3, 4, 9], 1), 9);
  });

  test('percentile is not thrown off by floating point representation (0.29 * 100)', () => {
    assert.equal(percentile(hundred, 0.29), 29); // 0.29 * 100 is 28.999999999999996 in floating point
  });

  test('percentile rejects an empty list and a p outside [0, 1]', () => {
    assert.throws(() => percentile([], 0.5), RangeError);
    assert.throws(() => percentile([1], -0.1), RangeError);
    assert.throws(() => percentile([1], 1.1), RangeError);
  });
});

describe('mean', () => {
  test('mean of 1, 2, 6 is 3', () => {
    assert.equal(mean([1, 2, 6]), 3);
  });

  test('mean of an empty list throws a RangeError', () => {
    assert.throws(() => mean([]), RangeError);
  });
});

describe('pairedClusterBootstrap', () => {
  test('all equal differences give diff, lower and upper of that difference', () => {
    const questions = Array.from({ length: 6 }, () => ({ atlas: [1, 1], grep: [0.9, 0.9] }));
    const result = pairedClusterBootstrap(questions, 500, 1);
    // each question: 1 - 0.9 (to floating point); every resampled mean equals the same value
    assert.ok(Math.abs(result.diff - 0.1) < 1e-12);
    assert.equal(result.lower, result.diff);
    assert.equal(result.upper, result.diff);
  });

  test('all equal differences of exactly 0.5 stay exactly 0.5', () => {
    const result = pairedClusterBootstrap([{ atlas: [1], grep: [0.5] }, { atlas: [1], grep: [0.5] }], 100, 9);
    assert.deepEqual(result, { diff: 0.5, lower: 0.5, upper: 0.5 });
  });

  test('two questions with differences 0 and 1: diff 0.5 and every resampled mean is 0, 0.5 or 1', () => {
    const distribution = bootstrapDistribution([0, 1], 2000, 7);
    assert.equal(distribution.length, 2000);
    for (const value of distribution) assert.ok(value === 0 || value === 0.5 || value === 1, `unexpected mean ${String(value)}`);
    const sorted = [...distribution].sort((a, b) => a - b);
    assert.deepEqual(distribution, sorted, 'the distribution is returned sorted ascending');
    // P(0) = P(1) = 0.25, so the 5th percentile is 0 and the 95th is 1 (hand calculation, not a tolerance)
    const result = pairedClusterBootstrap(
      [
        { atlas: [0], grep: [0] },
        { atlas: [1], grep: [0] },
      ],
      2000,
      7,
    );
    assert.equal(result.diff, 0.5);
    assert.equal(result.lower, 0);
    assert.equal(result.upper, 1);
  });

  test('single question gives that question difference for diff, lower and upper', () => {
    const result = pairedClusterBootstrap([{ atlas: [1, 0, 1, 1], grep: [0, 0, 1, 0] }], 300, 3);
    assert.deepEqual(result, { diff: 0.5, lower: 0.5, upper: 0.5 }); // 3/4 - 1/4
  });

  test('zero questions throws a RangeError', () => {
    assert.throws(() => pairedClusterBootstrap([], 100, 1), RangeError);
  });

  test('a question with no runs in one arm throws a RangeError', () => {
    assert.throws(() => pairedClusterBootstrap([{ atlas: [], grep: [1] }], 100, 1), RangeError);
  });

  test('a resample count that is not a positive integer throws a RangeError', () => {
    assert.throws(() => pairedClusterBootstrap([{ atlas: [1], grep: [0] }], 0, 1), RangeError);
    assert.throws(() => pairedClusterBootstrap([{ atlas: [1], grep: [0] }], 1.5, 1), RangeError);
  });

  test('same seed returns identical results and a different seed differs for a non-degenerate input', () => {
    const questions = Array.from({ length: 12 }, (_, i) => ({
      atlas: [i % 2, 1, (i % 3) % 2],
      grep: [1, i % 4 === 0 ? 0 : 1, 0],
    }));
    const first = pairedClusterBootstrap(questions, 1000, 11);
    const again = pairedClusterBootstrap(questions, 1000, 11);
    assert.deepEqual(first, again);
    assert.deepEqual(bootstrapDistribution([0.2, -0.4, 0.9, 0, 0.3], 200, 5), bootstrapDistribution([0.2, -0.4, 0.9, 0, 0.3], 200, 5));
    const other = pairedClusterBootstrap(questions, 1000, 12);
    assert.notDeepEqual(first, other);
  });

  test('all runs of a question stay together: the per-question difference comes from run means before resampling', () => {
    const result = pairedClusterBootstrap(
      [
        { atlas: [1, 0, 1], grep: [1, 1, 0] }, // run means 2/3 and 2/3: difference exactly 0
        { atlas: [1, 1, 1], grep: [0, 0, 0] }, // difference exactly 1
      ],
      1000,
      21,
    );
    assert.equal(result.diff, 0.5);
    assert.ok([0, 0.5, 1].includes(result.lower), `lower ${String(result.lower)} is not one of the cluster means`);
    assert.ok([0, 0.5, 1].includes(result.upper), `upper ${String(result.upper)} is not one of the cluster means`);
    for (const value of bootstrapDistribution([0, 1], 1000, 21)) assert.ok([0, 0.5, 1].includes(value));
  });

  test('level sets the percentiles: 0.9 reads the 10th and 90th of the distribution', () => {
    const questions = [
      { atlas: [1], grep: [0] },
      { atlas: [0], grep: [0] },
      { atlas: [1], grep: [1] },
      { atlas: [0], grep: [1] },
      { atlas: [1], grep: [0] },
    ];
    const distribution = bootstrapDistribution([1, 0, 0, -1, 1], 1000, 4);
    const result = pairedClusterBootstrap(questions, 1000, 4, 0.9);
    assert.equal(result.lower, percentile(distribution, 0.1));
    assert.equal(result.upper, percentile(distribution, 0.9));
  });

  test('the default level is 0.95: lower is the 5th percentile and upper the 95th', () => {
    const distribution = bootstrapDistribution([1, 0, 0, -1, 1], 1000, 4);
    const result = pairedClusterBootstrap(
      [
        { atlas: [1], grep: [0] },
        { atlas: [0], grep: [0] },
        { atlas: [1], grep: [1] },
        { atlas: [0], grep: [1] },
        { atlas: [1], grep: [0] },
      ],
      1000,
      4,
    );
    assert.equal(result.lower, percentile(distribution, 0.05));
    assert.equal(result.upper, percentile(distribution, 0.95));
  });
});

describe('wilsonInterval', () => {
  // Hand calculation (PITFALLS C4), n 50, z 1.96, z*z = 3.8416, denominator 1 + z*z/n = 1.076832:
  //   46 of 50: p 0.92, centre (0.92 + 0.038416) / 1.076832 = 0.89003, half-width 0.084443 / 1.076832 = 0.07842, lower 0.8116
  //   45 of 50: p 0.90, centre (0.90 + 0.038416) / 1.076832 = 0.87146, half-width 0.091601 / 1.076832 = 0.08507, lower 0.7864
  test('wilsonInterval at 46 of 50 has point 0.92 and a lower bound near 0.8115, above 0.8', () => {
    const result = wilsonInterval(46, 50, 1.96);
    assert.equal(result.point, 0.92);
    assert.ok(Math.abs(result.lower - 0.8115) < 0.001, `lower ${String(result.lower)}`);
    assert.ok(result.lower > 0.8);
    assert.ok(Math.abs(result.upper - 0.9685) < 0.001, `upper ${String(result.upper)}`);
  });

  test('wilsonInterval at 45 of 50 has a lower bound near 0.7864, below 0.8', () => {
    const result = wilsonInterval(45, 50, 1.96);
    assert.equal(result.point, 0.9);
    assert.ok(Math.abs(result.lower - 0.7864) < 0.001, `lower ${String(result.lower)}`);
    assert.ok(result.lower < 0.8);
  });

  test('wilsonInterval with no observations throws a RangeError', () => {
    assert.throws(() => wilsonInterval(0, 0, 1.96), RangeError);
  });

  test('wilsonInterval rejects successes above n, a negative or fractional count, and a non-positive z', () => {
    assert.throws(() => wilsonInterval(6, 5, 1.96), RangeError);
    assert.throws(() => wilsonInterval(-1, 5, 1.96), RangeError);
    assert.throws(() => wilsonInterval(1.5, 5, 1.96), RangeError);
    assert.throws(() => wilsonInterval(1, 5, 0), RangeError);
    assert.throws(() => wilsonInterval(1, 5, Number.NaN), RangeError);
  });

  test('wilsonInterval bounds stay within [0, 1] at the extremes and the point lies between them', () => {
    for (const [successes, n] of [[0, 1], [1, 1], [0, 10], [10, 10], [3, 7], [500, 1000]] as const) {
      const result = wilsonInterval(successes, n, 1.96);
      assert.ok(result.lower >= 0 && result.upper <= 1, `${String(successes)}/${String(n)}: [${String(result.lower)}, ${String(result.upper)}]`);
      assert.ok(result.lower <= result.point && result.point <= result.upper);
    }
    assert.equal(wilsonInterval(0, 10, 1.96).lower, 0);
    assert.equal(wilsonInterval(10, 10, 1.96).upper, 1);
  });
});
