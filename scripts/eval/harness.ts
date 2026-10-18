/**
 * node scripts/eval/harness.ts plan|run|pilot|summary|project ...
 *
 * The eval harness (D-03, D-04, D-06, EVL-02, EVL-03): turns a question set into scored sessions.
 *
 * `runCell` runs one (question, arm, run) cell: it clones the prepared checkout into a session
 * directory of its own, builds the atlas index in that directory for the atlas arm (outside the token
 * count), starts the session through `claude -p` with the arm's tools and an isolated environment,
 * compares the session's `system/init` event with the arm's registered tool set, scores the answer
 * against the oracle key and appends one result row. A cell that already has a row is skipped.
 *
 * Registered failure rules (T-03-104):
 * - A session that reached the model is final, whether it succeeded or failed. It is never retried,
 *   so a bad arm cannot be rerun into a good one. A failed session is an incorrect row that keeps its
 *   tokens.
 * - Only an infrastructure failure (the result reports a rate limit or an overload and no tool call
 *   happened) is retried, at most `MAX_INFRASTRUCTURE_RETRIES` times; every attempt is logged in
 *   `attempts.jsonl`.
 * - A session whose init event differs from the arm's registered environment is stored as a
 *   `contaminated` meta record, is not scored, and stops the run.
 *
 * Eval tooling: it must never import from src/ (D-02). Atlas is only ever run as the built binary.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import {
  ARMS,
  ARM_IDS,
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  MAX_INFRASTRUCTURE_RETRIES,
  allowedToolsFor,
  buildMcpConfig,
  buildPluginDir,
  checkInit,
} from './arms.ts';
import type { ArmId } from './arms.ts';
import { parseStreamText, runClaudeSession } from './claude-session.ts';
import type { ResultEvent, SessionOutcome, SessionSpec, Usage } from './claude-session.ts';
import { DEFAULT_PREREG_PATH, SKILL_PATH, hashFile, readPrereg } from './prereg.ts';
import type { Prereg } from './prereg.ts';
import { cloneCheckout, readPreparedRecord } from './prepare-corpus.ts';
import { AnswerFileSchema, loadQuestions } from './questions.ts';
import type { AnswerKey, Question, QuestionFile } from './questions.ts';
import { ResultsStore, readJsonLines } from './results.ts';
import { ResultRowSchema } from './rows.ts';
import type { ResultRow } from './rows.ts';
import { scoreAnswer, toResultRow } from './score.ts';
import { cellId, makeSchedule } from './schedule.ts';
import type { Cell } from './schedule.ts';
import { verifyPrereg } from './verify-prereg.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

/** Everything `runCell` needs, so a test can point it at fake executables and a fixture checkout. */
export interface CellDeps {
  questions: ReadonlyMap<string, Question>;
  keys: ReadonlyMap<string, AnswerKey>;
  /** The prepared checkout. Never written to; answers are scored against it. */
  corpusDir: string;
  /** Session directories are made under this directory, one per cell. */
  scratchRoot: string;
  store: ResultsStore;
  /** The built CLI (`dist/bin/gsd-atlas.js`), always run through `process.execPath`. */
  atlasBin: string;
  skillPath: string;
  /** The answer schema as one line of JSON, passed to `--json-schema` in both arms. */
  answerSchema: string;
  model?: string;
  maxBudgetUsd: number;
  wallClockMs: number;
  keepSessions?: boolean;
  /** Replaces the `claude` executable; for tests. */
  claude?: { executable?: string; prefixArgs?: string[] };
  /** Extra environment for the children; the atlas store and user directories always win. */
  env?: Record<string, string>;
  /** Upper bound for `build` and `maintain`; none when absent. */
  prepTimeoutMs?: number;
  /** The tsconfig the scorer's context names; citations are checked on disk, so it is never read. */
  tsconfig?: string;
  /** Wait before the retry of an infrastructure failure (default `DEFAULT_RETRY_DELAY_MS`). */
  retryDelayMs?: number;
  /** Replaces the real wait; for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The registered sha256 of the skill file; `buildPluginDir` refuses a skill that differs. */
  skillSha256?: string;
}

export type CellOutcome = 'done' | 'skipped' | 'contaminated' | 'prep_failed';

export interface CellResult {
  outcome: CellOutcome;
  row?: ResultRow;
  /** For `contaminated`: what differed from the arm's registered environment. */
  diffs?: string[];
  /** For `prep_failed`: what failed. */
  detail?: string;
}

/** The one line before the question in both arms. The answer format comes from `--json-schema`. */
export const PROMPT_PREAMBLE =
  'Answer the question about the repository in the current directory. Report file paths relative to the repository root.';

/** The prompt of a cell: the same text for both arms, so a difference in results is not a difference in wording. */
export function buildPrompt(question: Question, _arm: ArmId): string {
  return `${PROMPT_PREAMBLE}\n\n${question.text}`;
}

// ---------------------------------------------------------------------------------------------
// Child processes (the atlas binary, `claude --version`)

interface ProcessResult {
  code: number | null;
  signal: string | null;
  ms: number;
  stdoutTail: string;
  stderrTail: string;
}

const OUTPUT_TAIL = 2_000;

