/**
 * Pure parts of the angular pilot driver (UNSCORED, UNREGISTERED; plan sections 4 to 6): the three-condition
 * schedule, chunking, the calibration batch, the closed-book control, the comparison of an answer with its key,
 * the per-chunk checks and the dry-run text. Nothing here spawns a process or reads a credential.
 */
import { createHash } from 'node:crypto';

import { buildClaudeArgs } from '../eval/claude-session.ts';
import type { SessionSpec } from '../eval/claude-session.ts';
import { makeSchedule, type ArmName } from '../eval/schedule.ts';
import { matchSets, projectItems, type ScoredItem } from '../eval/score.ts';
import { planFor, type ConfigId } from '../probes/configs.ts';

export const SEED = 20261021;
export const CLAUDE_VERSION = '2.1.305';
export const MODEL = 'claude-sonnet-5-5';
export const SESSION_BUDGET_USD = 1.5;
export const CLOSED_BOOK_BUDGET_USD = 0.5;
export const WALL_CLOCK_MS = 600_000;
export const DEFAULT_CAP_USD = 4;
export const CAP_CEILING_USD = 30;
export const RATE_STOP = 0.6;
export const PREMISE = { floorBillable: 68_000, failedBelow: 55_000, p3GrepMean: 45_242, stopLineMultiple: 4 } as const;
export const AUTH_FILTER = 'loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max';

export type ConditionId = 'G' | 'A-ts' | 'A-reg';
export const CONDITIONS: readonly { id: ConditionId; config: ConfigId; label: string }[] = [
  { id: 'G', config: 'grep', label: 'grep arm as registered' },
  { id: 'A-ts', config: 'atlas-noskill-ts', label: 'atlas, tools deferred through ToolSearch, no skill' },
  { id: 'A-reg', config: 'atlas', label: 'atlas as registered' },
];
const CONFIG_OF = new Map(CONDITIONS.map((c) => [c.id, c.config] as const));

export interface PilotJob {
  jobId: string;
  condition: ConditionId;
  config: ConfigId;
  questionId: string;
  run: number;
  /** Index of the adjacent (question, run) group of three. */
  group: number;
}

function toJobs(prefix: string, cells: readonly { questionId: string; arm: string; run: number }[]): PilotJob[] {
  return cells.map((c, i) => {
    const condition = c.arm as ConditionId;
    return { jobId: `${prefix}-${condition}-${c.questionId}-r${String(c.run)}`, condition, config: CONFIG_OF.get(condition)!, questionId: c.questionId, run: c.run, group: Math.floor(i / CONDITIONS.length) };
  });
}

const ARMS = CONDITIONS.map((c) => c.id) as unknown as readonly ArmName[];

/** 16 questions x 3 conditions x 2 runs; each (question, run) is one adjacent group in random order, groups shuffled with the seed. */
export function buildSchedule(questionIds: readonly string[], opts: { seed?: number; runs?: number } = {}): PilotJob[] {
  return toJobs('ang', makeSchedule(questionIds, ARMS, opts.runs ?? 2, opts.seed ?? SEED));
}

/** Chunks of at most `size` sessions made of whole groups (size 16 gives 5 groups, 15 sessions). */
export function chunkSchedule(jobs: readonly PilotJob[], size = 16): PilotJob[][] {
  const per = Math.max(1, Math.floor(size / CONDITIONS.length)) * CONDITIONS.length;
  const out: PilotJob[][] = [];
  for (let i = 0; i < jobs.length; i += per) out.push(jobs.slice(i, i + per));
  return out;
}

const hashOf = (seed: number, tag: string, id: string): string => createHash('sha256').update(`${String(seed)}\0${tag}\0${id}`).digest('hex');

export const CALIBRATION_QUOTA: Readonly<Record<string, number>> = { callers: 2, references: 1, heritage: 1 };

/**
 * The 12-session calibration batch: 4 questions (two callers, one references, one heritage; the first by seeded
 * hash in each category) x the 3 conditions x 1 run, in the seeded group order.
 */
