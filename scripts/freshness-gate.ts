/**
 * node scripts/freshness-gate.ts [--saves N] [--max-ms M] [--files F]
 *
 * The freshness gate (ROADMAP success criterion 2, IDX-01). It makes a synthetic TypeScript repository of F files,
 * builds it through the composed Host (the real watcher, Grammar Engine, Fact Store and Governor), and then saves N
 * files one after another, alternating an edit of an existing file with the creation of a new one. The clock for
 * each save starts when the write returns and stops when `code_find`, asked without any `fresh` argument, returns
 * the new definition (polled every 25 ms). It prints p50, p95 and p99 of the N times and exits 1 when p99 is above
 * `--max-ms`.
 *
 * Percentiles use the nearest-rank method on the sorted samples: the p-th percentile of n samples is the value at
 * rank ceil(p times n / 100), counting from 1. The p99 of 100 samples is therefore the 99th value, and the p99 of
 * anything under 100 samples is the largest one. The figure is one stated rule, so two runs are comparable.
 *
 * The bound defaults to the approved nightly figure (`gate.freshnessNightlyP99Ms`, one second); the pull request
 * job passes the looser approved ceiling (`gate.freshnessPrCeilingMs`) because hosted runners are noisy.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { composeHost } from '../src/bin/compose.ts';
import type { Composed } from '../src/bin/compose.ts';
import { PROTOCOL_VERSION } from '../src/facts/index.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** The approved `gate.freshnessPrCeilingMs` of 02-CONSTANTS.md (Status: Approved): save to find on a pull request. */
export const FRESHNESS_PR_CEILING_MS = 3000;

/** The approved `gate.freshnessNightlyP99Ms` of 02-CONSTANTS.md: the ROADMAP criterion, checked nightly and locally. */
export const FRESHNESS_NIGHTLY_P99_MS = 1000;

const DEFAULTS = { saves: 30, files: 200 } as const;

/** How often the polling loop asks `code_find` again. */
const POLL_MS = 25;

/**
 * Beyond the bound, how long one save may take before the gate calls it lost. It only turns a missing event into a
 * failure instead of a hang; it is not a latency expectation, and no figure is judged against it.
 */
const LOST_SAVE_EXTRA_MS = 30_000;

/** The p-th percentile (0 < p <= 100) of already sorted `sorted`, by nearest rank. Throws on no samples. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile: no samples');
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile: p must be in (0, 100], got ${String(p)}`);
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1] as number;
}

export interface FreshnessGateOptions {
  /** How many saves to measure. */
  readonly saves: number;
  /** The largest acceptable p99, in milliseconds. */
  readonly maxMs: number;
  /** How many files the synthetic repository starts with. Default 200. */
  readonly files?: number;
  /** Directory the work directory is created in. Default the system temp directory. */
  readonly tmpRoot?: string;
  /** Where the lines go. Default stdout. */
  readonly out?: (line: string) => void;
}

export interface FreshnessGateResult {
  /** Save-to-find time of each save, in save order, in milliseconds. */
  readonly samples: readonly number[];
  readonly kinds: readonly ('edit' | 'add')[];
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly ok: boolean;
  /** What failed, or a one-line summary when nothing did. */
  readonly message: string;
  /** How the Indexer received file events: `native`, `poll` or `reconcile-only`. */
  readonly watchMode: string;
}

/** Environment that isolates git from the machine's configuration. */
function gitEnv(base: string): NodeJS.ProcessEnv {
  const empty = path.join(base, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_SYSTEM: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Atlas Gate',
    GIT_AUTHOR_EMAIL: 'atlas@example.invalid',
    GIT_COMMITTER_NAME: 'Atlas Gate',
    GIT_COMMITTER_EMAIL: 'atlas@example.invalid',
  };
}

function git(dir: string, env: NodeJS.ProcessEnv, args: readonly string[]): void {
  const result = spawnSync('git', [...args], { cwd: dir, env, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

const moduleSource = (index: number): string =>
  [0, 1, 2].map((part) => `export function gen_${String(index)}_${String(part)}(value: number): number {\n  return value + ${String(part)};\n}\n`).join('\n');

/** A repository of `files` TypeScript files under src/gen, committed on `main`. */
function makeRepository(base: string, files: number): { dir: string; env: NodeJS.ProcessEnv } {
  const env = gitEnv(base);
  const dir = path.join(base, 'repo');
  fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
  for (let index = 0; index < files; index += 1) {
    fs.writeFileSync(path.join(dir, 'src', 'gen', `m${String(index)}.ts`), moduleSource(index));
  }
  git(dir, env, ['init', '--quiet', '--initial-branch=main']);
  git(dir, env, ['config', 'core.autocrlf', 'false']);
  git(dir, env, ['config', 'commit.gpgsign', 'false']);
  git(dir, env, ['add', '-A']);
  git(dir, env, ['commit', '--quiet', '--no-verify', '-m', 'synthetic repository']);
  return { dir, env };
}

interface Row {
  readonly name: string;
}

async function findRows(composed: Composed, dir: string, name: string): Promise<Row[]> {
  const envelope = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name, repo: dir } });
  if (!envelope.ok || envelope.data === null) return [];
  return (envelope.data as { results?: Row[] }).results ?? [];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Windows keeps files locked briefly after a child exits, hence the retries. */
function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function checkWhole(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`freshness-gate: --${name} must be a whole number, ${String(minimum)} or more`);
}

