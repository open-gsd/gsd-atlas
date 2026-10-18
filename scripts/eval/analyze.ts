/**
 * The analysis of the MVP eval (D-04, D-06, EVL-02, EVL-03): result rows in, registered verdicts out.
 *
 * Every parameter (margin, interval level, resample count, seed) arrives in the config object and nothing here
 * supplies a value for one, so changing a parameter after the freeze is a visible change to the registered
 * pre-registration and not a quiet edit of this file.
 */
import { pairedClusterBootstrap } from './stats.ts';
import type { QuestionSeries } from './stats.ts';
import type { Arm, ResultRow } from './rows.ts';

export interface AccuracyConfig {
  /** The non-inferiority margin in percentage points (5 means 0.05). */
  readonly marginPoints: number;
  /** The one-sided confidence level of the bootstrap bound (0.95: the 5th percentile is the lower bound). */
  readonly intervalLevel: number;
  readonly resamples: number;
  readonly seed: number;
}

export interface AccuracyResult {
  /** Mean over questions of (atlas accuracy minus grep accuracy). */
  readonly observedDiff: number;
  /** The `1 - intervalLevel` percentile of the bootstrap distribution of the difference. */
  readonly lower: number;
  /** The `intervalLevel` percentile of the bootstrap distribution of the difference. */
  readonly upper: number;
  /** True when `lower` is strictly above minus the margin: the registered rule, in one expression. */
  readonly accuracyNonInferior: boolean;
}

/** Questions in a fixed order (by id), each with its rows per arm; resampling depends on this order. */
export interface PairedQuestion {
  readonly questionId: string;
  readonly rows: Readonly<Record<Arm, readonly ResultRow[]>>;
}

function checkAccuracyConfig(config: AccuracyConfig): void {
  if (!Number.isFinite(config.marginPoints) || config.marginPoints < 0) {
    throw new RangeError(`marginPoints must be a non-negative number, got ${String(config.marginPoints)}`);
  }
  if (!Number.isInteger(config.seed)) throw new RangeError(`seed must be an integer, got ${String(config.seed)}`);
}

/** Groups rows by question, ordered by id so the result does not depend on the order rows were written in. */
export function pairByQuestion(rows: readonly ResultRow[]): PairedQuestion[] {
  if (rows.length === 0) throw new RangeError('no result rows to analyse');
  const byQuestion = new Map<string, { atlas: ResultRow[]; grep: ResultRow[] }>();
  for (const row of rows) {
    let entry = byQuestion.get(row.questionId);
    if (entry === undefined) {
      entry = { atlas: [], grep: [] };
      byQuestion.set(row.questionId, entry);
    }
    entry[row.arm].push(row);
  }
  const ids = [...byQuestion.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids.map((questionId) => {
    const entry = byQuestion.get(questionId) as { atlas: ResultRow[]; grep: ResultRow[] };
    if (entry.atlas.length === 0 || entry.grep.length === 0) {
      throw new RangeError(`question ${questionId} has no rows in the ${entry.atlas.length === 0 ? 'atlas' : 'grep'} arm`);
    }
    return { questionId, rows: entry };
  });
}

/** A failed session has `correct: false` on its row, so it counts as incorrect without any special case here. */
export function accuracySeries(questions: readonly PairedQuestion[]): QuestionSeries[] {
  return questions.map((question) => ({
    atlas: question.rows.atlas.map((row) => (row.correct ? 1 : 0)),
    grep: question.rows.grep.map((row) => (row.correct ? 1 : 0)),
  }));
}

/**
 * The registered accuracy rule: the arm passes when the `1 - intervalLevel` percentile of the paired cluster
 * bootstrap distribution of (atlas accuracy minus grep accuracy) is strictly above minus the margin.
 */
export function analyzeAccuracy(rows: readonly ResultRow[], config: AccuracyConfig): AccuracyResult {
  checkAccuracyConfig(config);
  const series = accuracySeries(pairByQuestion(rows));
  const { diff, lower, upper } = pairedClusterBootstrap(series, config.resamples, config.seed, config.intervalLevel);
  return { observedDiff: diff, lower, upper, accuracyNonInferior: lower > -(config.marginPoints / 100) };
}

export function analyzeResults(rows: readonly ResultRow[], config: AccuracyConfig): AccuracyResult {
  return analyzeAccuracy(rows, config);
}