export function calibrationBatch(questions: readonly { id: string; category: string }[], seed = SEED): { jobs: PilotJob[]; questionIds: string[]; measures: string[] } {
  const ids: string[] = [];
  for (const [category, n] of Object.entries(CALIBRATION_QUOTA)) {
    const pool = questions.filter((q) => q.category === category).map((q) => q.id).sort((a, b) => (hashOf(seed, 'calibration', a) < hashOf(seed, 'calibration', b) ? -1 : 1));
    ids.push(...pool.slice(0, n));
  }
  const jobs = toJobs('cal', makeSchedule(ids, ARMS, 1, seed));
  return {
    jobs,
    questionIds: ids,
    measures: [
      `grep (G) mean billable tokens against the premise floor of ${String(PREMISE.floorBillable)} (holds at or above it, failed below ${String(PREMISE.failedBelow)}), and against the stop line of ${String(PREMISE.stopLineMultiple)} x the gsd-core P3 grep mean (${String(PREMISE.p3GrepMean * PREMISE.stopLineMultiple)})`,
      'atlas call rate: the share of A-ts and A-reg sessions with at least one atlas tool call',
      'Max-allowance readings: five-hour and seven-day utilisation before and after the batch, per notional USD',
      'notional cost per session by condition, to confirm or lower the whole-pilot cap before the owner raises it',
    ],
  };
}

/** A calibration schedule for exactly the given question ids: each id x the 3 conditions x 1 run, in the seeded group order. */
export function calibrationJobsFor(questionIds: readonly string[], seed = SEED): PilotJob[] {
  return toJobs('cal', makeSchedule(questionIds, ARMS, 1, seed));
}

export interface ClosedBookJob {
  jobId: string;
  questionId: string;
  run: number;
}

export function closedBookJobs(questionIds: readonly string[]): ClosedBookJob[] {
  return questionIds.map((questionId) => ({ jobId: `cb-${questionId}-r1`, questionId, run: 1 }));
}

/** The closed-book session: no built-in tool, no MCP server content, no skill; run in an empty working directory. */
export function closedBookSpec(ctx: { mcpConfigPath: string; answerSchema: string; model: string; maxBudgetUsd: number; wallClockMs: number }): Omit<SessionSpec, 'prompt' | 'cwd'> {
  return { mcpConfigPath: ctx.mcpConfigPath, jsonSchema: ctx.answerSchema, model: ctx.model, maxBudgetUsd: ctx.maxBudgetUsd, wallClockMs: ctx.wallClockMs, tools: [], allowedTools: [], pluginDirs: [] };
}

export const CLOSED_BOOK_MCP_CONFIG = '{"mcpServers":{}}';

// ---------------------------------------------------------------------------------------------
// Answers and keys

export interface PilotAnswer {
  answer: 'found' | 'not_found';
  items: { file: string; line?: number; symbol?: string }[];
}
export interface KeyEntry {
  abstain: boolean;
  granularity: 'file' | 'file+symbol' | 'file+line';
  items: { file?: string; line?: number; symbol?: string }[];
}
export interface KeyComparison {
  equal: boolean;
  matched: number;
  missing: number;
  extra: number;
  answered: 'found' | 'not_found';
}

const scored = (items: readonly { file?: string; line?: number; symbol?: string }[]): ScoredItem[] =>
  items.flatMap((i) => (i.file === undefined ? [] : [{ file: i.file, ...(i.line === undefined ? {} : { line: i.line }), ...(i.symbol === undefined ? {} : { symbol: i.symbol }) }]));

