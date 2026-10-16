import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cutToBudget, estimateTokens } from './budget.ts';

describe('estimateTokens: serialized characters divided by four, rounded up', () => {
  it('is ceil(JSON.stringify(envelope).length / 4)', () => {
    const envelope = { schema: 's', ok: true, data: { results: [] }, diagnostics: [] };
    assert.equal(estimateTokens(envelope), Math.ceil(JSON.stringify(envelope).length / 4));
  });

  it('counts UTF-16 code units, the unit the spans use: an emoji is two', () => {
    // {"a":"<emoji>"} is 9 code units (8 code points), so 3 tokens, not 2.
    assert.equal(estimateTokens({ a: '\u{1F600}' }), 3);
  });
});

/** Items are plain sizes; a response costs 5 plus the items kept plus 3 when it carries a cursor. */
const measure = (kept: readonly number[], truncated: boolean): number => 5 + kept.reduce((sum, size) => sum + size, 0) + (truncated ? 3 : 0);

describe('cutToBudget: whole items only', () => {
  it('keeps the longest prefix whose response fits the budget', async () => {
    const cut = await cutToBudget([10, 10, 10, 10], measure, { budget: 30, ceiling: 100 }, false);
    assert.deepEqual(cut.kept, [10, 10]);
    assert.equal(cut.truncated, true);
    assert.equal(cut.lastIndex, 1);
    assert.equal(cut.tooLarge, false);
  });

  it('measures the response with its cursor when more items remain', async () => {
    // Two items cost 5 + 20 + 3 = 28 with a cursor; with a budget of 27 only one fits.
    const cut = await cutToBudget([10, 10, 10], measure, { budget: 27, ceiling: 100 }, false);
    assert.deepEqual(cut.kept, [10]);
  });

  it('keeps everything and reports no cut when it all fits and nothing lies beyond', async () => {
    const cut = await cutToBudget([10, 10], measure, { budget: 100, ceiling: 100 }, false);
    assert.deepEqual(cut.kept, [10, 10]);
    assert.equal(cut.truncated, false);
    assert.equal(cut.lastIndex, 1);
  });

  it('reports a cut when everything fits but more lies beyond the items given', async () => {
    const cut = await cutToBudget([10, 10], measure, { budget: 100, ceiling: 100 }, true);
    assert.deepEqual(cut.kept, [10, 10]);
    assert.equal(cut.truncated, true);
  });

  it('returns the first item alone when it exceeds the budget but not the ceiling', async () => {
    const cut = await cutToBudget([10, 10], measure, { budget: 5, ceiling: 100 }, false);
    assert.deepEqual(cut.kept, [10]);
    assert.equal(cut.truncated, true);
    assert.equal(cut.tooLarge, false);
  });

  it('holds the budget to the ceiling', async () => {
    const cut = await cutToBudget([10, 10, 10], measure, { budget: 1000, ceiling: 28 }, false);
    assert.deepEqual(cut.kept, [10, 10]);
    assert.equal(cut.truncated, true);
  });

  it('reports tooLarge when even the first item exceeds the ceiling', async () => {
    const cut = await cutToBudget([10, 10], measure, { budget: 100, ceiling: 10 }, false);
    assert.deepEqual(cut.kept, []);
    assert.equal(cut.tooLarge, true);
  });

  it('keeps nothing and reports no cut for an empty list', async () => {
    const cut = await cutToBudget([], measure, { budget: 100, ceiling: 100 }, false);
    assert.deepEqual(cut.kept, []);
    assert.equal(cut.truncated, false);
    assert.equal(cut.lastIndex, -1);
    assert.equal(cut.tooLarge, false);
  });
});
