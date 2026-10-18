/**
 * The eval harness (D-03, D-04, D-06, EVL-02, EVL-03): turns a question set into scored sessions.
 *
 * `runCell` runs one (question, arm, run) cell: it clones the prepared checkout into a session
 * directory of its own, builds the atlas index in that directory for the atlas arm (outside the token
 * count), starts the session through `claude -p` with the arm's tools and an isolated environment,
 * compares the session's `system/init` event with the arm's registered tool set, scores the answer
 * against the oracle key and appends one result row. A cell that already has a row is skipped.
 *
 * Eval tooling: it must never import from src/ (D-02). Atlas is only ever run as the built binary.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ARMS, allowedToolsFor, buildMcpConfig, buildPluginDir, checkInit } from './arms.ts';
import type { ArmId } from './arms.ts';
import { runClaudeSession } from './claude-session.ts';
import type { SessionOutcome, SessionSpec, Usage } from './claude-session.ts';
import { cloneCheckout } from './prepare-corpus.ts';
import type { AnswerKey, Question } from './questions.ts';
import { ResultsStore } from './results.ts';
import type { ResultRow } from './rows.ts';
import { scoreAnswer, toResultRow } from './score.ts';
import { cellId } from './schedule.ts';
import type { Cell } from './schedule.ts';

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
  /** Wait before the retry of an infrastructure failure. */
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
// Child processes (the atlas binary)

interface ProcessResult {
  code: number | null;
  signal: string | null;
  ms: number;
  stderrTail: string;
}

const STDERR_TAIL = 2_000;

function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number | undefined },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, signal: string | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - started, stderrTail: (extra + stderr).slice(-STDERR_TAIL) });
    };
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 2_147_483_647);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (error: Error) => finish(null, null, `${error.message}\n`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------------------------
// One cell

const sessionName = (cell: Cell): string => `${cell.questionId}.${cell.arm}.${String(cell.run)}`.replace(/[^A-Za-z0-9._-]/g, '_');

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

function atlasCalls(byName: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [name, count] of Object.entries(byName)) if (name.startsWith('mcp__gsd-atlas__')) total += count;
  return total;
}

function rowOf(cell: Cell, question: Question, outcome: SessionOutcome, scored: Awaited<ReturnType<typeof scoreAnswer>>): ResultRow {
  const partial = {
    questionId: cell.questionId,
    category: question.category,
    arm: cell.arm,
    run: cell.run,
    status: outcome.status,
    usage: outcome.result?.usage ?? ZERO_USAGE,
    toolCalls: outcome.toolCallTotal,
    toolCallsByName: outcome.toolCalls,
    atlasToolCalls: atlasCalls(outcome.toolCalls),
    wallMs: outcome.wallMs,
    costUsd: outcome.result === null ? null : outcome.result.totalCostUsd,
  };
  return toResultRow(partial, scored);
}

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
  const pluginDirs = cell.arm === 'atlas' ? [buildPluginDir(sessionDir, deps.skillPath)] : [];

  const streamsDir = path.join(deps.store.dir, 'streams');
  fs.mkdirSync(streamsDir, { recursive: true });
  const rawStreamPath = path.join(streamsDir, `${sessionName(cell)}.a1.jsonl`);
  const spec: SessionSpec = {
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
    rawStreamPath,
    ...(deps.model === undefined ? {} : { model: deps.model }),
    ...(deps.claude?.executable === undefined ? {} : { executable: deps.claude.executable }),
    ...(deps.claude?.prefixArgs === undefined ? {} : { prefixArgs: deps.claude.prefixArgs }),
  };
  const outcome = await runClaudeSession(spec);

  const diffs = checkInit(cell.arm, outcome.init);
  const sessionMeta = {
    kind: 'session',
    cellId: id,
    attempt: 1,
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
    init: outcome.init === null ? null : { tools: outcome.init.tools, mcpServers: outcome.init.mcpServers, skills: outcome.init.skills, model: outcome.init.model },
  };
  deps.store.appendMeta(sessionMeta);
  if (diffs.length > 0) {
    deps.store.appendMeta({ kind: 'contaminated', cellId: id, diffs, sessionDir, rawStreamPath });
    return { outcome: 'contaminated', diffs };
  }

  const scored = await scoreAnswer(question, key, outcome.result?.text ?? '', {
    repoDir: deps.corpusDir,
    tsconfig: deps.tsconfig ?? 'tsconfig.json',
  });
  const row = rowOf(cell, question, outcome, scored);
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
}

export interface RunSummary {
  total: number;
  done: number;
  skipped: number;
  contaminated: Array<{ cellId: string; diffs: string[] }>;
  prepFailed: Array<{ cellId: string; detail: string }>;
  /** True when scheduling stopped early (a contaminated session or a failed index build). */
  stopped: boolean;
}

// RED stubs (plan 03-10 task 2): the interfaces exist, the behavior does not yet.
export function isInfrastructureFailure(_result: unknown, _toolCallTotal: number): boolean {
  return false;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDeps {
  repoRoot?: string;
  env?: Record<string, string>;
  claudeVersion?: () => Promise<string>;
  readPrepared?: (dir: string) => { sha: string; npmCi: boolean };
}

export function runCli(_argv: readonly string[], _io: Io, _deps: CliDeps = {}): Promise<number> {
  return Promise.resolve(0);
}

export async function runAll(options: RunAllOptions): Promise<RunSummary> {
  const summary: RunSummary = { total: options.cells.length, done: 0, skipped: 0, contaminated: [], prepFailed: [], stopped: false };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const cell = options.cells[next];
      next += 1;
      if (cell === undefined) return;
      const result = await runCell(cell, options.deps);
      if (result.outcome === 'done') summary.done += 1;
      else if (result.outcome === 'skipped') summary.skipped += 1;
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency, options.cells.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return summary;
}