/** Build the synthetic repository through the Host, save `saves` files, and judge p99 against `maxMs`. */
export async function runFreshnessGate(options: FreshnessGateOptions): Promise<FreshnessGateResult> {
  const files = options.files ?? DEFAULTS.files;
  checkWhole('saves', options.saves, 1);
  checkWhole('files', files, 1);
  checkWhole('max-ms', options.maxMs, 0);
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const tmpRoot = fs.realpathSync.native(path.resolve(options.tmpRoot ?? os.tmpdir()));
  if (tmpRoot === repoRoot || tmpRoot.startsWith(repoRoot + path.sep)) {
    throw new Error(`${tmpRoot} is inside the repository (${repoRoot}); the synthetic repository must not land in a checkout`);
  }
  const base = fs.mkdtempSync(path.join(tmpRoot, 'gsd-atlas-freshness-gate-'));
  let composed: Composed | undefined;
  try {
    const { dir } = makeRepository(base, files);
    const userDir = path.join(base, 'user');
    const storeDir = path.join(base, 'stores');
    const home = path.join(base, 'home');
    for (const each of [userDir, storeDir, home]) fs.mkdirSync(each, { recursive: true });
    composed = composeHost({
      cwd: dir,
      env: { ...process.env, GSD_ATLAS_USER_DIR: userDir, GSD_ATLAS_STORE_DIR: storeDir },
      stderr: process.stderr,
      home,
    });

    const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: dir } });
    if (!built.ok) throw new Error(`build failed: ${built.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
    const status = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'atlas_status', args: { repo: dir } });
    const watchMode = String((status.data as { indexer?: { watchMode?: unknown } } | null)?.indexer?.watchMode ?? 'unknown');

    const samples: number[] = [];
    const kinds: ('edit' | 'add')[] = [];
    for (let save = 0; save < options.saves; save += 1) {
      const kind = save % 2 === 0 ? 'edit' : 'add';
      const name = `fresh_${kind}_${String(save)}`;
      const definition = `export function ${name}(): number {\n  return ${String(save)};\n}\n`;
      if (kind === 'edit') {
        const target = path.join(dir, 'src', 'gen', `m${String((save * 7) % files)}.ts`);
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + definition);
      } else {
        fs.writeFileSync(path.join(dir, 'src', 'gen', `added_${String(save)}.ts`), definition);
      }
      const saved = performance.now();
      let found = false;
      while (!found) {
        found = (await findRows(composed, dir, name)).some((row) => row.name === name);
        if (found) break;
        if (performance.now() - saved > options.maxMs + LOST_SAVE_EXTRA_MS) {
          throw new Error(`save ${String(save)} (${kind}): ${name} never reached code_find; the watcher event or the index is lost (watch mode ${watchMode})`);
        }
        await sleep(POLL_MS);
      }
      samples.push(performance.now() - saved);
      kinds.push(kind);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const ok = p99 <= options.maxMs;
    const message = ok ? `p99 ${p99.toFixed(0)} ms is within the ${String(options.maxMs)} ms bound` : `p99 ${p99.toFixed(0)} ms is over the ${String(options.maxMs)} ms bound`;
    out(
      `freshness-gate: saves ${String(options.saves)} files ${String(files)} watch ${watchMode} p50 ${p50.toFixed(0)} ms p95 ${p95.toFixed(0)} ms p99 ${p99.toFixed(0)} ms ` +
        `max ${String(options.maxMs)} ms (nearest rank) ${ok ? 'OK' : 'OVER'}`,
    );
    return { samples, kinds, p50, p95, p99, ok, message, watchMode };
  } finally {
    if (composed !== undefined) await composed.dispose();
    removeTree(base);
  }
}

function whole(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new RangeError(`freshness-gate: --${name} must be a whole number, got ${JSON.stringify(text)}`);
  return Number(text);
}

/** The command-line body, with the output sink injected. Returns the exit code. */
export async function runCli(argv: string[], write: (text: string) => void, overrides: Partial<FreshnessGateOptions> = {}): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { saves: { type: 'string' }, 'max-ms': { type: 'string' }, files: { type: 'string' } },
    strict: true,
  });
  const result = await runFreshnessGate({
    saves: whole('saves', values.saves, DEFAULTS.saves),
    maxMs: whole('max-ms', values['max-ms'], FRESHNESS_NIGHTLY_P99_MS),
    files: whole('files', values.files, DEFAULTS.files),
    out: (line) => {
      write(`${line}\n`);
    },
    ...overrides,
  });
  if (!result.ok) write(`freshness-gate: ${result.message}\n`);
  return result.ok ? 0 : 1;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`freshness-gate: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
