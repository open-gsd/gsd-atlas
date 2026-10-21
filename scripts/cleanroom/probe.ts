/**
 * node scripts/cleanroom/probe.ts --arm atlas|grep|control-harness|control-default --corpus-dir <prepared checkout>
 *     --out-dir <dir> [--atlas-bin <file>] [--skill <file>] [--prereg <file>] [--claude <executable>]
 *
 * One probe session of the clean-room preflight (plan 03-39, Task 6). It prepares a session the way the registered
 * harness's `runCell` does and builds the same session specification, then runs one tiny prompt and prints ONE
 * compact JSON line: the init signature differences against the registered signature of the arm, `apiKeySource`,
 * the Claude Code version, the `rate_limit_event` fields (status, window, utilization of both windows, paid-usage
 * flags, resets), the notional cost, the status and, for the two control probes only, the first 200 characters of
 * the reply. The raw stream is written under `<out-dir>/streams`; the line carries no path.
 *
 *   atlas, grep       the registered arms, unchanged, with the prompt `Reply with the single word ok.`
 *   control-harness   the grep arm's flags (isolation flags included), with the answer schema left out so the reply is
 *                     plain text, asked whether it was given text from a file named CLAUDE.md
 *   control-default   `claude -p` with `--tools ""`, `--no-session-persistence`, the registered model and no
 *                     `--setting-sources`, asked the same question
 *
 * Each probe is capped at 0.05 USD notional and 120 seconds. Exit code: 0 when the session ended `ok`, 1 when it did
 * not (or the atlas index could not be built), 2 on a usage error.
 *
 * Replication tooling: Node built-ins and the registered `scripts/eval` modules only, never `src/` (D-02).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { ARMS, allowedToolsFor, buildMcpConfig, buildPluginDir } from '../eval/arms.ts';
import { extractResult, parseStreamText, runClaudeSession, statusOf } from '../eval/claude-session.ts';
import type { SessionSpec, SessionStatus } from '../eval/claude-session.ts';
import { cloneCheckout } from '../eval/prepare-corpus.ts';
import { DEFAULT_PREREG_PATH, SKILL_PATH, readPrereg } from '../eval/prereg.ts';
import { iso, rateInfoOf } from './check-chunk.ts';
import { diffSignature, signatureFromEvents } from './init-signature.ts';

export const PROBE_KINDS = ['atlas', 'grep', 'control-harness', 'control-default'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export const ARM_PROMPT = 'Reply with the single word ok.';
export const CONTROL_PROMPT =
  'If you were given any text from a file named CLAUDE.md, quote its first line exactly; otherwise reply with the single word none.';

/** Per-probe caps (plan 03-39: at most 0.05 USD notional each, 0.20 USD for the four). */
export const PROBE_MAX_BUDGET_USD = 0.05;
export const PROBE_WALL_CLOCK_MS = 120_000;
const REPLY_CHARS = 200;
const PREP_TIMEOUT_MS = 20 * 60_000;
const STDOUT_CAP = 32 * 1024 * 1024;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface ProbeReport {
  probe: ProbeKind;
  status: SessionStatus | 'prep_failed';
  /** One string per difference from the arm's registered signature; null for the control probes. */
  signatureDiffs: string[] | null;
  apiKeySource: string | null;
  claudeCodeVersion: string | null;
  model: string | null;
  hookEvents: number;
  costUsd: number | null;
  rateLimit: {
    status: string | null;
    rateLimitType: string | null;
    fiveHour: number | null;
    sevenDay: number | null;
    fiveHourResetsAt: string | null;
    sevenDayResetsAt: string | null;
    isUsingOverage: boolean | null;
    overageEnabled: boolean | null;
  };
  wallMs: number;
  /** The raw stream's file name inside `<out-dir>/streams`. */
  stream: string;
  /** Control probes only: the first 200 characters of the reply. */
  reply?: string;
}

const isArmProbe = (kind: ProbeKind): kind is 'atlas' | 'grep' => kind === 'atlas' || kind === 'grep';

/** `probe-<kind>.<arm or control>.1.a1.jsonl`, the stream name `check-chunk.ts --streams-only` reads. */
export function streamFileName(kind: ProbeKind): string {
  return `probe-${kind}.${isArmProbe(kind) ? kind : 'control'}.1.a1.jsonl`;
}

