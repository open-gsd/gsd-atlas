/**
 * node scripts/cleanroom/compare.ts --original <rows> --replication <rows> [--prereg <file>] [--environment <file>]
 *     [--replication-dir <results dir>] [--out <markdown>] [--json <file>]
 *
 * The interpretation rules of the clean-room replication (plan 03-39, EVL-03, D-04), fixed before any replication
 * data exists, and the side-by-side with the registered scored run. This file is the rule set: Task 9 of the plan
 * fails if it changed after the commit recorded in the progress file.
 *
 * Standing statement. The registered verdict is `OVERALL: MVP not met` in docs/eval/analysis.md. A replication
 * cannot make the MVP met, cannot make it not met, and cannot unblock Phase 4. Only a new registered run that
 * meets the gate does (D-04). The classification is a function of the result rows only (and, optionally, of the
 * stream check of the replication directory), never of the declared differences.
 *
 * Compared quantities (original O against replication R, the same 75 questions and 450 cells):
 *   S1 accuracy difference: per question, atlas run-mean correctness minus grep run-mean correctness.
 *   S2 token difference: per question, atlas mean billable tokens minus grep mean billable tokens.
 *   S3 atlas citation rate: per non-abstain question, the share of atlas runs with a verifiable citation.
 * A1 compares the met or not-met outcome of H1 (accuracy), H2 (tokens) and H3 (citations), each computed by the
 * registered analysis from the frozen block. A2 bootstraps the per-question between-run difference of S1, S2 and
 * S3 over questions (the registered seeded stream and percentile rule) and calls the statistic compatible when
 * zero lies inside the interval.
 *
 * Replication tooling: Node built-ins and the registered `scripts/eval` modules only, never `src/` (D-02).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { analyzeResults, configFromPrereg, isCorrect, isVerifiable } from '../eval/analyze.ts';
import type { CompleteAnalysis } from '../eval/analyze.ts';
import { DEFAULT_PREREG_PATH, readPrereg } from '../eval/prereg.ts';
import type { Prereg } from '../eval/prereg.ts';
import { ResultRowSchema } from '../eval/rows.ts';
import type { Arm, ResultRow } from '../eval/rows.ts';
import { bootstrapDistribution, mean, percentile } from '../eval/stats.ts';
import { checkResultsDir } from './check-chunk.ts';

/** The constants of the between-run bootstrap (A2). The seed is the registered seed. */
export const AGREEMENT_RULES = {
  resamples: 10000,
  seed: 20261017,
  lower: 0.025,
  upper: 0.975,
} as const;

export interface DeclaredDifference {
  readonly id: string;
  readonly label: string;
  /** The original run's value where it is known. */
  readonly original: string;
  /** What the clean room is, or where the value is recorded. */
  readonly replication: string;
}

/**
 * The conditions under which the clean room differs from the original run, declared in advance (user decision
 * 2026-10-18). They are the conditions under test: not confounds to hide and not adjusted away. The Node version
 * of the replication is read from the optional environment file.
 */
export const DECLARED_DIFFERENCES: readonly DeclaredDifference[] = [
  { id: 'node', label: 'Node.js version', original: '26.11.1', replication: 'see environment.json' },
  { id: 'os', label: 'Operating system and architecture', original: 'macOS arm64', replication: 'Debian bookworm x64 (container)' },
  { id: 'limits', label: 'CPU and memory limits', original: 'the maintainer machine, no limits set', replication: 'container limits (see environment.json)' },
  { id: 'user-config', label: 'User-level configuration', original: "the maintainer's account state", replication: 'one neutral notes file' },
  { id: 'network', label: 'Network location', original: 'the maintainer network', replication: 'the Docker host network' },
  { id: 'time', label: 'Time', original: 'the date of the original run (plan 03-35)', replication: 'the date of the replication (see environment.json)' },
];

