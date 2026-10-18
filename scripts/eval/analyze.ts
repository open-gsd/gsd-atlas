/**
 * The analysis of the MVP eval (D-04, D-06, EVL-02, EVL-03): result rows in, registered verdicts out.
 *
 * Every parameter (margin, interval level, resample count, seed, token rule, citation threshold and rule, Wilson
 * z) arrives in the config object and nothing here supplies a value for one, so changing a parameter after the
 * freeze is a visible change to the registered pre-registration and not a quiet edit of this file.
 */
import { pairedClusterBootstrap } from './stats.ts';
import type { QuestionSeries } from './stats.ts';
import type { Arm, ResultRow, SessionStatus } from './rows.ts';

export type TokenCriterion = 'point' | 'upper-bound';
export type CitationJudgedOn = 'point_estimate' | 'wilson_lower_bound';

export interface AccuracyConfig {
  /** The non-inferiority margin in percentage points (5 means 0.05). */
  readonly marginPoints: number;
  /** The one-sided confidence level of the bootstrap bound (0.95: the 5th percentile is the lower bound). */
  readonly intervalLevel: number;
  readonly resamples: number;
  readonly seed: number;
}

export interface AnalysisConfig extends AccuracyConfig {
  /** `point`: fewer tokens when the observed mean difference is below zero. `upper-bound`: when the upper percentile is. */
  readonly tokenCriterion: TokenCriterion;
  /** The registered citation threshold (0.8 for EVL-03). */
  readonly citationRate: number;
  /** Which figure the threshold is judged on. Registered by the user (OQ4); there is no default. */
  readonly citationJudgedOn: CitationJudgedOn;
  /** The z of the Wilson interval (1.96 for 95 percent two-sided). */
  readonly zForWilson: number;
}

export interface ExpectedCells {
  readonly questionIds: readonly string[];
  readonly arms: readonly Arm[];
  readonly runsPerCell: number;
}

export interface Cell {
  readonly questionId: string;
  readonly arm: Arm;
  readonly run: number;
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

export interface TokenAnalysis {
  readonly criterion: TokenCriterion;
  /** Mean over questions of (atlas mean billable tokens minus grep mean billable tokens). */
  readonly observedDiff: number;
  readonly lower: number;
  readonly upper: number;
  readonly fewerTokens: boolean;
}

export interface ArmCitation {
  readonly sessions: number;
  readonly verifiable: number;
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

export interface CitationAnalysis {
  readonly threshold: number;
  readonly z: number;
  readonly judgedOn: CitationJudgedOn;
  /** The arm the criterion is judged on: EVL-03 speaks of agents using atlas. */
  readonly judgedArm: Arm;
  readonly byArm: Readonly<Record<Arm, ArmCitation>>;
  readonly citationOkPointEstimate: boolean;
  readonly citationOkWilsonLowerBound: boolean;
  readonly citationOk: boolean;
}

export interface Total {
  readonly total: number;
  readonly mean: number;
}

export interface ArmSummary {
  readonly sessions: number;
  readonly failedSessions: number;
  readonly accuracy: number;
  readonly tokens: {
    readonly total: number;
    readonly mean: number;
    readonly input: number;
    readonly output: number;
    readonly cacheCreation: number;
    readonly cacheRead: number;
  };
  readonly toolCalls: Total;
  readonly wallMs: Total;
  /** Totals and means over the sessions that report a cost; null when none does. */
  readonly costUsd: { readonly total: number; readonly mean: number; readonly sessionsWithCost: number } | null;
  /** Atlas tool calls over all tool calls; null when the arm made no tool call. */
  readonly atlasToolShare: number | null;
}

export interface FailedSession {
  readonly questionId: string;
  readonly arm: Arm;
  readonly run: number;
  readonly status: SessionStatus;
}

export interface IncompleteAnalysis {
  readonly complete: false;
  readonly config: AnalysisConfig;
  readonly expectedCells: number;
  readonly presentCells: number;
  readonly missing: readonly Cell[];
}

export interface CompleteAnalysis {
  readonly complete: true;
  readonly config: AnalysisConfig;
  readonly questions: number;
  readonly sessions: number;
  readonly accuracy: AccuracyResult;
  readonly tokens: TokenAnalysis;
  readonly citations: CitationAnalysis;
  readonly arms: Readonly<Record<Arm, ArmSummary>>;
  readonly failedSessions: readonly FailedSession[];
  readonly verdicts: {
    readonly accuracy: boolean;
    readonly tokens: boolean;
    readonly citations: boolean;
    readonly overall: boolean;
  };
}

export type Analysis = IncompleteAnalysis | CompleteAnalysis;

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

// RED stubs for Task 2: the complete analysis and the report are not written yet.
export function analyzeResults(_rows: readonly ResultRow[], _config: AnalysisConfig, _expected: ExpectedCells): Analysis {
  throw new Error('analyzeResults is implemented in Task 2');
}

export function renderReport(_analysis: Analysis): string {
  throw new Error('renderReport is implemented in Task 2');
}
