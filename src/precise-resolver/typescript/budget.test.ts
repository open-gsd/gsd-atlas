/**
 * The memory budget of the compiler worker (plan 03-27, D-21, TSM-05): what a machine's RAM allows, and the rule that ends a
 * process past its limit. Pure functions here; the worker, the sampler and the pool have their own cases in memory.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEMORY_DEFAULTS, createMemoryBudget, deriveBudget } from './budget.ts';
import { shouldKill } from './sampler.ts';

const GIB = 1024 ** 3;

const derive = (totalMemBytes: number, overrides: Partial<Parameters<typeof deriveBudget>[0]> = {}) =>
  deriveBudget({ totalMemBytes, percent: 25, heapShare: 0.8, minMb: 512, ...overrides });

describe('deriveBudget: what a machine allows (D-21, precise.memoryBudgetPercent, precise.heapShareOfBudget, precise.minBudgetMb)', () => {
  it('16 GiB gives a 4096 MB budget and a 3276 MB heap', () => {
    assert.deepStrictEqual(derive(16 * GIB), { budgetMb: 4096, heapMb: 3276, rssLimitMb: 4096, usable: true });
  });

  it('4 GiB gives a 1024 MB budget and is usable', () => {
    const result = derive(4 * GIB);
    assert.equal(result.budgetMb, 1024);
    assert.equal(result.heapMb, 819);
    assert.equal(result.usable, true);
  });

  it('1 GiB gives 256 MB and is not usable: it is below the 512 MB floor', () => {
    const result = derive(1 * GIB);
    assert.equal(result.budgetMb, 256);
    assert.equal(result.usable, false);
  });

  it('the floor is inclusive: exactly 512 MB is usable', () => {
    assert.equal(derive(2 * GIB).budgetMb, 512);
    assert.equal(derive(2 * GIB).usable, true);
    assert.equal(derive(2 * GIB - 4 * 1024 * 1024).usable, false);
  });

  it('every value is a whole number, whatever the RAM', () => {
    for (const bytes of [3_333_333_333, 7 * GIB + 12345, 12_345_678_901]) {
      const result = derive(bytes);
      for (const value of [result.budgetMb, result.heapMb, result.rssLimitMb]) assert.ok(Number.isInteger(value), `${String(value)} from ${String(bytes)}`);
    }
  });

  it('the heap value always fits the six-digit pattern of the worker shape, even on a machine with terabytes', () => {
    const result = derive(8 * 1024 * GIB, { percent: 90 });
    assert.ok(result.heapMb <= 999_999, String(result.heapMb));
    assert.match(`--max-old-space-size=${String(result.heapMb)}`, /^--max-old-space-size=[0-9]{1,6}$/);
    assert.ok(result.rssLimitMb >= result.heapMb);
  });

  it('a percent outside 1 to 90, or a RAM value that is not a positive finite number, is a RangeError', () => {
    for (const percent of [0, 0.5, 91, 100, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => derive(16 * GIB, { percent }), RangeError, `percent ${String(percent)}`);
    }
    for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      assert.throws(() => derive(bytes), RangeError, `ram ${String(bytes)}`);
    }
  });

  it('a heap share outside 0 to 1, or a negative floor, is a RangeError', () => {
    for (const heapShare of [0, -0.1, 1.01, Number.NaN]) assert.throws(() => derive(16 * GIB, { heapShare }), RangeError);
    assert.throws(() => derive(16 * GIB, { minMb: -1 }), RangeError);
  });

  it('the approved constants are the ones 03-CONSTANTS.md lists', () => {
    assert.equal(MEMORY_DEFAULTS.percent, 25);
    assert.equal(MEMORY_DEFAULTS.heapShare, 0.8);
    assert.equal(MEMORY_DEFAULTS.sampleMs, 250);
    assert.equal(MEMORY_DEFAULTS.minMb, 512);
    assert.equal(MEMORY_DEFAULTS.idleExitMs, 300_000);
  });
});

describe('shouldKill: the sampler rule', () => {
  it('is true strictly above the limit and false at equality and below', () => {
    assert.equal(shouldKill(101, 100), true);
    assert.equal(shouldKill(100, 100), false);
    assert.equal(shouldKill(99, 100), false);
    assert.equal(shouldKill(0, 100), false);
  });

  it('a limit of 0, a negative limit, or one that is not finite throws', () => {
    assert.throws(() => shouldKill(10, 0), RangeError);
    assert.throws(() => shouldKill(10, -5), RangeError);
    assert.throws(() => shouldKill(10, Number.NaN), RangeError);
    assert.throws(() => shouldKill(Number.NaN, 100), RangeError);
  });
});

describe('createMemoryBudget: the values of a machine', () => {
  it('derives from the injected RAM and the approved constants', () => {
    const budget = createMemoryBudget({ totalMemBytes: 16 * GIB });
    assert.deepStrictEqual(budget.derived, { budgetMb: 4096, heapMb: 3276, rssLimitMb: 4096, usable: true });
    assert.deepStrictEqual(budget.status(), { budgetMb: 4096, reservedMb: 0, usable: true, owners: [] });
  });
});