/** Exact-set equality at the key's granularity (registered matching rules, read-only reuse) with descriptive counts. */
export function compareAnswer(ans: PilotAnswer, key: KeyEntry): KeyComparison {
  if (key.abstain) {
    return { equal: ans.answer === 'not_found' && ans.items.length === 0, matched: 0, missing: 0, extra: ans.items.length, answered: ans.answer };
  }
  const keyItems = projectItems(scored(key.items), key.granularity);
  if (ans.answer === 'not_found') return { equal: false, matched: 0, missing: keyItems.length, extra: 0, answered: ans.answer };
  const given = projectItems(scored(ans.items), key.granularity);
  const m = matchSets(keyItems, given, key.granularity);
  return { equal: m.missing.length === 0 && m.extra.length === 0 && given.length > 0, matched: m.matched.length, missing: m.missing.length, extra: m.extra.length, answered: ans.answer };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The final structured answer of a raw stream-json session, with the checkout root and a leading `./` removed from paths. */
export function answerFromStream(text: string, roots: readonly string[]): PilotAnswer | null {
  let result: Record<string, unknown> | undefined;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const e: unknown = JSON.parse(raw);
      if (isRecord(e) && e['type'] === 'result') result = e;
    } catch {
      // a line cut off mid-write
    }
  }
  if (result === undefined) return null;
  let value: unknown = result['structured_output'];
  if (!isRecord(value) && typeof result['result'] === 'string') {
    try {
      value = JSON.parse(result['result']);
    } catch {
      value = undefined;
    }
  }
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const answer = value['answer'];
  if (answer !== 'found' && answer !== 'not_found') return null;
  const items: PilotAnswer['items'] = [];
  for (const it of value['items']) {
    if (!isRecord(it) || typeof it['file'] !== 'string') continue;
    let file = it['file'].trim();
    for (const r of roots) {
      const prefix = r.endsWith('/') ? r : `${r}/`;
      if (file.startsWith(prefix)) file = file.slice(prefix.length);
    }
    while (file.startsWith('./')) file = file.slice(2);
    items.push({ file, ...(typeof it['line'] === 'number' ? { line: it['line'] } : {}), ...(typeof it['symbol'] === 'string' ? { symbol: it['symbol'] } : {}) });
  }
  return { answer, items };
}

// ---------------------------------------------------------------------------------------------
// Guards

export interface PilotRecord {
  jobId: string;
  condition: ConditionId | 'CB';
  status: string;
  claudeCodeVersion: string | null;
  apiKeySource: string | null;
  initMcpToolCount: number | null;
  atlasCalls: number;
  usage: { billable: number };
  costUsd: number | null;
  rate: { fiveHour: number | null; sevenDay: number | null; isUsingOverage: boolean | null; overageStatus: string | null };
}