export type Classification = 'strong-agreement' | 'agreement-with-drift' | 'disagreement' | 'inconclusive';
export type ValidityState = 'valid' | 'degraded' | 'invalid';

export interface Validity {
  readonly state: ValidityState;
  readonly reasons: readonly string[];
}

export interface Outcome {
  readonly original: boolean;
  readonly replication: boolean;
  readonly agree: boolean;
}

export interface A1 {
  readonly accuracy: Outcome;
  readonly tokens: Outcome;
  readonly citations: Outcome;
}

export interface Compatibility {
  readonly id: 'S1' | 'S2' | 'S3';
  readonly name: string;
  readonly original: number;
  readonly replication: number;
  /** The mean over questions of the per-question difference (replication minus original). */
  readonly difference: number;
  readonly lower: number;
  readonly upper: number;
  readonly compatible: boolean;
  readonly questions: number;
}

export interface A2 {
  readonly accuracy: Compatibility;
  readonly tokens: Compatibility;
  readonly citations: Compatibility;
}

export interface Pair<T> {
  readonly original: T;
  readonly replication: T;
}

export interface Share {
  readonly sessions: number;
  readonly of: number;
  readonly rate: number;
}

export interface CategoryRow {
  readonly category: string;
  readonly accuracyAtlas: Pair<number>;
  readonly accuracyGrep: Pair<number>;
  readonly tokenRatio: Pair<number | null>;
}

export interface Reported {
  readonly tokenRatio: Pair<number>;
  readonly meanTokens: Record<Arm, Pair<number>>;
  readonly citations: Record<Arm, Pair<{ readonly verifiable: number; readonly sessions: number; readonly rate: number }>>;
  readonly atlasToolUse: Pair<Share>;
  readonly skillLoads: Pair<Share>;
  readonly costUsd: Pair<number>;
  readonly meanWallMs: Record<Arm, Pair<number>>;
  readonly failedSessions: Record<Arm, Pair<number>>;
  readonly categories: readonly CategoryRow[];
  /** Cells whose outcome differs between the two runs, per arm: the noise floor. */
  readonly flips: Record<Arm, { readonly correctness: number; readonly citation: number }>;
}

export interface Comparison {
  readonly classification: Classification;
  readonly validity: Validity;
  readonly a1: A1 | null;
  readonly a2: A2 | null;
  /** Criteria (accuracy, tokens, citations) whose outcome differs. */
  readonly disagreements: readonly string[];
  /** Statistics (accuracy, tokens, citations) whose between-run interval excludes zero. */
  readonly drift: readonly string[];
  readonly reported: Reported;
  readonly rules: typeof AGREEMENT_RULES;
  readonly preregStatus: string;
}

export interface CompareOptions {
  /** Further reasons that make the replication invalid (for example the stop findings of its stream check). */
  readonly invalidReasons?: readonly string[];
}

const ARMS: readonly Arm[] = ['atlas', 'grep'];

const idOf = (row: { questionId: string; arm: string; run: number }): string => `${row.questionId}|${row.arm}|${String(row.run)}`;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function expectedIds(rows: readonly ResultRow[], runs: number): { questionIds: string[]; cells: Set<string> } {
  const questionIds = [...new Set(rows.map((row) => row.questionId))].sort(compareText);
  const cells = new Set<string>();
  for (const questionId of questionIds) for (const arm of ARMS) for (let run = 1; run <= runs; run += 1) cells.add(idOf({ questionId, arm, run }));
  return { questionIds, cells };
}

function shown(items: readonly string[]): string {
  const head = items.slice(0, 5).join(', ');
  return items.length > 5 ? `${head} and ${String(items.length - 5)} more` : head;
}

