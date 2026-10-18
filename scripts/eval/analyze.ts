/**
 * The analysis of the MVP eval (D-04, D-06, EVL-02, EVL-03): result rows in, registered verdicts out.
 *
 * Every parameter (margin, interval level, resample count, seed, token rule, citation threshold and rule, Wilson
 * z) arrives in the config object and nothing here supplies a value for one, so changing a parameter after the
 * freeze is a visible change to the registered pre-registration and not a quiet edit of this file.
 */
import { mean, pairedClusterBootstrap, wilsonInterval } from './stats.ts';
import type { QuestionSeries } from './stats.ts';
import type { Prereg } from './prereg.ts';
import type { Arm, ResultRow, SessionStatus } from './rows.ts';
import type { Io } from './verify-prereg.ts';

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

/**
 * The registered failure rule: a session that ran and failed (any status but `ok`) counts as incorrect whatever its
 * row says, so a scorer that marked a timed-out answer correct cannot lift an arm.
 */
export function isCorrect(row: ResultRow): boolean {
  return row.status === 'ok' && row.correct;
}

/** The citation counterpart of `isCorrect`: a failed session never counts as carrying a verifiable citation. */
export function isVerifiable(row: ResultRow): boolean {
  return row.status === 'ok' && row.citation.hasVerifiable;
}

