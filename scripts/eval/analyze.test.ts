import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { analyzeResults } from './analyze.ts';
import type { AccuracyConfig } from './analyze.ts';
import { ResultRowSchema } from './rows.ts';
import type { ResultRow } from './rows.ts';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'results-small.jsonl');

function loadFixture(): ResultRow[] {
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ResultRowSchema.parse(JSON.parse(line)));
}

const CONFIG: AccuracyConfig = { marginPoints: 5, intervalLevel: 0.95, resamples: 2000, seed: 7 };

/** Replaces one row of the fixture; used to build the failing variant of the verdict. */
function withRow(rows: readonly ResultRow[], questionId: string, arm: string, run: number, change: Partial<ResultRow>): ResultRow[] {
  return rows.map((row) => (row.questionId === questionId && row.arm === arm && row.run === run ? { ...row, ...change } : row));
}

describe('ResultRowSchema', () => {
  test('ResultRowSchema accepts every row of the fixture', () => {
    assert.equal(loadFixture().length, 8);
  });

  test('ResultRowSchema rejects a row whose billableTokens is not the sum of the four usage fields', () => {
    const [row] = loadFixture();
    assert.ok(row);
    const result = ResultRowSchema.safeParse({ ...row, billableTokens: row.billableTokens + 1 });
    assert.equal(result.success, false);
    assert.match(JSON.stringify(result.error?.issues), /billableTokens/);
  });

  test('ResultRowSchema accepts a null costUsd and rejects an unknown key and run 0', () => {
    const [row] = loadFixture();
    assert.ok(row);
    assert.equal(ResultRowSchema.safeParse({ ...row, costUsd: null }).success, true);
    assert.equal(ResultRowSchema.safeParse({ ...row, extra: 1 }).success, false);
    assert.equal(ResultRowSchema.safeParse({ ...row, run: 0 }).success, false);
  });

  test('ResultRowSchema rejects more verified citations than cited ones', () => {
    const [row] = loadFixture();
    assert.ok(row);
    const bad = { ...row, citation: { ...row.citation, total: 1, verified: 2 } };
    assert.equal(ResultRowSchema.safeParse(bad).success, false);
  });
});

describe('analyzeResults accuracy', () => {
  test('observed difference matches the hand computation (q-1: 1 - 0.5, q-2: 1 - 1, mean 0.25)', () => {
    const result = analyzeResults(loadFixture(), CONFIG);
    assert.equal(result.observedDiff, 0.25);
  });

  test('passing variant: lower is 0 (the 5th percentile of {0, 0.25, 0.5}) so accuracyNonInferior is true', () => {
    const result = analyzeResults(loadFixture(), CONFIG);
    assert.equal(result.lower, 0);
    assert.equal(result.upper, 0.5);
    assert.equal(result.accuracyNonInferior, result.lower > -0.05);
    assert.equal(result.accuracyNonInferior, true);
  });

  test('failing variant: one more wrong atlas answer on q-2 gives lower -0.5 and accuracyNonInferior false', () => {
    const rows = withRow(loadFixture(), 'q-2', 'atlas', 2, { correct: false, status: 'error' });
    const result = analyzeResults(rows, CONFIG);
    assert.equal(result.observedDiff, 0); // differences 0.5 and -0.5
    assert.equal(result.lower, -0.5);
    assert.equal(result.accuracyNonInferior, result.lower > -0.05);
    assert.equal(result.accuracyNonInferior, false);
  });

  test('the margin is read from the config: a zero margin makes lower 0 not above -0', () => {
    const result = analyzeResults(loadFixture(), { ...CONFIG, marginPoints: 0 });
    assert.equal(result.lower, 0);
    assert.equal(result.accuracyNonInferior, false); // the rule is strictly above minus the margin
  });

  test('a wide margin passes the failing variant', () => {
    const rows = withRow(loadFixture(), 'q-2', 'atlas', 2, { correct: false });
    assert.equal(analyzeResults(rows, { ...CONFIG, marginPoints: 60 }).accuracyNonInferior, true);
  });

  test('a question with rows in only one arm throws a RangeError', () => {
    const rows = loadFixture().filter((row) => !(row.questionId === 'q-2' && row.arm === 'grep'));
    assert.throws(() => analyzeResults(rows, CONFIG), RangeError);
  });

  test('no rows throws a RangeError', () => {
    assert.throws(() => analyzeResults([], CONFIG), RangeError);
  });

  test('the same config gives the same result twice', () => {
    assert.deepEqual(analyzeResults(loadFixture(), CONFIG), analyzeResults(loadFixture(), CONFIG));
  });
});