function validityOf(original: readonly ResultRow[], replication: readonly ResultRow[], prereg: Prereg, extra: readonly string[]): Validity {
  const runs = prereg.params.runsPerCell;
  const { questionIds, cells } = expectedIds(original, runs);
  const invalid: string[] = [];
  if (replication.length !== cells.size) invalid.push(`${String(replication.length)} rows, expected ${String(cells.size)}`);
  const seen = new Map<string, number>();
  for (const row of replication) seen.set(idOf(row), (seen.get(idOf(row)) ?? 0) + 1);
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id).sort();
  if (duplicates.length > 0) invalid.push(`duplicate cells: ${shown(duplicates)}`);
  const outside = [...seen.keys()].filter((id) => !cells.has(id)).sort();
  if (outside.length > 0) invalid.push(`cells outside the registered set: ${shown(outside)}`);
  const missing = [...cells].filter((id) => !seen.has(id)).sort();
  if (missing.length > 0) invalid.push(`missing cells: ${shown(missing)}`);
  const categoryOf = new Map(original.map((row) => [row.questionId, row.category]));
  const changed = replication.filter((row) => categoryOf.has(row.questionId) && categoryOf.get(row.questionId) !== row.category).map((row) => row.questionId);
  const unknown = [...new Set(replication.map((row) => row.questionId))].filter((id) => !questionIds.includes(id));
  if (changed.length > 0 || unknown.length > 0) invalid.push(`the question set differs from the registered one (${shown([...new Set([...changed, ...unknown])].sort())})`);
  invalid.push(...extra);
  if (invalid.length > 0) return { state: 'invalid', reasons: invalid };
  const byStatus = new Map<string, number>();
  for (const row of replication) if (row.status !== 'ok') byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  if (byStatus.size > 0) {
    const parts = [...byStatus].sort().map(([status, count]) => `${status}: ${String(count)}`);
    return { state: 'degraded', reasons: [`sessions that ended other than ok (${parts.join(', ')})`] };
  }
  return { state: 'valid', reasons: [] };
}

function analyze(rows: readonly ResultRow[], prereg: Prereg, questionIds: readonly string[]): CompleteAnalysis {
  const analysis = analyzeResults(rows, configFromPrereg(prereg), { questionIds, arms: ARMS, runsPerCell: prereg.params.runsPerCell });
  if (!analysis.complete) throw new Error('the rows are not a complete registered run');
  return analysis;
}

function rowsBy(rows: readonly ResultRow[], questionId: string, arm: Arm): ResultRow[] {
  return rows.filter((row) => row.questionId === questionId && row.arm === arm);
}

interface Series {
  readonly questionIds: string[];
  readonly accuracy: number[];
  readonly tokens: number[];
  /** Non-abstain questions only. */
  readonly citationIds: string[];
  readonly citations: number[];
}

function seriesOf(rows: readonly ResultRow[], questionIds: readonly string[]): Series {
  const accuracy: number[] = [];
  const tokens: number[] = [];
  const citationIds: string[] = [];
  const citations: number[] = [];
  for (const questionId of questionIds) {
    const atlas = rowsBy(rows, questionId, 'atlas');
    const grep = rowsBy(rows, questionId, 'grep');
    accuracy.push(mean(atlas.map((row) => (isCorrect(row) ? 1 : 0))) - mean(grep.map((row) => (isCorrect(row) ? 1 : 0))));
    tokens.push(mean(atlas.map((row) => row.billableTokens)) - mean(grep.map((row) => row.billableTokens)));
    if ((atlas[0] as ResultRow).category !== 'abstain') {
      citationIds.push(questionId);
      citations.push(mean(atlas.map((row) => (isVerifiable(row) ? 1 : 0))));
    }
  }
  return { questionIds: [...questionIds], accuracy, tokens, citationIds, citations };
}

function compatibility(id: 'S1' | 'S2' | 'S3', name: string, original: readonly number[], replication: readonly number[], rules: typeof AGREEMENT_RULES): Compatibility {
  const diffs = replication.map((value, index) => value - (original[index] as number));
  const distribution = bootstrapDistribution(diffs, rules.resamples, rules.seed);
  const lower = percentile(distribution, rules.lower);
  const upper = percentile(distribution, rules.upper);
  return {
    id,
    name,
    original: mean(original),
    replication: mean(replication),
    difference: mean(diffs),
    lower,
    upper,
    compatible: lower <= 0 && upper >= 0,
    questions: diffs.length,
  };
}