function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number | undefined },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, signal: string | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - started, stdoutTail: stdout, stderrTail: (extra + stderr).slice(-OUTPUT_TAIL) });
    };
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    // No upper bound unless one is given: the largest delay setTimeout accepts.
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 2_147_483_647);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
    });
    child.on('error', (error: Error) => finish(null, null, `${error.message}\n`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------------------------
// Failure classification and usage

/**
 * True when a session failed before the model did any work: the result reports a rate limit or an
 * overload (by status 429 or 529, or by its text) and no tool call happened. This is the only kind of
 * session that is retried.
 */
export function isInfrastructureFailure(result: ResultEvent | null, toolCallTotal: number): boolean {
  if (result === null || !result.isError || toolCallTotal > 0) return false;
  const status = result.raw['api_error_status'];
  if (status === 429 || status === 529) return true;
  return /rate[ _-]?limit|overloaded|\b429\b|\b529\b/i.test(result.text);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const tokenCount = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/**
 * The usage of a session that never printed a result (a timeout or a kill): the usage reported on
 * its assistant messages, one report per message id (the last one wins, because a message is reported
 * more than once while it streams). An approximation, but a failed session keeps its tokens (EVL-03).
 */
function usageFromStream(rawStreamPath: string): Usage {
  let text: string;
  try {
    text = fs.readFileSync(rawStreamPath, 'utf8');
  } catch {
    return ZERO_USAGE;
  }
  const byMessage = new Map<string, Usage>();
  let anonymous = 0;
  for (const event of parseStreamText(text).events) {
    if (event.type !== 'assistant' || !isRecord(event['message'])) continue;
    const message = event['message'];
    const usage = message['usage'];
    if (!isRecord(usage)) continue;
    anonymous += 1;
    const id = typeof message['id'] === 'string' ? message['id'] : `anonymous-${String(anonymous)}`;
    byMessage.set(id, {
      input: tokenCount(usage['input_tokens']),
      output: tokenCount(usage['output_tokens']),
      cacheCreation: tokenCount(usage['cache_creation_input_tokens']),
      cacheRead: tokenCount(usage['cache_read_input_tokens']),
    });
  }
  const total: Usage = { ...ZERO_USAGE };
  for (const usage of byMessage.values()) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheCreation += usage.cacheCreation;
    total.cacheRead += usage.cacheRead;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// One cell

const sessionName = (cell: Cell): string => `${cell.questionId}.${cell.arm}.${String(cell.run)}`.replace(/[^A-Za-z0-9._-]/g, '_');

function atlasCalls(byName: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [name, count] of Object.entries(byName)) if (name.startsWith('mcp__gsd-atlas__')) total += count;
  return total;
}

function rowOf(
  cell: Cell,
  question: Question,
  outcome: SessionOutcome,
  usage: Usage,
  scored: Awaited<ReturnType<typeof scoreAnswer>>,
): ResultRow {
  const partial = {
    questionId: cell.questionId,
    category: question.category,
    arm: cell.arm,
    run: cell.run,
    status: outcome.status,
    usage,
    toolCalls: outcome.toolCallTotal,
    toolCallsByName: outcome.toolCalls,
    atlasToolCalls: atlasCalls(outcome.toolCalls),
    // The wall time of the session that counted: the last attempt.
    wallMs: outcome.wallMs,
    costUsd: outcome.result === null ? null : outcome.result.totalCostUsd,
  };
  return toResultRow(partial, scored);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one cell and appends its row. Returns `skipped` when the cell already has a row. A session
 * whose init event differs from the arm's registered environment is stored as a `contaminated` meta
 * record and is not scored; an index that fails to build is a `prep_failed`. Both stop the run (see
 * `runAll`).
 */
export async function runCell(cell: Cell, deps: CellDeps): Promise<CellResult> {
  const id = cellId(cell);
  if (deps.store.has(id)) return { outcome: 'skipped' };
  const question = deps.questions.get(cell.questionId);
  const key = deps.keys.get(cell.questionId);
  if (question === undefined || key === undefined) {
    throw new HarnessError(`cell ${id}: no question or no answer key for ${cell.questionId}`);
  }

  // A directory left by a killed run belongs to a cell without a row: start from nothing.
  const sessionDir = path.join(deps.scratchRoot, sessionName(cell));
  fs.rmSync(sessionDir, { recursive: true, force: true });
  const repoDir = path.join(sessionDir, 'repo');
  const storeDir = path.join(sessionDir, 'store');
  const userDir = path.join(sessionDir, 'user');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  cloneCheckout(deps.corpusDir, repoDir);
  const env: Record<string, string> = { ...deps.env, GSD_ATLAS_STORE_DIR: storeDir, GSD_ATLAS_USER_DIR: userDir };

  // The index is built before the clock starts and its time is recorded apart from the tokens.
  let prepMs = 0;
  let build: ProcessResult | null = null;
  let maintain: ProcessResult | null = null;
  if (cell.arm === 'atlas') {
    const started = Date.now();
    const prep = { cwd: repoDir, env, timeoutMs: deps.prepTimeoutMs };
    build = await runProcess(process.execPath, [deps.atlasBin, 'build', '--repo', repoDir], prep);
    if (build.code !== 0) {
      const detail = `gsd-atlas build exited ${String(build.code ?? build.signal)}: ${build.stderrTail}`;
      deps.store.appendMeta({ kind: 'prep_failed', cellId: id, sessionDir, detail });
      return { outcome: 'prep_failed', detail };
    }
    // `maintain resolve` may fail until the precise tier exists; its status is recorded and the cell goes on.
    maintain = await runProcess(process.execPath, [deps.atlasBin, 'maintain', 'resolve', '--repo', repoDir], prep);
    prepMs = Date.now() - started;
  }

  const mcpConfigPath = path.join(sessionDir, 'mcp.json');
  buildMcpConfig(cell.arm, { atlasBin: deps.atlasBin, storeDir, userDir, configPath: mcpConfigPath });
  const pluginDirs = cell.arm === 'atlas' ? [buildPluginDir(sessionDir, deps.skillPath, deps.skillSha256)] : [];

  const streamsDir = path.join(deps.store.dir, 'streams');
  fs.mkdirSync(streamsDir, { recursive: true });
  const baseSpec: Omit<SessionSpec, 'rawStreamPath'> = {
    prompt: buildPrompt(question, cell.arm),
    cwd: repoDir,
    tools: [...ARMS[cell.arm].builtinTools],
    allowedTools: allowedToolsFor(cell.arm),
    mcpConfigPath,
    pluginDirs,
    jsonSchema: deps.answerSchema,
    maxBudgetUsd: deps.maxBudgetUsd,
    wallClockMs: deps.wallClockMs,
    env,
    ...(deps.model === undefined ? {} : { model: deps.model }),
    ...(deps.claude?.executable === undefined ? {} : { executable: deps.claude.executable }),
    ...(deps.claude?.prefixArgs === undefined ? {} : { prefixArgs: deps.claude.prefixArgs }),
  };
  const sleep = deps.sleep ?? realSleep;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let attempt = 0;
  let outcome: SessionOutcome;
  let rawStreamPath: string;
  for (;;) {
    attempt += 1;
    rawStreamPath = path.join(streamsDir, `${sessionName(cell)}.a${String(attempt)}.jsonl`);
    outcome = await runClaudeSession({ ...baseSpec, rawStreamPath });

    const infrastructure = isInfrastructureFailure(outcome.result, outcome.toolCallTotal);
    // An attempt that failed before the model worked may have printed no init event; that is not contamination.
    const diffs = infrastructure && outcome.init === null ? [] : checkInit(cell.arm, outcome.init);
    const retry = diffs.length === 0 && infrastructure && attempt <= MAX_INFRASTRUCTURE_RETRIES;
    deps.store.appendAttempt({
      kind: 'attempt',
      cellId: id,
      attempt,
      status: outcome.status,
      infrastructureFailure: infrastructure,
      retried: retry,
      toolCalls: outcome.toolCallTotal,
      wallMs: outcome.wallMs,
      rawStreamPath,
      reason: infrastructure ? (outcome.result?.text ?? '').slice(0, 300) : null,
      at: new Date().toISOString(),
    });
    deps.store.appendMeta({
      kind: 'session',
      cellId: id,
      attempt,
      arm: cell.arm,
      prepMs,
      build: build === null ? null : { code: build.code, ms: build.ms },
      maintain: maintain === null ? null : { code: maintain.code, ms: maintain.ms, stderrTail: maintain.stderrTail },
      sessionDir,
      rawStreamPath,
      status: outcome.status,
      wallMs: outcome.wallMs,
      ignoredLines: outcome.ignoredLines,
      stderrTail: outcome.stderrTail,
      init:
        outcome.init === null
          ? null
          : { tools: outcome.init.tools, mcpServers: outcome.init.mcpServers, skills: outcome.init.skills, model: outcome.init.model },
    });
    if (diffs.length > 0) {
      deps.store.appendMeta({ kind: 'contaminated', cellId: id, attempt, diffs, sessionDir, rawStreamPath });
      return { outcome: 'contaminated', diffs };
    }
    if (!retry) break;
    await sleep(retryDelayMs);
  }

  const scored = await scoreAnswer(question, key, outcome.result?.text ?? '', {
    repoDir: deps.corpusDir,
    tsconfig: deps.tsconfig ?? 'tsconfig.json',
  });
  const usage = outcome.result === null ? usageFromStream(rawStreamPath) : outcome.result.usage;
  const row = rowOf(cell, question, outcome, usage, scored);
  deps.store.append(row);

  if (deps.keepSessions !== true) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      deps.store.appendMeta({
        kind: 'cleanup_failed',
        cellId: id,
        dir: sessionDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { outcome: 'done', row };
}

// ---------------------------------------------------------------------------------------------
// Many cells

export interface RunAllOptions {
  cells: readonly Cell[];
  /** Sessions in flight at once; a worker takes the next cell as soon as it is free. */
  concurrency: number;
  deps: CellDeps;
  /** Called after each cell, in completion order. */
  onCell?: (cell: Cell, result: CellResult) => void;
}

export interface RunSummary {
  total: number;
  done: number;
  skipped: number;
  contaminated: Array<{ cellId: string; diffs: string[] }>;
  prepFailed: Array<{ cellId: string; detail: string }>;
  /** A cell that threw (a defect in the harness or the scorer, never a session outcome). */
  errors: Array<{ cellId: string; message: string }>;
  /** True when scheduling stopped early: a contaminated session, a failed index build or an error. */
  stopped: boolean;
}

/**
 * Runs the cells with at most `concurrency` in flight. A contaminated session, a failed index build or
 * an error stops scheduling: the cells already in flight finish, and no further cell starts.
 */
export async function runAll(options: RunAllOptions): Promise<RunSummary> {
  const summary: RunSummary = {
    total: options.cells.length,
    done: 0,
    skipped: 0,
    contaminated: [],
    prepFailed: [],
    errors: [],
    stopped: false,
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!summary.stopped) {
      const cell = options.cells[next];
      next += 1;
      if (cell === undefined) return;
      let result: CellResult;
      try {
        result = await runCell(cell, options.deps);
      } catch (error) {
        summary.errors.push({ cellId: cellId(cell), message: error instanceof Error ? error.message : String(error) });
        summary.stopped = true;
        return;
      }
      if (result.outcome === 'done') summary.done += 1;
      else if (result.outcome === 'skipped') summary.skipped += 1;
      else if (result.outcome === 'contaminated') {
        summary.contaminated.push({ cellId: cellId(cell), diffs: result.diffs ?? [] });
        summary.stopped = true;
      } else {
        summary.prepFailed.push({ cellId: cellId(cell), detail: result.detail ?? '' });
        summary.stopped = true;
      }
      options.onCell?.(cell, result);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency, options.cells.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Command line: plan, run, pilot

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDeps {
  /** The repository root that holds the registered files; default is this repository. */
  repoRoot?: string;
  /** Extra environment for the claude and atlas children; for tests. */
  env?: Record<string, string>;
  /** Replaces `claude --version`; for tests. */
  claudeVersion?: () => Promise<string>;
  /** Replaces reading `.eval-prepared.json`; for tests. */
  readPrepared?: (dir: string) => { sha: string; npmCi: boolean };
}

const USAGE = [
  'usage: node scripts/eval/harness.ts <command> [options]',
  '  plan    --questions <file> [--arms atlas,grep] [--runs n] [--seed n] [--scored|--pilot] ...',
  '  run     (--scored | --pilot) --questions <file> --answers <file> --corpus-dir <dir> --out-dir <dir> ...',
  '  pilot   the same as run --pilot',
  '  summary --out-dir <dir>                         per-arm totals of a results directory',
  '  project --out-dir <pilot dir> --questions <n> --runs <k>   projected cost and the pilot paired sd',
  'options: --questions --answers --corpus-dir --out-dir --arms --runs --concurrency --seed --model',
  '         --max-budget-usd --wall-clock-ms --atlas-bin --skill --prereg --scored --pilot --dry-run',
  '         --scratch-dir --keep-sessions --retry-delay-ms --prep-timeout-ms',
  '         --claude-executable --claude-prefix-arg (never with --scored)',
  '',
].join('\n');

const OPTIONS = {
  questions: { type: 'string' },
  answers: { type: 'string' },
  'corpus-dir': { type: 'string' },
  'out-dir': { type: 'string' },
  arms: { type: 'string' },
  runs: { type: 'string' },
  concurrency: { type: 'string' },
  seed: { type: 'string' },
  model: { type: 'string' },
  'max-budget-usd': { type: 'string' },
  'wall-clock-ms': { type: 'string' },
  'atlas-bin': { type: 'string' },
  skill: { type: 'string' },
  prereg: { type: 'string' },
  scored: { type: 'boolean' },
  pilot: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'scratch-dir': { type: 'string' },
  'keep-sessions': { type: 'boolean' },
  'retry-delay-ms': { type: 'string' },
  'prep-timeout-ms': { type: 'string' },
  'claude-executable': { type: 'string' },
  'claude-prefix-arg': { type: 'string', multiple: true },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>['values'];

class UsageError extends Error {}

function whole(name: string, text: string, min: number): number {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < min) {
    throw new UsageError(`--${name} must be a whole number of at least ${String(min)}, got "${text}"`);
  }
  return value;
}

function positive(name: string, text: string): number {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value <= 0) throw new UsageError(`--${name} must be a positive number, got "${text}"`);
  return value;
}

async function realClaudeVersion(): Promise<string> {
  const result = await runProcess('claude', ['--version'], { cwd: process.cwd(), env: {}, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`claude --version exited ${String(result.code ?? result.signal)}: ${result.stderrTail}`);
  return result.stdoutTail.trim();
}

interface Settings {
  mode: 'scored' | 'pilot' | 'unspecified';
  arms: ArmId[];
  runs: number;
  concurrency: number;
  seed: number;
  model: string | undefined;
  maxBudgetUsd: number | undefined;
  wallClockMs: number | undefined;
  prereg: Prereg | undefined;
  skillPath: string;
  claudeVersion: string | undefined;
  /** Lines describing what was read from the registration, for `plan`. */
  registered: string[];
}

/** The checks of a scored run (T-03-103). Returns the problems; none means the run may start. */
async function scoredGate(
  values: Values,
  questions: QuestionFile,
  repoRoot: string,
  deps: CliDeps,
): Promise<{ problems: string[]; prereg: Prereg | undefined; claudeVersion: string | undefined }> {
  const problems: string[] = [];
  const preregPath = path.resolve(values.prereg ?? path.join(repoRoot, DEFAULT_PREREG_PATH));
  if (!fs.existsSync(preregPath)) {
    return { problems: [`no preregistration at ${preregPath}`], prereg: undefined, claudeVersion: undefined };
  }
  const verified = verifyPrereg(preregPath, repoRoot);
  problems.push(...verified.problems);
  let prereg: Prereg;
  try {
    prereg = readPrereg(preregPath);
  } catch {
    return { problems, prereg: undefined, claudeVersion: undefined };
  }
  if (prereg.status !== 'Frozen') problems.push(`the preregistration is ${prereg.status}; a scored run needs a Frozen one`);
  if (prereg.stageB === undefined) problems.push('the preregistration is Stage A; a scored run needs Stage B (the skill hash and the atlas commit)');

  const skillPath = path.resolve(values.skill ?? path.join(repoRoot, SKILL_PATH));
  if (prereg.stageB !== undefined) {
    if (!fs.existsSync(skillPath)) problems.push(`the skill file ${skillPath} does not exist`);
    else if (hashFile(skillPath) !== prereg.stageB.skillSha256) {
      problems.push(`the skill file ${skillPath} differs from the registered Stage B hash`);
    }
  }

  const registeredFlag = (name: string, given: string | undefined, registered: string | number): void => {
    if (given !== undefined && String(registered) !== given && Number(given) !== registered) {
      problems.push(`--${name} ${given} differs from the registered ${String(registered)}; a scored run takes it from the registration`);
    }
  };
  registeredFlag('model', values.model, prereg.params.model);
  registeredFlag('runs', values.runs, prereg.params.runsPerCell);
  registeredFlag('concurrency', values.concurrency, prereg.params.concurrency);
  registeredFlag('seed', values.seed, prereg.params.seed);
  registeredFlag('max-budget-usd', values['max-budget-usd'], prereg.params.maxBudgetUsdPerSession);
  registeredFlag('wall-clock-ms', values['wall-clock-ms'], prereg.params.sessionWallClockMs);
  if (values['claude-executable'] !== undefined || (values['claude-prefix-arg'] ?? []).length > 0) {
    problems.push('--claude-executable and --claude-prefix-arg are for tests and are refused in a scored run');
  }
  if (values['out-dir'] !== undefined && path.basename(path.resolve(values['out-dir'])) === 'pilot') {
    problems.push('a scored run must not write into a pilot directory');
  }

  if (questions.corpusSha !== prereg.params.corpusSha) {
    problems.push(`the question file is for corpus sha ${questions.corpusSha}, the registration for ${prereg.params.corpusSha}`);
  }
  const count = questions.questions.length;
  if (count !== prereg.questionSet.count) problems.push(`the question file has ${String(count)} questions, the registration ${String(prereg.questionSet.count)}`);
  const byCategory: Record<string, number> = {};
  for (const question of questions.questions) byCategory[question.category] = (byCategory[question.category] ?? 0) + 1;
  for (const category of new Set([...Object.keys(byCategory), ...Object.keys(prereg.questionSet.byCategory)])) {
    if ((byCategory[category] ?? 0) !== (prereg.questionSet.byCategory[category] ?? 0)) {
      problems.push(`category ${category}: the question file has ${String(byCategory[category] ?? 0)}, the registration ${String(prereg.questionSet.byCategory[category] ?? 0)}`);
    }
  }

  const corpusDir = values['corpus-dir'];
  if (corpusDir === undefined) problems.push('--corpus-dir is required');
  else {
    try {
      const prepared = (deps.readPrepared ?? readPreparedRecord)(path.resolve(corpusDir));
      if (prepared.sha !== prereg.params.corpusSha) problems.push(`the checkout is prepared at sha ${prepared.sha}, the registration says ${prereg.params.corpusSha}`);
      if (prepared.npmCi !== prereg.params.npmCiRan) problems.push(`the checkout's npm ci state (${String(prepared.npmCi)}) differs from the registration (${String(prereg.params.npmCiRan)})`);
    } catch (error) {
      problems.push(`the checkout has no valid preparation record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let claudeVersion: string | undefined;
  try {
    claudeVersion = await (deps.claudeVersion ?? realClaudeVersion)();
    if (!claudeVersion.includes(prereg.params.claudeVersion)) {
      problems.push(`claude reports "${claudeVersion}", the registration says ${prereg.params.claudeVersion}`);
    }
  } catch (error) {
    problems.push(`cannot read the claude version: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { problems, prereg, claudeVersion };
}

interface RunContext {
  command: 'plan' | 'run' | 'pilot';
  settings: Settings;
  questions: QuestionFile;
  cells: Cell[];
  outDir: string | undefined;
  repoRoot: string;
}

async function resolveContext(command: 'plan' | 'run' | 'pilot', values: Values, io: Io, deps: CliDeps): Promise<RunContext | number> {
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const scored = values.scored === true;
  const pilot = values.pilot === true || command === 'pilot';
  if (scored && pilot) throw new UsageError('--scored and --pilot are exclusive');
  if (command === 'run' && !scored && !pilot) throw new UsageError('run needs --scored or --pilot, so that no unregistered run lands in a results directory by accident');
  if (values.questions === undefined) throw new UsageError('--questions is required');

  let questions: QuestionFile;
  try {
    questions = loadQuestions(path.resolve(values.questions));
  } catch (error) {
    io.err(`harness: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let prereg: Prereg | undefined;
  let claudeVersion: string | undefined;
  const registered: string[] = [];
  if (scored) {
    const gate = await scoredGate(values, questions, repoRoot, deps);
    if (gate.problems.length > 0) {
      for (const problem of gate.problems) io.err(`scored gate: ${problem}\n`);
      return 2;
    }
    prereg = gate.prereg;
    claudeVersion = gate.claudeVersion;
    registered.push('gate: ok (preregistration Frozen, Stage B, registered files and skill unchanged)');
    if (prereg !== undefined) {
      const p = prereg.params;
      registered.push(
        `registered: model ${p.model}, claude ${p.claudeVersion}, runs ${String(p.runsPerCell)}, concurrency ${String(p.concurrency)}, seed ${String(p.seed)}, ` +
          `budget ${String(p.maxBudgetUsdPerSession)} USD, wall clock ${String(p.sessionWallClockMs)} ms, corpus ${p.corpusSha}`,
      );
    }
  } else {
    registered.push(`defaults from 03-CONSTANTS.md: runs ${String(DEFAULT_RUNS)} (eval.runsPerCell), concurrency ${String(DEFAULT_CONCURRENCY)} (eval.concurrency), seed ${String(DEFAULT_SEED)} (eval.bootstrapSeed)`);
  }

  const arms = (values.arms ?? ARM_IDS.join(',')).split(',').map((a) => a.trim());
  for (const arm of arms) if (!(ARM_IDS as readonly string[]).includes(arm)) throw new UsageError(`unknown arm "${arm}" (known: ${ARM_IDS.join(', ')})`);
  const params = prereg?.params;
  const settings: Settings = {
    mode: scored ? 'scored' : pilot ? 'pilot' : 'unspecified',
    arms: arms as ArmId[],
    runs: params?.runsPerCell ?? (values.runs === undefined ? DEFAULT_RUNS : whole('runs', values.runs, 1)),
    concurrency: params?.concurrency ?? (values.concurrency === undefined ? DEFAULT_CONCURRENCY : whole('concurrency', values.concurrency, 1)),
    seed: params?.seed ?? (values.seed === undefined ? DEFAULT_SEED : whole('seed', values.seed, Number.MIN_SAFE_INTEGER)),
    model: params?.model ?? values.model,
    maxBudgetUsd: params?.maxBudgetUsdPerSession ?? (values['max-budget-usd'] === undefined ? undefined : positive('max-budget-usd', values['max-budget-usd'])),
    wallClockMs: params?.sessionWallClockMs ?? (values['wall-clock-ms'] === undefined ? undefined : whole('wall-clock-ms', values['wall-clock-ms'], 1)),
    prereg,
    skillPath: path.resolve(values.skill ?? path.join(repoRoot, SKILL_PATH)),
    claudeVersion,
    registered,
  };

  let cells: Cell[];
  try {
    cells = makeSchedule(questions.questions.map((q) => q.id), settings.arms, settings.runs, settings.seed);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  let outDir = values['out-dir'] === undefined ? undefined : path.resolve(values['out-dir']);
  // Pilot results always live in a directory named `pilot`, apart from every scored run.
  if (outDir !== undefined && pilot && path.basename(outDir) !== 'pilot') outDir = path.join(outDir, 'pilot');
  return { command, settings, questions, cells, outDir, repoRoot };
}

function printPlan(context: RunContext, values: Values, io: Io, header: string): void {
  const { settings, cells } = context;
  const perArm = settings.arms.map((arm) => `  ${arm}: ${String(cells.filter((c) => c.arm === arm).length)}`);
  const lines = [
    header,
    `mode: ${settings.mode}`,
    `questions: ${String(context.questions.questions.length)} (corpus ${context.questions.corpusId} at ${context.questions.corpusSha})`,
    `cells: ${String(cells.length)}`,
    ...perArm,
    `runs per cell: ${String(settings.runs)}`,
    `seed: ${String(settings.seed)}`,
    `concurrency: ${String(settings.concurrency)}`,
    'first 10 cells:',
    ...cells.slice(0, 10).map((cell, index) => `  ${String(index + 1)}. ${cellId(cell)}`),
    'flags:',
    `  model: ${settings.model ?? '(claude default)'}`,
    `  max-budget-usd: ${settings.maxBudgetUsd === undefined ? '(unset)' : String(settings.maxBudgetUsd)}`,
    `  wall-clock-ms: ${settings.wallClockMs === undefined ? '(unset)' : String(settings.wallClockMs)}`,
    `  retry: ${String(MAX_INFRASTRUCTURE_RETRIES)} retries after ${values['retry-delay-ms'] ?? String(DEFAULT_RETRY_DELAY_MS)} ms, infrastructure failures only`,
    `  tools: ${ARMS.grep.builtinTools.join(',')} in both arms; the atlas arm adds the gsd-atlas MCP server and skill`,
    `  results: ${context.outDir ?? '(--out-dir unset)'}`,
    ...settings.registered,
  ];
  io.out(`${lines.join('\n')}\n`);
}

function fail(io: Io, message: string): number {
  io.err(`harness: ${message}\n`);
  return 2;
}

async function runCommand(command: 'plan' | 'run' | 'pilot', values: Values, io: Io, deps: CliDeps): Promise<number> {
  const resolved = await resolveContext(command, values, io, deps);
  if (typeof resolved === 'number') return resolved;
  const context = resolved;
  const { settings } = context;
  if (command === 'plan' || values['dry-run'] === true) {
    printPlan(context, values, io, command === 'plan' ? 'plan' : 'plan (dry run)');
    io.out('no session started\n');
    return 0;
  }

  // ---- run -------------------------------------------------------------------------------------
  if (values.answers === undefined) return fail(io, '--answers is required');
  if (values['corpus-dir'] === undefined) return fail(io, '--corpus-dir is required');
  if (context.outDir === undefined) return fail(io, '--out-dir is required');
  if (settings.maxBudgetUsd === undefined || settings.wallClockMs === undefined) {
    return fail(io, '--max-budget-usd and --wall-clock-ms are required for a pilot (a scored run takes them from the registration)');
  }
  const corpusDir = path.resolve(values['corpus-dir']);
  const atlasBin = path.resolve(values['atlas-bin'] ?? path.join(context.repoRoot, 'dist', 'bin', 'gsd-atlas.js'));
  for (const [what, file] of [['--corpus-dir', corpusDir], ['--atlas-bin', atlasBin], ['--skill', settings.skillPath]] as const) {
    if (!fs.existsSync(file)) return fail(io, `${what} ${file} does not exist (the atlas binary is built with npm run build)`);
  }

  let sha: string | undefined = settings.prereg?.params.corpusSha;
  if (settings.mode === 'pilot') {
    try {
      sha = (deps.readPrepared ?? readPreparedRecord)(corpusDir).sha;
    } catch (error) {
      io.err(`harness: note: the checkout has no preparation record (${error instanceof Error ? error.message : String(error)}); its commit is not checked\n`);
    }
  }
  let answerFile: z.infer<typeof AnswerFileSchema>;
  try {
    answerFile = AnswerFileSchema.parse(JSON.parse(fs.readFileSync(path.resolve(values.answers), 'utf8').replace(/^﻿/, '')));
  } catch (error) {
    return fail(io, `cannot read the answers file ${values.answers}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sha !== undefined && (context.questions.corpusSha !== sha || answerFile.repoSha !== sha)) {
    return fail(io, `the questions (${context.questions.corpusSha}) and the answers (${answerFile.repoSha}) must be for the checkout's commit ${sha}`);
  }
  const keys = new Map(answerFile.answers.map((answer) => [answer.questionId, answer]));
  for (const question of context.questions.questions) {
    if (!keys.has(question.id)) return fail(io, `the answers file has no key for ${question.id}`);
  }

  const answerSchema = JSON.stringify(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'answer-schema.json'), 'utf8')) as unknown);
  const store = new ResultsStore(context.outDir);
  const createdScratch = values['scratch-dir'] === undefined;
  const scratchRoot = values['scratch-dir'] === undefined
    ? fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gsd-atlas-eval-'))
    : path.resolve(values['scratch-dir']);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const retryDelayMs = values['retry-delay-ms'] === undefined ? DEFAULT_RETRY_DELAY_MS : whole('retry-delay-ms', values['retry-delay-ms'], 0);
  const cellDeps: CellDeps = {
    questions: new Map(context.questions.questions.map((q) => [q.id, q])),
    keys,
    corpusDir,
    scratchRoot,
    store,
    atlasBin,
    skillPath: settings.skillPath,
    answerSchema,
    maxBudgetUsd: settings.maxBudgetUsd,
    wallClockMs: settings.wallClockMs,
    retryDelayMs,
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(values['keep-sessions'] === true ? { keepSessions: true } : {}),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(values['prep-timeout-ms'] === undefined ? {} : { prepTimeoutMs: whole('prep-timeout-ms', values['prep-timeout-ms'], 1) }),
    ...(settings.prereg?.stageB === undefined ? {} : { skillSha256: settings.prereg.stageB.skillSha256 }),
    ...(values['claude-executable'] === undefined && (values['claude-prefix-arg'] ?? []).length === 0
      ? {}
      : {
          claude: {
            ...(values['claude-executable'] === undefined ? {} : { executable: values['claude-executable'] }),
            ...((values['claude-prefix-arg'] ?? []).length === 0 ? {} : { prefixArgs: [...(values['claude-prefix-arg'] ?? [])] }),
          },
        }),
  };
  store.appendMeta({
    kind: 'run_start',
    mode: settings.mode,
    startedAt: new Date().toISOString(),
    cells: context.cells.length,
    arms: settings.arms,
    runs: settings.runs,
    seed: settings.seed,
    concurrency: settings.concurrency,
    model: settings.model ?? null,
    maxBudgetUsd: settings.maxBudgetUsd,
    wallClockMs: settings.wallClockMs,
    retryDelayMs,
    claudeVersion: settings.claudeVersion ?? null,
    corpusSha: sha ?? null,
  });

  let finished = 0;
  io.out(`run: ${String(context.cells.length)} cells, mode ${settings.mode}, results in ${context.outDir}\n`);
  try {
    const summary = await runAll({
      cells: context.cells,
      concurrency: settings.concurrency,
      deps: cellDeps,
      onCell: (cell, result) => {
        finished += 1;
        const tail = result.row === undefined ? '' : ` correct=${String(result.row.correct)} status=${result.row.status} tokens=${String(result.row.billableTokens)}`;
        io.out(`[${String(finished)}/${String(context.cells.length)}] ${cellId(cell)} ${result.outcome}${tail}\n`);
      },
    });
    io.out(`done: ${String(summary.done)}\nskipped: ${String(summary.skipped)}\n`);
    for (const c of summary.contaminated) io.err(`contaminated: ${c.cellId}: ${c.diffs.join('; ')}\n`);
    for (const p of summary.prepFailed) io.err(`prep failed: ${p.cellId}: ${p.detail}\n`);
    for (const e of summary.errors) io.err(`error: ${e.cellId}: ${e.message}\n`);
    if (summary.stopped) {
      io.err('harness: the run stopped; the cells above have no row. Fix the cause and start again: finished cells are skipped.\n');
      return 1;
    }
    return 0;
  } finally {
    if (createdScratch) fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Command line: summary and project (pure functions over result rows)

/** The one-sided 95 percent normal quantile: the lower bound of a paired mean is `mean - 1.645 * sd / sqrt(N)`. */
const Z_ONE_SIDED_95 = 1.645;

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Sample standard deviation (n - 1); undefined for fewer than two values. */
function sampleSd(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

export interface ArmSummary {
  arm: ArmId;
  sessions: number;
  ok: number;
  failedByStatus: Record<string, number>;
  meanBillableTokens: number;
  totalBillableTokens: number;
  meanCacheReadTokens: number;
  totalCacheReadTokens: number;
  meanToolCalls: number;
  meanWallMs: number;
  /** The sum over sessions that reported a cost; null when none did. */
  totalCostUsd: number | null;
  sessionsWithCost: number;
}

export function summarizeRows(rows: readonly ResultRow[]): ArmSummary[] {
  const out: ArmSummary[] = [];
  for (const arm of ARM_IDS) {
    const own = rows.filter((row) => row.arm === arm);
    if (own.length === 0) continue;
    const failedByStatus: Record<string, number> = {};
    for (const row of own) if (row.status !== 'ok') failedByStatus[row.status] = (failedByStatus[row.status] ?? 0) + 1;
    const costs = own.flatMap((row) => (row.costUsd === null ? [] : [row.costUsd]));
    out.push({
      arm,
      sessions: own.length,
      ok: own.filter((row) => row.status === 'ok').length,
      failedByStatus,
      meanBillableTokens: mean(own.map((row) => row.billableTokens)),
      totalBillableTokens: own.reduce((a, row) => a + row.billableTokens, 0),
      meanCacheReadTokens: mean(own.map((row) => row.usage.cacheRead)),
      totalCacheReadTokens: own.reduce((a, row) => a + row.usage.cacheRead, 0),
      meanToolCalls: mean(own.map((row) => row.toolCalls)),
      meanWallMs: mean(own.map((row) => row.wallMs)),
      totalCostUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
      sessionsWithCost: costs.length,
    });
  }
  return out;
}

/** Per question, the run-mean correctness of each arm; only questions that have rows in both arms. */
function pairedAccuracy(rows: readonly ResultRow[]): Array<{ questionId: string; atlas: number; grep: number }> {
  const ids = [...new Set(rows.map((row) => row.questionId))];
  const out: Array<{ questionId: string; atlas: number; grep: number }> = [];
  for (const questionId of ids) {
    const accuracy = (arm: ArmId): number | undefined => {
      const own = rows.filter((row) => row.questionId === questionId && row.arm === arm);
      return own.length === 0 ? undefined : mean(own.map((row) => (row.correct ? 1 : 0)));
    };
    const atlas = accuracy('atlas');
    const grep = accuracy('grep');
    if (atlas !== undefined && grep !== undefined) out.push({ questionId, atlas, grep });
  }
  return out;
}

/** Questions where one arm's run-mean correctness is above 0.5 and the other's is not. */
export function disagreement(rows: readonly ResultRow[]): { questions: number; disagree: number } {
  const paired = pairedAccuracy(rows);
  return { questions: paired.length, disagree: paired.filter((q) => (q.atlas > 0.5) !== (q.grep > 0.5)).length };
}

interface LoadedRows {
  file: string;
  rows: ResultRow[];
  problems: string[];
}

/** Reads a results file without touching it. Looks in `<dir>/pilot` when `dir` has no results of its own. */
function loadRows(dir: string): LoadedRows | undefined {
  let file = path.join(dir, 'results.jsonl');
  if (!fs.existsSync(file)) {
    const pilot = path.join(dir, 'pilot', 'results.jsonl');
    if (!fs.existsSync(pilot)) return undefined;
    file = pilot;
  }
  const problems: string[] = [];
  const rows: ResultRow[] = [];
  let values: unknown[] = [];
  try {
    values = readJsonLines(file);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  values.forEach((value, index) => {
    const parsed = ResultRowSchema.safeParse(value);
    if (parsed.success) rows.push(parsed.data);
    else problems.push(`${file}: row ${String(index + 1)}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  });
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(cellId(row), (seen.get(cellId(row)) ?? 0) + 1);
  for (const [id, count] of seen) if (count > 1) problems.push(`duplicate cell ${id} (${String(count)} rows in ${file})`);
  return { file, rows, problems };
}

function summaryCommand(values: Values, io: Io): number {
  if (values['out-dir'] === undefined) return fail(io, '--out-dir is required');
  const loaded = loadRows(path.resolve(values['out-dir']));
  if (loaded === undefined) return fail(io, `no results in ${values['out-dir']} (looked for results.jsonl and pilot/results.jsonl)`);
  if (loaded.problems.length > 0) {
    for (const problem of loaded.problems) io.err(`harness: ${problem}\n`);
    return 1;
  }
  const lines = [`results: ${loaded.file}`, `rows: ${String(loaded.rows.length)}`];
  for (const s of summarizeRows(loaded.rows)) {
    const failed = Object.entries(s.failedByStatus).map(([status, n]) => `${status} ${String(n)}`).join(', ');
    lines.push(
      `arm ${s.arm}`,
      `  sessions: ${String(s.sessions)}`,
      `  ok: ${String(s.ok)}`,
      `  failed: ${failed === '' ? 'none' : failed}`,
      `  billable tokens: mean ${s.meanBillableTokens.toFixed(1)}, total ${String(s.totalBillableTokens)}`,
      `  cache-read tokens: mean ${s.meanCacheReadTokens.toFixed(1)}, total ${String(s.totalCacheReadTokens)}`,
      `  mean tool calls: ${s.meanToolCalls.toFixed(1)}`,
      `  mean wall time: ${String(Math.round(s.meanWallMs))} ms`,
      s.totalCostUsd === null
        ? '  cost: not reported'
        : `  cost: total ${s.totalCostUsd.toFixed(4)} USD (${String(s.sessionsWithCost)} of ${String(s.sessions)} sessions)`,
    );
  }
  const d = disagreement(loaded.rows);
  lines.push(`questions with both arms: ${String(d.questions)}`);
  lines.push(
    d.questions === 0
      ? 'disagreement: not defined (no question has rows in both arms)'
      : `disagreement: ${String(d.disagree)} of ${String(d.questions)} questions (${((d.disagree / d.questions) * 100).toFixed(1)}%)`,
  );
  io.out(`${lines.join('\n')}\n`);
  return 0;
}

const OFFSET_QUESTION_COUNTS = [50, 75, 100] as const;

function projectCommand(values: Values, io: Io): number {
  if (values['out-dir'] === undefined) return fail(io, '--out-dir is required');
  if (values.questions === undefined || values.runs === undefined) return fail(io, 'project needs --questions <n> and --runs <k>');
  const questionCount = whole('questions', values.questions, 1);
  const runs = whole('runs', values.runs, 1);
  const loaded = loadRows(path.resolve(values['out-dir']));
  if (loaded === undefined) return fail(io, `no results in ${values['out-dir']} (looked for results.jsonl and pilot/results.jsonl)`);
  if (loaded.problems.length > 0) {
    for (const problem of loaded.problems) io.err(`harness: ${problem}\n`);
    return 1;
  }
  const summaries = summarizeRows(loaded.rows);
  const sessionsPerArm = questionCount * runs;
  const lines = [
    `projection from ${loaded.file} (an estimate from ${String(loaded.rows.length)} pilot sessions, not a quote)`,
    `full run: ${String(questionCount)} questions x ${String(runs)} runs = ${String(sessionsPerArm)} sessions per arm`,
  ];
  let totalCost = 0;
  let costKnown = true;
  for (const s of summaries) {
    const costRows = loaded.rows.filter((row) => row.arm === s.arm && row.costUsd !== null);
    if (costRows.length === 0) {
      lines.push(`  ${s.arm}: no cost reported in the pilot`);
      costKnown = false;
      continue;
    }
    const perSession = mean(costRows.map((row) => row.costUsd as number));
    totalCost += perSession * sessionsPerArm;
    lines.push(`  ${s.arm}: ${perSession.toFixed(4)} USD per session x ${String(sessionsPerArm)} sessions = ${(perSession * sessionsPerArm).toFixed(2)} USD (estimate)`);
  }
  const totalSessions = sessionsPerArm * summaries.length;
  lines.push(
    costKnown
      ? `  total: ${String(totalSessions)} sessions, ${totalCost.toFixed(2)} USD (estimate)`
      : `  total: ${String(totalSessions)} sessions, cost unknown (an arm reported no cost)`,
  );
  if (summaries.length > 0) {
    lines.push(`pilot mean wall time per session: ${String(Math.round(mean(loaded.rows.map((row) => row.wallMs))))} ms (concurrency not applied)`);
  }
  const diffs = pairedAccuracy(loaded.rows).map((q) => q.atlas - q.grep);
  const sd = sampleSd(diffs);
  if (sd === undefined) {
    lines.push('paired difference sd: needs at least 2 paired questions (a question with rows in both arms)');
  } else {
    lines.push(
      `paired difference sd: ${sd.toFixed(4)} over ${String(diffs.length)} questions (atlas minus grep accuracy, run means)`,
      `one-sided 95 percent lower-bound offset below the observed difference, ${String(Z_ONE_SIDED_95)} * sd / sqrt(N):`,
      ...OFFSET_QUESTION_COUNTS.map((n) => `  N = ${String(n)}: ${(((Z_ONE_SIDED_95 * sd) / Math.sqrt(n)) * 100).toFixed(2)} points`),
    );
  }
  io.out(`${lines.join('\n')}\n`);
  return 0;
}

/** The command body. Returns the exit code: 0 ok, 1 the run stopped, 2 usage or a refused gate. */
export async function runCli(argv: readonly string[], io: Io, deps: CliDeps = {}): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    const [command, ...extra] = positionals;
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra.join(' ')}"`);
    if (command === 'plan' || command === 'run' || command === 'pilot') return await runCommand(command, values, io, deps);
    if (command === 'summary') return summaryCommand(values, io);
    if (command === 'project') return projectCommand(values, io);
    throw new UsageError(command === undefined ? 'a command is required' : `unknown command "${command}"`);
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && 'code' in error)) {
      io.err(`harness: ${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