export function accuracySeries(questions: readonly PairedQuestion[]): QuestionSeries[] {
  return questions.map((question) => ({
    atlas: question.rows.atlas.map((row) => (isCorrect(row) ? 1 : 0)),
    grep: question.rows.grep.map((row) => (isCorrect(row) ? 1 : 0)),
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

const ARM_ORDER: readonly Arm[] = ['atlas', 'grep'];
const TOKEN_CRITERIA: readonly string[] = ['point', 'upper-bound'];
const CITATION_RULES: readonly string[] = ['point_estimate', 'wilson_lower_bound'];

/**
 * The citation rule is the user's choice (OQ4) and has no default anywhere: a value that is absent or is not one of
 * the two registered strings stops the analysis.
 */
function checkCitationRule(value: unknown): void {
  if (typeof value !== 'string' || !CITATION_RULES.includes(value)) {
    throw new RangeError(`citationJudgedOn must be one of ${CITATION_RULES.join(', ')} (registered by the user, no default), got ${JSON.stringify(value)}`);
  }
}

function assertNever(value: never): never {
  throw new RangeError(`unreachable registered value ${String(value)}`);
}

function checkConfig(config: AnalysisConfig): void {
  checkAccuracyConfig(config);
  checkCitationRule(config.citationJudgedOn);
  if (!TOKEN_CRITERIA.includes(config.tokenCriterion)) {
    throw new RangeError(`tokenCriterion must be one of ${TOKEN_CRITERIA.join(', ')}, got ${JSON.stringify(config.tokenCriterion)}`);
  }
  if (!(config.citationRate > 0 && config.citationRate <= 1)) {
    throw new RangeError(`citationRate must be in (0, 1], got ${String(config.citationRate)}`);
  }
  if (!(Number.isFinite(config.zForWilson) && config.zForWilson > 0)) {
    throw new RangeError(`zForWilson must be a positive number, got ${String(config.zForWilson)}`);
  }
  if (!(config.intervalLevel > 0.5 && config.intervalLevel < 1)) {
    throw new RangeError(`intervalLevel must be in (0.5, 1), got ${String(config.intervalLevel)}`);
  }
  if (!Number.isInteger(config.resamples) || config.resamples < 1) {
    throw new RangeError(`resamples must be a positive integer, got ${String(config.resamples)}`);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cellName(cell: Cell): string {
  return `${cell.questionId}/${cell.arm}/${String(cell.run)}`;
}

function compareRows(a: ResultRow, b: ResultRow): number {
  return compareText(a.questionId, b.questionId) || compareText(a.arm, b.arm) || a.run - b.run;
}

function expectedCellList(expected: ExpectedCells): Cell[] {
  if (!Number.isInteger(expected.runsPerCell) || expected.runsPerCell < 1) {
    throw new RangeError(`runsPerCell must be a positive integer, got ${String(expected.runsPerCell)}`);
  }
  for (const arm of ARM_ORDER) {
    if (!expected.arms.includes(arm)) throw new RangeError(`the expected cells must cover the ${arm} arm: the comparison is paired`);
  }
  const ids = [...new Set(expected.questionIds)].sort(compareText);
  if (ids.length === 0) throw new RangeError('the expected cells name no question');
  const cells: Cell[] = [];
  for (const questionId of ids) {
    for (const arm of ARM_ORDER) {
      for (let run = 1; run <= expected.runsPerCell; run += 1) cells.push({ questionId, arm, run });
    }
  }
  return cells;
}

function armRows(rows: readonly ResultRow[], arm: Arm): ResultRow[] {
  return rows.filter((row) => row.arm === arm);
}

function sum(rows: readonly ResultRow[], pick: (row: ResultRow) => number): number {
  let total = 0;
  for (const row of rows) total += pick(row);
  return total;
}

function summarizeArm(rows: readonly ResultRow[], questions: readonly PairedQuestion[], arm: Arm): ArmSummary {
  const mine = armRows(rows, arm);
  const sessions = mine.length;
  const perQuestionAccuracy = questions.map((question) => mean(question.rows[arm].map((row) => (isCorrect(row) ? 1 : 0))));
  const withCost = mine.filter((row) => row.costUsd !== null);
  const costTotal = sum(withCost, (row) => row.costUsd as number);
  const toolCallTotal = sum(mine, (row) => row.toolCalls);
  const tokenTotal = sum(mine, (row) => row.billableTokens);
  const wallTotal = sum(mine, (row) => row.wallMs);
  return {
    sessions,
    failedSessions: mine.filter((row) => row.status !== 'ok').length,
    accuracy: mean(perQuestionAccuracy),
    tokens: {
      total: tokenTotal,
      mean: tokenTotal / sessions,
      input: sum(mine, (row) => row.usage.input),
      output: sum(mine, (row) => row.usage.output),
      cacheCreation: sum(mine, (row) => row.usage.cacheCreation),
      cacheRead: sum(mine, (row) => row.usage.cacheRead),
    },
    toolCalls: { total: toolCallTotal, mean: toolCallTotal / sessions },
    wallMs: { total: wallTotal, mean: wallTotal / sessions },
    costUsd:
      withCost.length === 0 ? null : { total: costTotal, mean: costTotal / withCost.length, sessionsWithCost: withCost.length },
    atlasToolShare: toolCallTotal === 0 ? null : sum(mine, (row) => row.atlasToolCalls) / toolCallTotal,
  };
}

function citationOfArm(rows: readonly ResultRow[], arm: Arm, z: number): ArmCitation {
  const eligible = armRows(rows, arm).filter((row) => row.category !== 'abstain');
  if (eligible.length === 0) throw new RangeError(`the ${arm} arm has no session on a non-abstain question`);
  const verifiable = eligible.filter(isVerifiable).length;
  const { point, lower, upper } = wilsonInterval(verifiable, eligible.length, z);
  return { sessions: eligible.length, verifiable, point, lower, upper };
}

function judgeCitations(config: AnalysisConfig, byArm: Readonly<Record<Arm, ArmCitation>>): CitationAnalysis {
  const judged = byArm.atlas;
  const citationOkPointEstimate = judged.point >= config.citationRate;
  const citationOkWilsonLowerBound = judged.lower >= config.citationRate;
  let citationOk: boolean;
  switch (config.citationJudgedOn) {
    case 'point_estimate':
      citationOk = citationOkPointEstimate;
      break;
    case 'wilson_lower_bound':
      citationOk = citationOkWilsonLowerBound;
      break;
    default:
      return assertNever(config.citationJudgedOn);
  }
  return {
    threshold: config.citationRate,
    z: config.zForWilson,
    judgedOn: config.citationJudgedOn,
    judgedArm: 'atlas',
    byArm,
    citationOkPointEstimate,
    citationOkWilsonLowerBound,
    citationOk,
  };
}

function analyzeTokens(questions: readonly PairedQuestion[], config: AnalysisConfig): TokenAnalysis {
  const series: QuestionSeries[] = questions.map((question) => ({
    atlas: question.rows.atlas.map((row) => row.billableTokens),
    grep: question.rows.grep.map((row) => row.billableTokens),
  }));
  const { diff, lower, upper } = pairedClusterBootstrap(series, config.resamples, config.seed, config.intervalLevel);
  const fewerTokens = config.tokenCriterion === 'point' ? diff < 0 : upper < 0;
  return { criterion: config.tokenCriterion, observedDiff: diff, lower, upper, fewerTokens };
}

/**
 * Turns result rows into the registered verdicts.
 *
 * Completeness comes first. A row outside the expected (question, arm, run) cells and a cell with more than one row
 * are errors (nothing is dropped or merged silently). A cell with no row at all makes the result `complete: false`
 * with the missing cells listed, and no verdict exists on it. On a complete run: accuracy by the paired cluster
 * bootstrap, tokens as total billable tokens per session paired by question, citations as the share of sessions on
 * non-abstain questions whose answer carries a verifiable file:line (judged on the atlas arm, reported for both),
 * and per-arm summaries. A failed session counts as incorrect, has no verifiable citation, and keeps its tokens.
 */
export function analyzeResults(rows: readonly ResultRow[], config: AnalysisConfig, expected: ExpectedCells): Analysis {
  checkConfig(config);
  const expectedCells = expectedCellList(expected);
  const known = new Set(expectedCells.map(cellName));
  const seen = new Map<string, number>();
  const unexpected: string[] = [];
  for (const row of rows) {
    const name = cellName(row);
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (!known.has(name)) unexpected.push(name);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `${name} (${String(n)} rows)`).sort();
  if (duplicates.length > 0) throw new Error(`duplicate cell: ${duplicates.join(', ')}`);
  if (unexpected.length > 0) throw new Error(`unexpected cell not in the registered design: ${[...new Set(unexpected)].sort().join(', ')}`);
  const missing = expectedCells.filter((cell) => !seen.has(cellName(cell)));
  if (missing.length > 0) {
    return { complete: false, config, expectedCells: expectedCells.length, presentCells: seen.size, missing };
  }
  const ordered = [...rows].sort(compareRows);
  const questions = pairByQuestion(ordered);
  const accuracy = analyzeAccuracy(ordered, config);
  const tokens = analyzeTokens(questions, config);
  const citations = judgeCitations(config, {
    atlas: citationOfArm(ordered, 'atlas', config.zForWilson),
    grep: citationOfArm(ordered, 'grep', config.zForWilson),
  });
  const failedSessions: FailedSession[] = ordered
    .filter((row) => row.status !== 'ok')
    .map((row) => ({ questionId: row.questionId, arm: row.arm, run: row.run, status: row.status }));
  const verdicts = {
    accuracy: accuracy.accuracyNonInferior,
    tokens: tokens.fewerTokens,
    citations: citations.citationOk,
    overall: accuracy.accuracyNonInferior && tokens.fewerTokens && citations.citationOk,
  };
  return {
    complete: true,
    config,
    questions: questions.length,
    sessions: ordered.length,
    accuracy,
    tokens,
    citations,
    arms: { atlas: summarizeArm(ordered, questions, 'atlas'), grep: summarizeArm(ordered, questions, 'grep') },
    failedSessions,
    verdicts,
  };
}

/** Fixed decimals with no negative zero, so the same number always prints the same text. */
function fixed(x: number, digits: number): string {
  const text = x.toFixed(digits);
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

function pct(x: number): string {
  return `${fixed(x * 100, 1)}%`;
}

function ordinal(x: number): string {
  return `${String(Number((x * 100).toFixed(6)))}th`;
}

function tableRow(...cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function parametersBlock(config: AnalysisConfig): string[] {
  const lines = ['## Parameters', '', 'Read from the registered pre-registration; nothing here is a default.', '', tableRow('parameter', 'value'), tableRow('---', '---')];
  const values = config as unknown as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(values).sort(compareText)) lines.push(tableRow(key, String(values[key])));
  return lines;
}

/**
 * The deterministic markdown report: a title, the parameters, one table per section, the verdict lines and the
 * failed sessions. Numbers print with fixed decimals and keys are sorted, so one analysis always renders the same
 * bytes. An incomplete run prints INCOMPLETE and the missing cells and no pass or fail verdict.
 */
export function renderReport(analysis: Analysis): string {
  const lines: string[] = ['# Eval analysis', ''];
  lines.push(...parametersBlock(analysis.config), '');
  if (!analysis.complete) {
    lines.push('## Run', '', `INCOMPLETE: ${String(analysis.presentCells)} of ${String(analysis.expectedCells)} registered cells have a row.`, '');
    lines.push('No verdict is printed for an incomplete run. Missing cells (question, arm, run):', '');
    lines.push(tableRow('question', 'arm', 'run'), tableRow('---', '---', '---'));
    for (const cell of analysis.missing) lines.push(tableRow(cell.questionId, cell.arm, String(cell.run)));
    lines.push('', 'OVERALL: INCOMPLETE');
    return `${lines.join('\n')}\n`;
  }
  const { config, accuracy, tokens, citations, arms, verdicts } = analysis;
  const level = config.intervalLevel;
  lines.push('## Run', '', `${String(analysis.questions)} questions, ${String(analysis.sessions)} sessions (atlas ${String(arms.atlas.sessions)}, grep ${String(arms.grep.sessions)}).`, '');
  lines.push('## Accuracy', '', tableRow('arm', 'accuracy', 'failed sessions'), tableRow('---', '---', '---'));
  for (const arm of ARM_ORDER) lines.push(tableRow(arm, fixed(arms[arm].accuracy, 4), String(arms[arm].failedSessions)));
  lines.push(
    '',
    `Observed difference (atlas minus grep): ${fixed(accuracy.observedDiff, 4)}`,
    `Bootstrap ${ordinal(1 - level)} percentile (lower bound): ${fixed(accuracy.lower, 4)}`,
    `Bootstrap ${ordinal(level)} percentile: ${fixed(accuracy.upper, 4)}`,
    `Rule: the ${ordinal(1 - level)} percentile of the paired cluster bootstrap of (atlas accuracy minus grep accuracy) is above ${fixed(-config.marginPoints / 100, 4)}.`,
    '',
  );
  lines.push('## Tokens', '', tableRow('arm', 'sessions', 'total billable', 'mean per session', 'input', 'output', 'cache creation', 'cache read'), tableRow('---', '---', '---', '---', '---', '---', '---', '---'));
  for (const arm of ARM_ORDER) {
    const t = arms[arm].tokens;
    lines.push(tableRow(arm, String(arms[arm].sessions), String(t.total), fixed(t.mean, 1), String(t.input), String(t.output), String(t.cacheCreation), String(t.cacheRead)));
  }
  lines.push(
    '',
    `Paired difference in mean billable tokens per question (atlas minus grep): ${fixed(tokens.observedDiff, 1)}`,
    `Bootstrap ${ordinal(1 - level)} percentile: ${fixed(tokens.lower, 1)}`,
    `Bootstrap ${ordinal(level)} percentile: ${fixed(tokens.upper, 1)}`,
    `Registered rule (${tokens.criterion}): ${tokens.criterion === 'point' ? 'the observed difference is below zero' : `the ${ordinal(level)} percentile is below zero`}.`,
    'Cache read tokens are their own column; they are part of the total billable tokens (D-06).',
    '',
  );
  lines.push('## Tool calls, wall time and cost', '', tableRow('arm', 'tool calls total', 'tool calls mean', 'atlas tool share', 'wall ms total', 'wall ms mean', 'cost USD total', 'cost USD mean'), tableRow('---', '---', '---', '---', '---', '---', '---', '---'));
  for (const arm of ARM_ORDER) {
    const a = arms[arm];
    lines.push(
      tableRow(
        arm,
        String(a.toolCalls.total),
        fixed(a.toolCalls.mean, 2),
        a.atlasToolShare === null ? 'n/a' : pct(a.atlasToolShare),
        String(a.wallMs.total),
        fixed(a.wallMs.mean, 1),
        a.costUsd === null ? 'n/a' : fixed(a.costUsd.total, 4),
        a.costUsd === null ? 'n/a' : fixed(a.costUsd.mean, 4),
      ),
    );
  }
  lines.push('', '## Citations', '', `Sessions on non-abstain questions whose answer carries at least one file:line citation and whose every cited file:line verified. Wilson z ${String(citations.z)}.`, '');
  lines.push(tableRow('arm', 'sessions', 'verifiable', 'rate', 'Wilson lower', 'Wilson upper'), tableRow('---', '---', '---', '---', '---', '---'));
  for (const arm of ARM_ORDER) {
    const c = citations.byArm[arm];
    lines.push(tableRow(arm, String(c.sessions), String(c.verifiable), pct(c.point), pct(c.lower), pct(c.upper)));
  }
  lines.push(
    '',
    `Threshold ${pct(citations.threshold)}, judged on the ${citations.judgedArm} arm.`,
    `Point estimate at or above the threshold: ${citations.citationOkPointEstimate ? 'yes' : 'no'}`,
    `Wilson lower bound at or above the threshold: ${citations.citationOkWilsonLowerBound ? 'yes' : 'no'}`,
    `Registered rule: ${citations.judgedOn}`,
    '',
  );
  lines.push('## Failed sessions', '');
  if (analysis.failedSessions.length === 0) {
    lines.push('None.');
  } else {
    lines.push(tableRow('question', 'arm', 'run', 'status'), tableRow('---', '---', '---', '---'));
    for (const failed of analysis.failedSessions) lines.push(tableRow(failed.questionId, failed.arm, String(failed.run), failed.status));
  }
  lines.push(
    '',
    '## Verdict',
    '',
    `ACCURACY: ${verdicts.accuracy ? 'non-inferior' : 'NOT non-inferior'}`,
    `TOKENS: ${verdicts.tokens ? 'fewer' : 'not fewer'}`,
    `CITATIONS: ${verdicts.citations ? 'ok' : 'below threshold'}`,
    `OVERALL: ${verdicts.overall ? 'MVP met' : 'MVP not met'}`,
  );
  return `${lines.join('\n')}\n`;
}

// RED stubs for Task 3: the pre-registration wiring and the command are not written yet.
export function configFromPrereg(_prereg: Prereg): AnalysisConfig {
  throw new Error('configFromPrereg is implemented in Task 3');
}

export function runCli(_argv: string[], _io: Io, _root: string): Promise<number> {
  return Promise.resolve(99);
}