function share(rows: readonly ResultRow[], predicate: (row: ResultRow) => boolean): Share {
  const sessions = rows.filter(predicate).length;
  return { sessions, of: rows.length, rate: rows.length === 0 ? 0 : sessions / rows.length };
}

function armMean(rows: readonly ResultRow[], arm: Arm, pick: (row: ResultRow) => number): number {
  const mine = rows.filter((row) => row.arm === arm);
  return mine.length === 0 ? 0 : mean(mine.map(pick));
}

function citationOf(rows: readonly ResultRow[], arm: Arm): { verifiable: number; sessions: number; rate: number } {
  const eligible = rows.filter((row) => row.arm === arm && row.category !== 'abstain');
  const verifiable = eligible.filter(isVerifiable).length;
  return { verifiable, sessions: eligible.length, rate: eligible.length === 0 ? 0 : verifiable / eligible.length };
}

function flipsOf(original: readonly ResultRow[], replication: readonly ResultRow[]): Reported['flips'] {
  const byCell = new Map(replication.map((row) => [idOf(row), row]));
  const out = { atlas: { correctness: 0, citation: 0 }, grep: { correctness: 0, citation: 0 } };
  for (const row of original) {
    const other = byCell.get(idOf(row));
    if (other === undefined) continue;
    if (isCorrect(row) !== isCorrect(other)) out[row.arm].correctness += 1;
    if (isVerifiable(row) !== isVerifiable(other)) out[row.arm].citation += 1;
  }
  return out;
}

function reportedOf(original: readonly ResultRow[], replication: readonly ResultRow[]): Reported {
  const both = (pick: (rows: readonly ResultRow[]) => number): Pair<number> => ({ original: pick(original), replication: pick(replication) });
  const ratio = (rows: readonly ResultRow[]): number => {
    const grep = armMean(rows, 'grep', (row) => row.billableTokens);
    return grep === 0 ? 0 : armMean(rows, 'atlas', (row) => row.billableTokens) / grep;
  };
  const atlas = (rows: readonly ResultRow[]): ResultRow[] => rows.filter((row) => row.arm === 'atlas');
  const categories = [...new Set(original.map((row) => row.category))].sort(compareText).map((category): CategoryRow => {
    const accuracy = (rows: readonly ResultRow[], arm: Arm): number => {
      const mine = rows.filter((row) => row.category === category && row.arm === arm);
      return mine.length === 0 ? 0 : mean(mine.map((row) => (isCorrect(row) ? 1 : 0)));
    };
    const categoryRatio = (rows: readonly ResultRow[]): number | null => {
      const inCategory = rows.filter((row) => row.category === category);
      const grep = armMean(inCategory, 'grep', (row) => row.billableTokens);
      return grep === 0 ? null : armMean(inCategory, 'atlas', (row) => row.billableTokens) / grep;
    };
    return {
      category,
      accuracyAtlas: { original: accuracy(original, 'atlas'), replication: accuracy(replication, 'atlas') },
      accuracyGrep: { original: accuracy(original, 'grep'), replication: accuracy(replication, 'grep') },
      tokenRatio: { original: categoryRatio(original), replication: categoryRatio(replication) },
    };
  });
  return {
    tokenRatio: both(ratio),
    meanTokens: {
      atlas: both((rows) => armMean(rows, 'atlas', (row) => row.billableTokens)),
      grep: both((rows) => armMean(rows, 'grep', (row) => row.billableTokens)),
    },
    citations: {
      atlas: { original: citationOf(original, 'atlas'), replication: citationOf(replication, 'atlas') },
      grep: { original: citationOf(original, 'grep'), replication: citationOf(replication, 'grep') },
    },
    atlasToolUse: { original: share(atlas(original), (row) => row.atlasToolCalls > 0), replication: share(atlas(replication), (row) => row.atlasToolCalls > 0) },
    skillLoads: {
      original: share(atlas(original), (row) => (row.toolCallsByName['Skill'] ?? 0) > 0),
      replication: share(atlas(replication), (row) => (row.toolCallsByName['Skill'] ?? 0) > 0),
    },
    costUsd: both((rows) => rows.reduce((total, row) => total + (row.costUsd ?? 0), 0)),
    meanWallMs: {
      atlas: both((rows) => armMean(rows, 'atlas', (row) => row.wallMs)),
      grep: both((rows) => armMean(rows, 'grep', (row) => row.wallMs)),
    },
    failedSessions: {
      atlas: both((rows) => rows.filter((row) => row.arm === 'atlas' && row.status !== 'ok').length),
      grep: both((rows) => rows.filter((row) => row.arm === 'grep' && row.status !== 'ok').length),
    },
    categories,
    flips: flipsOf(original, replication),
  };
}