export interface ChunkCheckContext {
  capUsd: number;
  spentBefore: number;
  nextMaxUsd: number;
  expectedVersion: string;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** The check after each chunk: any infrastructure failure, any rate reading at 0.60, overage, API key, version, environment, cap. */
export function chunkCheck(records: readonly PilotRecord[], ctx: ChunkCheckContext): { stop: boolean; reasons: string[]; infraFailures: number; spentUsd: number } {
  const reasons: string[] = [];
  const failures = records.filter((r) => r.status !== 'ok');
  if (failures.length > 0) reasons.push(`infrastructure failure in ${String(failures.length)} session(s): ${failures.map((f) => f.jobId).join(', ')}`);
  let readings = 0;
  for (const r of records) {
    const { fiveHour, sevenDay, isUsingOverage, overageStatus } = r.rate;
    if (fiveHour !== null || sevenDay !== null || isUsingOverage !== null || overageStatus !== null) {
      readings += 1;
      if (fiveHour !== null && fiveHour >= RATE_STOP) reasons.push(`five-hour utilisation ${String(fiveHour)} at or over ${RATE_STOP.toFixed(2)} (${r.jobId})`);
      if (sevenDay !== null && sevenDay >= RATE_STOP) reasons.push(`seven-day utilisation ${String(sevenDay)} at or over ${RATE_STOP.toFixed(2)} (${r.jobId})`);
      if (isUsingOverage !== false) reasons.push(`overage is not off in the reading of ${r.jobId}`);
      if (overageStatus !== 'rejected') reasons.push(`overageStatus is ${String(overageStatus)}, not rejected (${r.jobId})`);
    }
    if (r.apiKeySource !== 'none') reasons.push(`apiKeySource is ${String(r.apiKeySource)}, not none (${r.jobId})`);
    if (r.claudeCodeVersion !== ctx.expectedVersion) reasons.push(`Claude Code ${String(r.claudeCodeVersion)} differs from ${ctx.expectedVersion} (${r.jobId})`);
    if ((r.condition === 'G' || r.condition === 'CB') && ((r.initMcpToolCount ?? 0) > 0 || r.atlasCalls > 0)) reasons.push(`${r.jobId} has atlas tools or calls in a condition without them`);
    if ((r.condition === 'A-ts' || r.condition === 'A-reg') && (r.initMcpToolCount ?? 0) === 0) reasons.push(`${r.jobId} lists no atlas tool in its init event`);
  }
  if (records.length > 0 && readings === 0) reasons.push('no rate-limit reading in the chunk; overage and allowance cannot be verified');
  const spentUsd = round6(records.reduce((a, r) => a + (r.costUsd ?? 0), 0));
  if (round6(ctx.spentBefore + spentUsd + ctx.nextMaxUsd) > ctx.capUsd) {
    reasons.push(`notional ${(ctx.spentBefore + spentUsd).toFixed(2)} USD + next session cap ${ctx.nextMaxUsd.toFixed(2)} would pass the cap ${ctx.capUsd.toFixed(2)}`);
  }
  return { stop: reasons.length > 0, reasons, infraFailures: failures.length, spentUsd };
}

/** The four-field filter of `claude auth status`: subscription login only. */
export function authOk(status: unknown): boolean {
  return isRecord(status) && status['loggedIn'] === true && status['authMethod'] === 'claude.ai' && status['apiProvider'] === 'firstParty' && status['subscriptionType'] === 'max';
}

/** The notional cap: low by default, raised only by an explicit value, never above the ceiling. */
export function parseCap(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CAP_USD;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--cap-usd must be a number, got ${value}`);
  if (n <= 0) throw new Error('--cap-usd must be positive');
  if (n > CAP_CEILING_USD) throw new Error(`--cap-usd ${value} is above the ceiling of ${String(CAP_CEILING_USD)} USD`);
  return n;
}

/** Sequential, or two at a time only for a chunk of grep sessions. */
export function resolveConcurrency(requested: number, jobs: readonly { condition: string }[]): 1 | 2 {
  if (requested !== 1 && requested !== 2) throw new Error('concurrency must be 1 or 2');
  return requested === 2 && jobs.length > 0 && jobs.every((j) => j.condition === 'G') ? 2 : 1;
}

export interface CalibrationSummary {
  grepMeanBillable: number | null;
  premise: 'holds' | 'between' | 'failed' | 'unmeasured';
  stopLineExceeded: boolean;
  atlasCallRate: Record<string, number | null>;
  spentUsd: number;
  rate: { firstFiveHour: number | null; lastFiveHour: number | null; firstSevenDay: number | null; lastSevenDay: number | null; sevenDayDeltaPerUsd: number | null };
}

/** What the 12-session batch measures, from its records. */
export function calibrationSummary(records: readonly PilotRecord[]): CalibrationSummary {
  const grep = records.filter((r) => r.condition === 'G');
  const grepMean = grep.length === 0 ? null : grep.reduce((a, r) => a + r.usage.billable, 0) / grep.length;
  const rateOf = (cond: ConditionId): number | null => {
    const rs = records.filter((r) => r.condition === cond);
    return rs.length === 0 ? null : rs.filter((r) => r.atlasCalls > 0).length / rs.length;
  };
  const five = records.map((r) => r.rate.fiveHour).filter((x): x is number => x !== null);
  const seven = records.map((r) => r.rate.sevenDay).filter((x): x is number => x !== null);
  const spentUsd = round6(records.reduce((a, r) => a + (r.costUsd ?? 0), 0));
  return {
    grepMeanBillable: grepMean,
    premise: grepMean === null ? 'unmeasured' : grepMean >= PREMISE.floorBillable ? 'holds' : grepMean < PREMISE.failedBelow ? 'failed' : 'between',
    stopLineExceeded: grepMean !== null && grepMean > PREMISE.p3GrepMean * PREMISE.stopLineMultiple,
    atlasCallRate: { 'A-ts': rateOf('A-ts'), 'A-reg': rateOf('A-reg') },
    spentUsd,
    rate: {
      firstFiveHour: five[0] ?? null,
      lastFiveHour: five.at(-1) ?? null,
      firstSevenDay: seven[0] ?? null,
      lastSevenDay: seven.at(-1) ?? null,
      sevenDayDeltaPerUsd: seven.length >= 2 && spentUsd > 0 ? (seven.at(-1)! - seven[0]!) / spentUsd : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Dry run

function shellQuote(arg: string): string {
  if (arg === '') return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface DryRunInput {
  questions: readonly { id: string; category: string }[];
  capUsd: number;
  concurrency: number;
  model: string;
  claudeVersion: string;
}

export function renderDryRun(input: DryRunInput): string {
  const ids = input.questions.map((q) => q.id);
  const jobs = buildSchedule(ids);
  const chunks = chunkSchedule(jobs, 16);
  const cal = calibrationBatch(input.questions);
  const cb = closedBookJobs(ids);
  const out: string[] = [];
  out.push('DRY RUN: no session is launched, no process is spawned, no credential is read.');
  out.push(`seed ${String(SEED)}; model ${input.model}; Claude Code ${input.claudeVersion}; ${String(ids.length)} questions x ${String(CONDITIONS.length)} conditions x 2 runs = ${String(jobs.length)} sessions in ${String(chunks.length)} chunks`);
  out.push('', 'guards');
  out.push(`  notional cap ${input.capUsd.toFixed(2)} USD (default ${DEFAULT_CAP_USD.toFixed(2)}; the owner raises it with --cap-usd, ceiling ${CAP_CEILING_USD.toFixed(2)})`);
  out.push(`  per-session --max-budget-usd ${String(SESSION_BUDGET_USD)}; stop when spent + next session cap passes the notional cap`);
  out.push(`  stop at ${RATE_STOP.toFixed(2)} on either the five-hour or the seven-day window; overage must be off (isUsingOverage false, overageStatus rejected in every reading)`);
  out.push('  no API key: every ANTHROPIC*/CLAUDE* variable is removed from the child; apiKeySource none in every init event');
  out.push(`  auth: \`claude auth status\` four-field filter before each chunk: ${AUTH_FILTER}`);
  out.push(`  concurrency ${String(input.concurrency)} (sequential; 2 only for a grep-only chunk), every session under nice -n 10`);
  out.push('  after each chunk: stop on any infrastructure failure, a rate reading at the line, overage, an API key, a version or environment mismatch, or the cap');
  out.push('', 'commands (placeholders in angle brackets; the prompt goes on stdin)');
  const ctx = { mcpConfigPath: '<session>/mcp.json', pluginDir: '<session>/plugin', hookScript: '<repo>/scripts/probes/route-hook.ts', answerSchema: '<answer-schema.json>', model: input.model, maxBudgetUsd: SESSION_BUDGET_USD, wallClockMs: WALL_CLOCK_MS };
  const cmd = (label: string, spec: Omit<SessionSpec, 'prompt' | 'cwd'>, prefix: readonly string[] = []): void => {
    const args = [...prefix, ...buildClaudeArgs({ ...spec, prompt: '<prompt>', cwd: '<session>/repo' })];
    out.push(`  command ${label}: nice -n 10 claude ${args.map(shellQuote).join(' ')}`);
  };
  for (const c of CONDITIONS) {
    const plan = planFor(c.config, ctx);
    cmd(c.id, plan.spec, plan.prefixArgs);
  }
  cmd('closed-book', closedBookSpec({ mcpConfigPath: '<session>/mcp.json', answerSchema: '<answer-schema.json>', model: input.model, maxBudgetUsd: CLOSED_BOOK_BUDGET_USD, wallClockMs: WALL_CLOCK_MS }));
  out.push('  (closed-book runs in an empty working directory with an empty MCP configuration; the atlas conditions first build and resolve an index in the session checkout)');
  out.push('', 'closed-book control (the 16 questions once, no repository access)');
  cb.forEach((j, i) => out.push(`  ${String(i + 1).padStart(2, '0')}  ${j.jobId}  ${j.questionId}`));
  out.push('', 'calibration batch (12 sessions before the pilot)');
  for (const m of cal.measures) out.push(`  measures: ${m}`);
  cal.jobs.forEach((j, i) => out.push(`  ${String(i + 1).padStart(2, '0')}  ${j.jobId}  ${j.condition}  ${j.config}`));
  out.push('', 'pilot schedule');
  let n = 0;
  chunks.forEach((chunk, ci) => {
    out.push(`chunk ${String(ci + 1)} of ${String(chunks.length)}: ${String(chunk.length)} sessions`);
    for (const j of chunk) {
      n += 1;
      out.push(`  ${String(n).padStart(3, '0')}  ${j.jobId}  ${j.condition}  ${j.config}  group ${String(j.group)}`);
    }
  });
  return `${out.join('\n')}\n`;
}