function runDefaultControl(options: {
  executable: string;
  cwd: string;
  model: string;
  prompt: string;
  rawStreamPath: string;
}): Promise<{ status: SessionStatus; wallMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let capExceeded = false;
    let spawnFailed = false;
    let settled = false;
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--max-budget-usd',
      String(PROBE_MAX_BUDGET_USD),
      '--model',
      options.model,
      '--no-session-persistence',
    ];
    const child = spawn(options.executable, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      fs.writeFileSync(options.rawStreamPath, stdout);
      const result = extractResult(parseStreamText(stdout.toString('utf8')).events);
      resolve({ status: statusOf({ code, signal, spawnFailed }, result, { timedOut, capExceeded }), wallMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROBE_WALL_CLOCK_MS);
    child.on('error', () => {
      spawnFailed = true;
      finish(null, null);
    });
    child.stdin.on('error', () => {
      // The child may exit before it reads the prompt; its exit status tells the story.
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (capExceeded) return;
      if (kept + chunk.length > STDOUT_CAP) {
        capExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    });
    child.stderr.on('data', () => {
      // Not kept: the line carries no stderr text.
    });
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.end(options.prompt);
  });
}

function runPrep(args: string[], cwd: string, env: NodeJS.ProcessEnv): boolean {
  const done = spawnSync(process.execPath, args, { cwd, env, stdio: 'ignore', timeout: PREP_TIMEOUT_MS });
  return done.error === undefined && done.status === 0;
}

export interface ProbeOptions {
  kind: ProbeKind;
  corpusDir: string;
  outDir: string;
  atlasBin: string;
  skillPath: string;
  preregPath: string;
  claude: string;
}

/** Runs one probe and returns its report. The scratch session directory is removed at the end. */
export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const prereg = readPrereg(options.preregPath);
  const model = prereg.params.model;
  const streamsDir = path.join(options.outDir, 'streams');
  fs.mkdirSync(streamsDir, { recursive: true });
  const stream = streamFileName(options.kind);
  const rawStreamPath = path.join(streamsDir, stream);
  const sessionDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'cleanroom-probe-'));
  const base = {
    probe: options.kind,
    signatureDiffs: null,
    apiKeySource: null,
    claudeCodeVersion: null,
    model: null,
    hookEvents: 0,
    costUsd: null,
    rateLimit: { status: null, rateLimitType: null, fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, isUsingOverage: null, overageEnabled: null },
    wallMs: 0,
    stream,
  } satisfies Omit<ProbeReport, 'status'>;
  try {
    const repoDir = path.join(sessionDir, 'repo');
    const storeDir = path.join(sessionDir, 'store');
    const userDir = path.join(sessionDir, 'user');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    cloneCheckout(options.corpusDir, repoDir);
    const env: Record<string, string> = { GSD_ATLAS_STORE_DIR: storeDir, GSD_ATLAS_USER_DIR: userDir };

    let status: SessionStatus;
    let wallMs: number;
    if (options.kind === 'control-default') {
      const done = await runDefaultControl({ executable: options.claude, cwd: repoDir, model, prompt: CONTROL_PROMPT, rawStreamPath });
      status = done.status;
      wallMs = done.wallMs;
    } else {
      const arm = options.kind === 'atlas' ? 'atlas' : 'grep';
      if (arm === 'atlas') {
        const processEnv = { ...process.env, ...env };
        const built = runPrep([options.atlasBin, 'build', '--repo', repoDir], repoDir, processEnv);
        if (!built) return { ...base, status: 'prep_failed' };
        // `maintain resolve` may fail until the precise tier exists; the harness goes on whatever it returns.
        runPrep([options.atlasBin, 'maintain', 'resolve', '--repo', repoDir], repoDir, processEnv);
      }
      const mcpConfigPath = path.join(sessionDir, 'mcp.json');
      buildMcpConfig(arm, { atlasBin: options.atlasBin, storeDir, userDir, configPath: mcpConfigPath });
      const pluginDirs = arm === 'atlas' ? [buildPluginDir(sessionDir, options.skillPath, prereg.stageB?.skillSha256)] : [];
      const answerSchema = JSON.stringify(
        JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'eval', 'answer-schema.json'), 'utf8')) as unknown,
      );
      const spec: SessionSpec = {
        prompt: isArmProbe(options.kind) ? ARM_PROMPT : CONTROL_PROMPT,
        cwd: repoDir,
        tools: [...ARMS[arm].builtinTools],
        allowedTools: allowedToolsFor(arm),
        mcpConfigPath,
        pluginDirs,
        ...(ARMS[arm].settings === undefined ? {} : { settings: ARMS[arm].settings }),
        // The control probe asks for plain text, so it leaves the answer schema out; the isolation flags are unchanged.
        ...(isArmProbe(options.kind) ? { jsonSchema: answerSchema } : {}),
        model,
        maxBudgetUsd: PROBE_MAX_BUDGET_USD,
        wallClockMs: PROBE_WALL_CLOCK_MS,
        executable: options.claude,
        env,
        rawStreamPath,
      };
      const outcome = await runClaudeSession(spec);
      status = outcome.status;
      wallMs = outcome.wallMs;
    }

    const text = fs.existsSync(rawStreamPath) ? fs.readFileSync(rawStreamPath, 'utf8') : '';
    const { events } = parseStreamText(text);
    const signature = signatureFromEvents(events);
    const result = extractResult(events);
    const rates = events.filter((event) => event.type === 'rate_limit_event').flatMap((event) => rateInfoOf(event) ?? []);
    const last = rates.at(-1);
    const window = (name: 'five_hour' | 'seven_day'): { utilization: number; resetsAt: number | null } | undefined =>
      rates.flatMap((rate) => rate.windows.filter((entry) => entry.name === name)).at(-1);
    const five = window('five_hour');
    const seven = window('seven_day');
    const report: ProbeReport = {
      probe: options.kind,
      status,
      signatureDiffs: isArmProbe(options.kind) ? diffSignature(options.kind, signature) : null,
      apiKeySource: signature?.apiKeySource ?? null,
      claudeCodeVersion: signature?.claudeCodeVersion ?? null,
      model: signature?.model ?? null,
      hookEvents: events.filter((event) => event.type === 'system' && typeof event['subtype'] === 'string' && event['subtype'].startsWith('hook')).length,
      costUsd: result === null ? null : result.totalCostUsd,
      rateLimit: {
        status: last?.status ?? null,
        rateLimitType: last?.rateLimitType ?? null,
        fiveHour: five?.utilization ?? null,
        sevenDay: seven?.utilization ?? null,
        fiveHourResetsAt: iso(five?.resetsAt ?? null),
        sevenDayResetsAt: iso(seven?.resetsAt ?? null),
        isUsingOverage: rates.some((rate) => rate.isUsingOverage) ? true : last === undefined ? null : false,
        overageEnabled: rates.some((rate) => rate.overageEnabled) ? true : last === undefined ? null : false,
      },
      wallMs,
      stream,
    };
    if (!isArmProbe(options.kind)) report.reply = (result?.text ?? '').slice(0, REPLY_CHARS);
    return report;
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const USAGE =
  'usage: node scripts/cleanroom/probe.ts --arm atlas|grep|control-harness|control-default --corpus-dir <prepared checkout> --out-dir <dir>\n' +
  '           [--atlas-bin <file>] [--skill <file>] [--prereg <file>] [--claude <executable>]\n' +
  '\n' +
  'Runs one capped probe session (0.05 USD notional, 120 s) and prints one compact JSON line. --claude replaces the `claude` on the\n' +
  'path (for tests). Exit 0 when the session ended ok, 1 otherwise, 2 on a usage error.\n';