const outcome = (original: boolean, replication: boolean): Outcome => ({ original, replication, agree: original === replication });

/**
 * Compares a replication with the original under the pre-declared rules: validity first, then A1 and A2, then the
 * class. `original` must be the complete registered run (it is analysed by the registered code and a run that is
 * not complete is an error, not a classification).
 */
export function compareRuns(original: readonly ResultRow[], replication: readonly ResultRow[], prereg: Prereg, options: CompareOptions = {}): Comparison {
  const { questionIds } = expectedIds(original, prereg.params.runsPerCell);
  if (questionIds.length !== prereg.questionSet.count) {
    throw new Error(`the original rows hold ${String(questionIds.length)} questions, the registration ${String(prereg.questionSet.count)}`);
  }
  const originalAnalysis = analyze(original, prereg, questionIds);
  const validity = validityOf(original, replication, prereg, options.invalidReasons ?? []);
  const reported = reportedOf(original, replication);
  const base = { validity, reported, rules: AGREEMENT_RULES, preregStatus: prereg.status };
  if (validity.state === 'invalid') {
    return { ...base, classification: 'inconclusive', a1: null, a2: null, disagreements: [], drift: [] };
  }
  const replicationAnalysis = analyze(replication, prereg, questionIds);
  const a1: A1 = {
    accuracy: outcome(originalAnalysis.verdicts.accuracy, replicationAnalysis.verdicts.accuracy),
    tokens: outcome(originalAnalysis.verdicts.tokens, replicationAnalysis.verdicts.tokens),
    citations: outcome(originalAnalysis.verdicts.citations, replicationAnalysis.verdicts.citations),
  };
  const so = seriesOf(original, questionIds);
  const sr = seriesOf(replication, questionIds);
  const a2: A2 = {
    accuracy: compatibility('S1', 'accuracy difference (atlas minus grep)', so.accuracy, sr.accuracy, AGREEMENT_RULES),
    tokens: compatibility('S2', 'billable-token difference (atlas minus grep)', so.tokens, sr.tokens, AGREEMENT_RULES),
    citations: compatibility('S3', 'atlas citation rate', so.citations, sr.citations, AGREEMENT_RULES),
  };
  const names = ['accuracy', 'tokens', 'citations'] as const;
  const disagreements = names.filter((name) => !a1[name].agree);
  const drift = names.filter((name) => !a2[name].compatible);
  let classification: Classification;
  if (validity.state === 'degraded') classification = 'inconclusive';
  else if (disagreements.length > 0) classification = 'disagreement';
  else if (drift.length > 0) classification = 'agreement-with-drift';
  else classification = 'strong-agreement';
  return { ...base, classification, a1, a2, disagreements, drift };
}

// ---------------------------------------------------------------------------------------------
// The markdown

export interface Environment {
  readonly node?: string;
}

const STANDING_STATEMENT =
  'The registered verdict is `OVERALL: MVP not met` in `docs/eval/analysis.md`. A replication cannot make the MVP met, cannot make it not met, ' +
  'and cannot unblock Phase 4. Only a new registered run that meets the gate does (D-04). Everything below is supplementary evidence about ' +
  "whether the measured quantities depend on the maintainer's machine and configuration, and is never pooled with the original run.";

const WHAT_IT_TRIGGERS: Record<Classification, string> = {
  'strong-agreement':
    "Within the limits stated in the report, the registered result did not depend on the maintainer's machine or configuration. The registered verdict is the default at the review.",
  'agreement-with-drift': 'The criteria agree and some statistics moved; the report names which. The review is informational.',
  disagreement:
    'At least one registered criterion came out differently under the declared conditions. A human review is required before the plan ends; at most a new registered run follows, through the Deviations policy. Nothing is rerun or re-scored.',
  inconclusive: 'The replication is invalid or degraded and is not interpreted. The report states the cause and the numbers.',
};

function fixed(x: number, digits: number): string {
  const text = x.toFixed(digits);
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}
const signed = (x: number, digits: number): string => (x > 0 ? `+${fixed(x, digits)}` : fixed(x, digits));
const percent = (x: number): string => `${fixed(x * 100, 1)}%`;
const row = (...cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

/** The side-by-side as markdown. It opens with the declared differences; the class is a function of the rows only. */
export function renderComparison(comparison: Comparison, environment: Environment = {}): string {
  const lines: string[] = ['# Clean-room replication: side-by-side with the registered run', ''];
  lines.push('## Declared differences', '', row('condition', 'original run', 'replication'), row('---', '---', '---'));
  for (const entry of DECLARED_DIFFERENCES) {
    const replication = entry.id === 'node' && environment.node !== undefined && environment.node !== '' ? environment.node : entry.replication;
    lines.push(row(entry.label, entry.original, replication));
  }
  lines.push(
    '',
    'These are declared conditions, fixed before any replication data existed: they are the conditions under test, neither corrected for nor isolated. ' +
      'The classification below is a function of the result rows only.',
    '',
    `classification: ${comparison.classification}`,
    '',
    STANDING_STATEMENT,
    '',
    `What it triggers: ${WHAT_IT_TRIGGERS[comparison.classification]}`,
    '',
    '## Validity',
    '',
    `Validity: ${comparison.validity.state}.`,
  );
  for (const reason of comparison.validity.reasons) lines.push(`- ${reason}`);
  if (comparison.validity.state !== 'valid') lines.push('', 'Neither an invalid nor a degraded replication is interpreted; any figure below is reported, not read.');
  if (comparison.a1 !== null && comparison.a2 !== null) {
    const a1 = comparison.a1;
    lines.push('', '## A1: the outcome of each registered criterion', '', row('criterion', 'original', 'replication', 'agree'), row('---', '---', '---', '---'));
    const met = (value: boolean): string => (value ? 'met' : 'not met');
    for (const [name, label] of [['accuracy', 'H1 accuracy'], ['tokens', 'H2 tokens'], ['citations', 'H3 citations']] as const) {
      lines.push(row(label, met(a1[name].original), met(a1[name].replication), a1[name].agree ? 'yes' : 'NO'));
    }
    lines.push(
      '',
      `## A2: the between-run difference per statistic (${String(comparison.rules.resamples)} resamples over questions, seed ${String(comparison.rules.seed)}, ${fixed(comparison.rules.lower * 100, 1)}th to ${fixed(comparison.rules.upper * 100, 1)}th percentile)`,
      '',
      row('statistic', 'original', 'replication', 'difference', 'lower', 'upper', 'compatible'),
      row('---', '---', '---', '---', '---', '---', '---'),
    );
    for (const key of ['accuracy', 'tokens', 'citations'] as const) {
      const s = comparison.a2[key];
      const digits = key === 'tokens' ? 1 : 4;
      lines.push(row(`${s.id} ${s.name}`, signed(s.original, digits), signed(s.replication, digits), signed(s.difference, digits), signed(s.lower, digits), signed(s.upper, digits), s.compatible ? 'yes' : 'NO'));
    }
    lines.push('', `Criteria that differ: ${comparison.disagreements.length === 0 ? 'none' : comparison.disagreements.join(', ')}.`, `Statistics that moved: ${comparison.drift.length === 0 ? 'none' : comparison.drift.join(', ')}.`);
  }
  const r = comparison.reported;
  lines.push('', '## Reported quantities (not classified)', '', row('quantity', 'original', 'replication'), row('---', '---', '---'));
  lines.push(row('mean billable tokens, atlas', fixed(r.meanTokens.atlas.original, 1), fixed(r.meanTokens.atlas.replication, 1)));
  lines.push(row('mean billable tokens, grep', fixed(r.meanTokens.grep.original, 1), fixed(r.meanTokens.grep.replication, 1)));
  lines.push(row('token ratio, atlas over grep', fixed(r.tokenRatio.original, 3), fixed(r.tokenRatio.replication, 3)));
  for (const arm of ARMS) {
    const c = r.citations[arm];
    lines.push(row(`${arm} sessions with a verifiable citation`, `${String(c.original.verifiable)} of ${String(c.original.sessions)} (${percent(c.original.rate)})`, `${String(c.replication.verifiable)} of ${String(c.replication.sessions)} (${percent(c.replication.rate)})`));
  }
  const shareText = (s: Share): string => `${String(s.sessions)} of ${String(s.of)} (${percent(s.rate)})`;
  lines.push(row('atlas sessions that called an atlas tool', shareText(r.atlasToolUse.original), shareText(r.atlasToolUse.replication)));
  lines.push(row('atlas sessions that loaded the skill', shareText(r.skillLoads.original), shareText(r.skillLoads.replication)));
  lines.push(row('notional cost, USD', fixed(r.costUsd.original, 4), fixed(r.costUsd.replication, 4)));
  for (const arm of ARMS) lines.push(row(`mean wall time, ${arm}, ms`, fixed(r.meanWallMs[arm].original, 0), fixed(r.meanWallMs[arm].replication, 0)));
  for (const arm of ARMS) lines.push(row(`failed sessions, ${arm}`, String(r.failedSessions[arm].original), String(r.failedSessions[arm].replication)));
  for (const arm of ARMS) {
    lines.push(row(`cells whose correctness differs, ${arm}`, 'n/a', String(r.flips[arm].correctness)));
    lines.push(row(`cells whose citation outcome differs, ${arm}`, 'n/a', String(r.flips[arm].citation)));
  }
  lines.push('', '### Per category', '', row('category', 'accuracy atlas (O / R)', 'accuracy grep (O / R)', 'token ratio (O / R)'), row('---', '---', '---', '---'));
  const ratioText = (value: number | null): string => (value === null ? 'n/a' : fixed(value, 3));
  for (const c of r.categories) {
    lines.push(
      row(
        c.category,
        `${fixed(c.accuracyAtlas.original, 3)} / ${fixed(c.accuracyAtlas.replication, 3)}`,
        `${fixed(c.accuracyGrep.original, 3)} / ${fixed(c.accuracyGrep.replication, 3)}`,
        `${ratioText(c.tokenRatio.original)} / ${ratioText(c.tokenRatio.replication)}`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Command line

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const USAGE =
  'usage: node scripts/cleanroom/compare.ts --original <rows> --replication <rows> [--prereg <file>] [--environment <environment.json>]\n' +
  '           [--replication-dir <results dir>] [--out <markdown>] [--json <file>]\n' +
  '\n' +
  'Compares a replication with the original under the pre-declared rules and prints `classification: <class>`\n' +
  '(strong-agreement, agreement-with-drift, disagreement or inconclusive). --out writes the side-by-side markdown, --json the\n' +
  'comparison. --replication-dir adds the stop findings of the replication stream check (hook events, init signatures, paid usage,\n' +
  'infrastructure failures, credential access) as reasons that make the replication invalid. Exit 0 for any class, 2 on an error.\n';

function readRows(file: string): ResultRow[] {
  const rows: ResultRow[] = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${path.basename(file)} line ${String(index + 1)}: not valid JSON`);
      }
      const parsed = ResultRowSchema.safeParse(value);
      if (!parsed.success) throw new Error(`${path.basename(file)} line ${String(index + 1)}: not a valid result row`);
      rows.push(parsed.data);
    });
  return rows;
}

/** Stop findings of the stream check that make a replication invalid; `non_ok_session` degrades through the rows instead. */
const INVALIDATING_CODES: ReadonlySet<string> = new Set([
  'infrastructure_failure',
  'retry_used',
  'contaminated',
  'prep_failed',
  'init_mismatch',
  'hook_event',
  'rate_limit_rejected',
  'overage_in_use',
  'overage_enabled',
  'credential_access',
  'stream_missing',
]);

function readEnvironment(file: string): Environment {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the environment file must hold a JSON object');
  const node = (value as Record<string, unknown>)['node'];
  return typeof node === 'string' ? { node } : {};
}

/** The command body with injectable output; returns the exit code (0 for any class, 2 on an error). */
export function runCli(argv: string[], io: Io, root: string): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        original: { type: 'string' },
        replication: { type: 'string' },
        prereg: { type: 'string' },
        environment: { type: 'string' },
        'replication-dir': { type: 'string' },
        out: { type: 'string' },
        json: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`compare: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values['help'] === true) {
    io.out(USAGE);
    return 0;
  }
  if (typeof values['original'] !== 'string' || typeof values['replication'] !== 'string') {
    io.err(`compare: --original and --replication are required\n${USAGE}`);
    return 2;
  }
  try {
    const preregFile = typeof values['prereg'] === 'string' ? path.resolve(values['prereg']) : path.resolve(root, DEFAULT_PREREG_PATH);
    const prereg = readPrereg(preregFile);
    const original = readRows(path.resolve(values['original']));
    const replication = readRows(path.resolve(values['replication']));
    const extra: string[] = [];
    if (typeof values['replication-dir'] === 'string') {
      const checked = checkResultsDir({ outDir: path.resolve(values['replication-dir']), final: true });
      for (const finding of checked.findings) {
        if (finding.severity === 'stop' && INVALIDATING_CODES.has(finding.code)) extra.push(`${finding.code}: ${finding.detail}`);
      }
    }
    const comparison = compareRuns(original, replication, prereg, { invalidReasons: extra });
    const environment = typeof values['environment'] === 'string' ? readEnvironment(path.resolve(values['environment'])) : {};
    io.out(`classification: ${comparison.classification}\n`);
    io.out(`validity: ${comparison.validity.state}\n`);
    for (const reason of comparison.validity.reasons) io.out(`validity reason: ${reason}\n`);
    if (comparison.disagreements.length > 0) io.out(`criteria that differ: ${comparison.disagreements.join(', ')}\n`);
    if (comparison.drift.length > 0) io.out(`statistics that moved: ${comparison.drift.join(', ')}\n`);
    if (typeof values['out'] === 'string') {
      fs.mkdirSync(path.dirname(path.resolve(values['out'])), { recursive: true });
      fs.writeFileSync(path.resolve(values['out']), renderComparison(comparison, environment));
    }
    if (typeof values['json'] === 'string') {
      fs.mkdirSync(path.dirname(path.resolve(values['json'])), { recursive: true });
      fs.writeFileSync(path.resolve(values['json']), `${JSON.stringify(comparison, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    io.err(`compare: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    path.resolve(import.meta.dirname, '..', '..'),
  );
}