/** The command body with injectable output; returns the exit code. */
export async function runCli(argv: string[], io: Io, root: string): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        arm: { type: 'string' },
        'corpus-dir': { type: 'string' },
        'out-dir': { type: 'string' },
        'atlas-bin': { type: 'string' },
        skill: { type: 'string' },
        prereg: { type: 'string' },
        claude: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`probe: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values['help'] === true) {
    io.out(USAGE);
    return 0;
  }
  const arm = values['arm'];
  if (typeof arm !== 'string' || !(PROBE_KINDS as readonly string[]).includes(arm)) {
    io.err(`probe: --arm must be one of ${PROBE_KINDS.join(', ')}\n${USAGE}`);
    return 2;
  }
  if (typeof values['corpus-dir'] !== 'string' || typeof values['out-dir'] !== 'string') {
    io.err(`probe: --corpus-dir and --out-dir are required\n${USAGE}`);
    return 2;
  }
  const corpusDir = path.resolve(values['corpus-dir']);
  if (!fs.existsSync(corpusDir) || !fs.statSync(corpusDir).isDirectory()) {
    io.err('probe: --corpus-dir is not a directory\n');
    return 2;
  }
  const atlasBin = path.resolve(typeof values['atlas-bin'] === 'string' ? values['atlas-bin'] : path.join(root, 'dist', 'bin', 'gsd-atlas.js'));
  const skillPath = path.resolve(typeof values['skill'] === 'string' ? values['skill'] : path.join(root, SKILL_PATH));
  const preregPath = path.resolve(typeof values['prereg'] === 'string' ? values['prereg'] : path.join(root, DEFAULT_PREREG_PATH));
  try {
    const report = await runProbe({
      kind: arm as ProbeKind,
      corpusDir,
      outDir: path.resolve(values['out-dir']),
      atlasBin,
      skillPath,
      preregPath,
      claude: typeof values['claude'] === 'string' ? values['claude'] : 'claude',
    });
    io.out(`${JSON.stringify(report)}\n`);
    return report.status === 'ok' ? 0 : 1;
  } catch (error) {
    io.err(`probe: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  runCli(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    path.resolve(import.meta.dirname, '..', '..'),
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`probe: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
