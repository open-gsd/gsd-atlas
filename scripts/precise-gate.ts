/**
 * node scripts/precise-gate.ts --trace --corpus gsd-core [--dir <prepared checkout>] [--config tsconfig.json]
 *
 * The tracer's measurement (D-07, plan 03-23): build the checkout with the real composition root, ask `code_refs` for one
 * function until an answer has precise records, and print one JSON object on stdout: the owner config used, the compiler
 * source and version, the time to the first answer that has precise records, the references returned (EXTRACTED and
 * INFERRED), the worker's resident memory and the identity statistics per compiler declaration kind (declarations asked,
 * edges produced, declarations dropped). Exit 0 when at least one precise record exists for the traced function, 1 when
 * none does or a limit is exceeded, 2 on a usage error.
 *
 * `--trace` is the tracer's mode. The thresholds of the gates and the CI wiring belong to plan 03-30; the two limits below
 * are the tracer's own stop rule (a first precise answer slower than 30 seconds, or a worker above 1 GB, is reported and
 * stops the plan rather than being loosened). `--budget-mb <n>` runs it under a memory budget of n megabytes instead of the
 * machine's 25 percent of RAM (plan 03-27): a budget the project does not fit degrades the answer with `memory_budget`.
 *
 * node scripts/precise-gate.ts --nobreak --corpus gsd-pi --dir <checkout> [--budget-mb <n>] [--seed <n>] [--symbols <n>] [--lazy]
 *
 * Since plan 03-29 the build asks the compiler about every reference site before it returns (the eager pass), so the reads of
 * this trace are mostly cache hits and a memory stop happens during the build. `--lazy` builds without that pass, so each read
 * meets a cold cache and the trace shows the reads' own memory behavior, as plan 03-27 measured it.
 *
 * The no-break trace (plan 03-27, D-21, D-22): build an isolated index of the checkout, pick up to twelve symbols from
 * different packages (a seeded order of the packages; per package the first exported name another file of it mentions) and
 * ask `code_refs` for each. It prints one JSON object with, per answer, the tiers used, the degraded codes, whether any
 * record is EXTRACTED, the worker count and the worker's resident memory, and for the run the sampled peak of every worker
 * against the limit it was started with. Exit 0 when no request crashed the Host, no worker went above its limit by more than
 * the growth one sample interval allows (recorded in the output) and every answer is either resolved or carries a degraded
 * code; exit 1 otherwise. Resolved cross-package edges on gsd-pi are not a criterion (D-22).
 *
 * node scripts/precise-gate.ts --update --corpus gsd-core --dir <prepared checkout> [--max-wait-ms 60000]
 *
 * The update measure (plan 03-29, TSM-06): copy the checkout (its `node_modules` is linked, not copied), build the copy, ask for
 * the references of the traced function, then save one file of the copy, appending a comment and a new exported function that
 * calls the traced one, and print as one JSON object the milliseconds until `code_refs` returns a precise reference inside the
 * new function, with the number of update messages the worker was sent, its programs and its resident memory before and after.
 * Exit 0 when that answer arrived within a minute, 1 when it did not. The checkout itself is never edited. The gate thresholds
 * (5 seconds, and three times that) belong to plan 03-30.
 *
 * The checkout is the one `scripts/eval/prepare-corpus.ts` prepares (OQ8: `npm ci --ignore-scripts`, so the project's own
 * TypeScript 6.x is used). Without `--dir` this script prepares one in a temporary directory, which uses the network. The
 * checkout is only read; the store, the user directory and the cache go to a temporary directory that is removed at the end.
 * Dev-time tooling: nothing in the shipped package imports it.
 *
 * node scripts/precise-gate.ts [--pr | --strict] --corpus gsd-core|fixture [--dir <checkout>] [--prepared] [--samples-update n] [--samples-warm n]
 *
 * THE GATE (plan 03-30, D-10, TSM-06, ROADMAP criterion 2). Three budgets, judged two ways like the freshness gate: the pull
 * request tier (`--pr`) uses the approved loose ceilings `gate.buildPrCeilingMs`, `gate.updatePrCeilingMs` and
 * `gate.warmQueryPrCeilingMs`; the strict tier (`--strict`, nightly and local) uses the roadmap figures `gate.buildStrictMs`
 * (30 s), `gate.updateStrictMs` (5 s) and `gate.warmQueryStrictMs` (2 s). Every one is a row of 03-CONSTANTS.md that a person
 * approved; the exported constants carry the key in their names and a test compares them with the file. There is no flag that
 * moves a ceiling: an unknown flag is a usage error (exit 2).
 *
 * MEASUREMENT RULES (stated once, here):
 *   - build: the clock starts when the `build` request is sent and stops when it returns. The index build and the eager
 *     compiler pass of plan 03-29 are both inside it. One sample.
 *   - update: for each sample a different tracked source file that a compiler config owns is edited (a function and a call to
 *     it are appended). The clock starts when the file write returns and stops at the first `code_refs` answer, asked without
 *     any freshness argument and polled every 25 ms, that lists the new function as the caller of the new callee with a
 *     precise record. Failing to see it within a minute fails the gate.
 *   - warm: `code_refs` asked through the composed Host for a function whose edges the build cached. Symbols are found after
 *     the build by one untimed look at candidate names (the first look, which is printed as `firstLookMs`, is not a sample);
 *     the timed queries then cycle through them.
 *   - statistics: nearest rank (`percentile` of the freshness gate). The pull request tier gates the median of 5 update
 *     samples and the p95 of 10 warm samples, so one slow sample on a noisy runner does not fail a pull request. The strict
 *     tier gates the p95 of 20 update samples and the p95 of 50 warm samples.
 *   - a gate that cannot take its samples (the Host fails to build, no symbol qualifies, an edit never shows) fails with the
 *     reason and never passes by default.
 *
 * The corpus is the pinned one, fetched by `scripts/corpus-fetch.ts` into a temporary folder; nothing is installed, so the
 * compiler is the bundled one and its version and source are printed. `--prepared` runs `npm ci --ignore-scripts` in the
 * checkout first (the project's own compiler, what the eval uses), and so does a `--dir` checkout that has its own
 * `node_modules` only with `--prepared`. `--corpus fixture` generates a small repository instead.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { composeHost } from '../src/bin/compose.ts';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo } from '../src/test-kit/index.ts';
import { PROTOCOL_VERSION } from '../src/facts/index.ts';
import type { Envelope } from '../src/facts/index.ts';
import type { PreciseTier } from '../src/precise-resolver/index.ts';
import { MEMORY_DEFAULTS } from '../src/precise-resolver/index.ts';
import type { DerivedBudget, TypeScriptTierTuning } from '../src/precise-resolver/index.ts';
import { createProjectModel } from '../src/project-model/index.ts';
import type { ProjectFs } from '../src/project-model/index.ts';
import { createSourceTree } from '../src/source-tree/index.ts';
import { fetchCorpus } from './corpus-fetch.ts';
import { prepareCorpus } from './eval/prepare-corpus.ts';
import { percentile } from './freshness-gate.ts';

/** The tracer's stop rule. */
export const LIMITS = Object.freeze({ firstPreciseMs: 30_000, rssMb: 1024 });

/** What each corpus traces: the function and the file that defines it. */
const TRACES: Readonly<Record<string, { readonly symbol: string; readonly file: string }>> = Object.freeze({
  'gsd-core': { symbol: 'compareSemverCore', file: 'src/semver-compare.cts' },
});

const USAGE = [
  'usage: node scripts/precise-gate.ts --trace --corpus gsd-core [--dir <prepared checkout>] [--config tsconfig.json] [--max-wait-ms 120000] [--budget-mb <n>]',
  '       node scripts/precise-gate.ts --nobreak --corpus gsd-pi [--dir <checkout>] [--prepared] [--budget-mb <n>] [--seed <n>] [--symbols <n>] [--max-wait-ms 120000] [--lazy]',
  '       node scripts/precise-gate.ts --update --corpus gsd-core --dir <prepared checkout> [--max-wait-ms 60000]',
  '       node scripts/precise-gate.ts (--pr | --strict) --corpus gsd-core|fixture [--dir <checkout>] [--prepared] [--samples-update <n>] [--samples-warm <n>]',
  '',
].join('\n');

const MIB = 1_048_576;
/** The RAM that gives a budget of `budgetMb`: the budget is `precise.memoryBudgetPercent` of RAM. */
const ramForBudget = (budgetMb: number): number => Math.ceil((budgetMb * 100) / MEMORY_DEFAULTS.percent) * MIB;

interface RefRow {
  readonly tier: string;
  readonly confidence: string;
}

export interface Trace {
  readonly corpus: string;
  readonly dir: string;
  readonly symbol: string;
  readonly file: string;
  readonly config: string;
  readonly ownerConfig: string | null;
  readonly compiler: { readonly source: string; readonly version: string } | null;
  readonly buildMs: number;
  readonly firstPreciseMs: number | null;
  readonly reads: number;
  readonly degraded: readonly string[];
  readonly refs: { readonly total: number; readonly EXTRACTED: number; readonly INFERRED: number };
  readonly rssMb: number | null;
  readonly rssMbSampled: number | null;
  readonly stats: ReturnType<PreciseTier['stats']> | null;
  readonly identity: {
    readonly asked: number;
    readonly edges: number;
    readonly ratio: number | null;
    readonly byKind: Record<string, number | null>;
  };
  /** The memory budget this run used (plan 03-27): the machine's, or the one `--budget-mb` asked for. */
  readonly budget: DerivedBudget | null;
  readonly limits: typeof LIMITS;
  readonly withinLimits: boolean;
  readonly ok: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ratio = (edges: number, asked: number): number | null => (asked === 0 ? null : Math.round((edges / asked) * 10_000) / 10_000);

/** The resident memory of `pid` in megabytes, sampled with `ps`; null where that is not available (never a failure). */
function sampleRssMb(pid: number | undefined): number | null {
  if (pid === undefined || process.platform === 'win32') return null;
  try {
    const kilobytes = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isFinite(kilobytes) ? Math.round((kilobytes / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

/** The checkout as the compiler-free ProjectModel reads it (the same reader the Host uses). */
function projectFsOf(dir: string): ProjectFs {
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: dir });
  return {
    readText: (p) => tree.readText(dir, p),
    async exists(paths) {
      const found = new Set<string>();
      for (const p of paths) {
        const read = await tree.readText(dir, p, { maxBytes: 1 });
        if (read.kind === 'ok' || read.kind === 'too_large') found.add(p);
      }
      return found;
    },
  };
}

/** The config that owns `file`, found with the compiler-free ProjectModel over the checkout. */
async function ownerOf(dir: string, file: string): Promise<string | null> {
  const fsView = projectFsOf(dir);
  const model = createProjectModel('typescript', fsView);
  if (model === undefined) return null;
  const description = await model.describe({ overlayPaths: [file], fs: fsView });
  return description.ownerOf(file) ?? null;
}

/** The files of `files` that some compiler config of the checkout owns: only those can have precise records. */
async function ownedAmong(dir: string, files: readonly string[]): Promise<Set<string>> {
  const fsView = projectFsOf(dir);
  const model = createProjectModel('typescript', fsView);
  if (model === undefined) return new Set();
  const description = await model.describe({ overlayPaths: [...files], fs: fsView });
  return new Set(files.filter((file) => description.ownerOf(file) !== undefined));
}

export interface TraceOptions {
  readonly corpus: string;
  readonly dir: string;
  readonly config: string;
  readonly maxWaitMs: number;
  /** Run under a memory budget of this many megabytes instead of the machine's. */
  readonly budgetMb?: number;
}

export async function runTrace(options: TraceOptions): Promise<Trace> {
  const target = TRACES[options.corpus];
  if (target === undefined) throw new Error(`no trace is defined for corpus ${options.corpus}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-precise-'));
  let tier: PreciseTier | undefined;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GSD_ATLAS_USER_DIR: path.join(scratch, 'user'),
    GSD_ATLAS_STORE_DIR: path.join(scratch, 'store'),
  };
  const composed = composeHost({
    cwd: options.dir,
    env,
    home: path.join(scratch, 'home'),
    stderr: process.stderr,
    ...(options.budgetMb === undefined ? {} : { totalMemBytes: ramForBudget(options.budgetMb) }),
    tierHook: (built) => {
      tier = built;
    },
  });
  try {
    const startedBuild = Date.now();
    const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: options.dir } });
    if (!built.ok) throw new Error(`build failed: ${built.diagnostics.map((entry) => entry.code).join(', ')}`);
    const buildMs = Date.now() - startedBuild;

    const startedReads = Date.now();
    let reads = 0;
    let answer: Envelope | undefined;
    let firstPreciseMs: number | null = null;
    while (Date.now() - startedReads < options.maxWaitMs) {
      reads += 1;
      answer = await composed.client.handle({
        protocol: PROTOCOL_VERSION,
        kind: 'code_refs',
        args: { name: target.symbol, path: target.file, repo: options.dir, limit: 200 },
      });
      const rows = answer.ok ? (answer.data as { results: RefRow[] }).results : [];
      if (rows.some((row) => row.tier === 'precise')) {
        firstPreciseMs = Date.now() - startedReads;
        break;
      }
      // Without a worker (no tsconfig, tier off) nothing will turn precise; wait only while a read says it is still resolving.
      if (!(answer.degraded ?? []).includes('resolver_timeout')) break;
      await sleep(250);
    }
    const rows = answer?.ok === true ? (answer.data as { results: RefRow[] }).results : [];
    const extracted = rows.filter((row) => row.confidence === 'EXTRACTED').length;
    const stats = tier?.stats() ?? null;
    const [info] = tier?.info() ?? [];
    const asked = stats === null ? 0 : Object.values(stats.byKind).reduce((sum, each) => sum + each.asked, 0);
    const edges = stats === null ? 0 : Object.values(stats.byKind).reduce((sum, each) => sum + each.edges, 0);
    const byKind: Record<string, number | null> = {};
    for (const [kind, each] of Object.entries(stats?.byKind ?? {})) byKind[kind] = ratio(each.edges, each.asked);
    const rssMbSampled = sampleRssMb(info?.pid);
    const rssMb = info === undefined ? null : Math.round(info.rssMb * 10) / 10;
    const worst = Math.max(rssMb ?? 0, rssMbSampled ?? 0);
    const withinLimits = (firstPreciseMs === null || firstPreciseMs <= LIMITS.firstPreciseMs) && worst <= LIMITS.rssMb;
    return {
      corpus: options.corpus,
      dir: options.dir,
      symbol: target.symbol,
      file: target.file,
      config: options.config,
      ownerConfig: await ownerOf(options.dir, target.file),
      compiler: info === undefined ? null : { source: info.compiler.source, version: info.compiler.version },
      buildMs,
      firstPreciseMs,
      reads,
      degraded: answer?.degraded ?? [],
      refs: { total: rows.length, EXTRACTED: extracted, INFERRED: rows.length - extracted },
      rssMb,
      rssMbSampled,
      stats,
      identity: { asked, edges, ratio: ratio(edges, asked), byKind },
      budget: tier?.memory.budget.derived ?? null,
      limits: LIMITS,
      withinLimits,
      // Under a budget the project does not fit, the honest result is the degraded answer, not a precise record.
      ok: (firstPreciseMs !== null || (options.budgetMb !== undefined && (answer?.degraded ?? []).includes('memory_budget'))) && withinLimits,
    };
  } finally {
    await composed.dispose();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// --nobreak (plan 03-27)

export interface NoBreakOptions {
  /** A label for the output; the checkout is what is traced. */
  readonly corpus: string;
  readonly dir: string;
  /** Run under a memory budget of this many megabytes instead of the machine's 25 percent of RAM. */
  readonly budgetMb?: number;
  /** The seed of the order the packages are taken in. Default 27. */
  readonly seed?: number;
  /** The most symbols asked. Default 12. */
  readonly symbols?: number;
  /** The longest one symbol is waited for while the compiler is still working. */
  readonly maxWaitMs: number;
  /** `seeded` (default) shuffles the packages with the seed; `name` takes them in name order (a test). */
  readonly order?: 'seeded' | 'name';
  /** TEST HOOK. Tuning of the tier (a worker limit, the sampler's period). */
  readonly precise?: Omit<TypeScriptTierTuning, 'memory'>;
  /** Extra environment for the git and Host children (the test kit's isolated git configuration). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Build without the eager compiler pass (plan 03-29), so each read meets a cold cache and starts or feeds the compiler
   * itself: the memory behavior of the reads, as plan 03-27 measured it. Default false: the build asks the compiler about every
   * site, as the product does.
   */
  readonly lazy?: boolean;
}

export type NoBreakOutcome = 'resolved' | 'degraded' | 'empty' | 'unexplained' | 'crashed';

export interface NoBreakAnswer {
  readonly package: string;
  readonly symbol: string;
  readonly file: string;
  readonly refs: number;
  /** The tiers of the returned records. */
  readonly tiers: readonly string[];
  readonly degraded: readonly string[];
  /** True when any returned record is EXTRACTED. */
  readonly extracted: boolean;
  /** Compiler workers alive when the answer was complete. */
  readonly workers: number;
  /** The resident memory the worker reported after its last request, and the largest it reported, in megabytes. */
  readonly workerRssMb: number | null;
  readonly peakRssMb: number | null;
  readonly ms: number;
  readonly outcome: NoBreakOutcome;
}

export interface NoBreakReport {
  readonly corpus: string;
  readonly dir: string;
  readonly machine: { readonly totalMemMb: number };
  /** The budget the run used, and where it came from. */
  readonly budget: DerivedBudget & { readonly source: 'machine' | '--budget-mb' };
  readonly buildMs: number;
  readonly answers: readonly NoBreakAnswer[];
  readonly workers: {
    /** Distinct worker processes seen. */
    readonly seen: number;
    /** The largest resident memory of any worker, from `ps` samples and the workers' own reports; null when there was none. */
    readonly peakRssMb: number | null;
    /** The largest growth between two consecutive samples of one worker: what one sample interval can add. */
    readonly growthAllowanceMb: number | null;
    /** The limit the workers were started with. */
    readonly limitMb: number;
    /** True when no worker went above its limit by more than the growth allowance. */
    readonly withinLimit: boolean;
  };
  readonly crashed: number;
  readonly unexplained: number;
  readonly elapsedMs: number;
  readonly ok: boolean;
}

/** A small seeded generator (mulberry32): the same seed gives the same order on every machine. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
const SKIPPED_FILE = /\.d\.[cm]?ts$|(?:^|\/)(?:test|tests|__tests__|node_modules)\/|\.(?:test|spec)\./;
const EXPORT_NAME = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|abstract\s+class|const)\s+([A-Za-z_$][\w$]*)/gm;
/** The most exported names tried per package before it is given up (a script-local bound, not a product constant). */
const CANDIDATES_PER_PACKAGE = 50;
const MAX_SOURCE_BYTES = 512 * 1024;

function trackedFiles(dir: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const out = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...env } });
  return out.split('\0').filter((entry) => entry !== '');
}

/** Each tracked source file grouped by the nearest directory that holds a package.json ('.' for the root). */
function filesByPackage(files: readonly string[]): Map<string, string[]> {
  const packageDirs = new Set<string>(files.filter((file) => file === 'package.json' || file.endsWith('/package.json')).map((file) => file.slice(0, Math.max(0, file.length - '/package.json'.length))));
  const groups = new Map<string, string[]>();
  for (const file of files) {
    if (!SOURCE_FILE.test(file) || SKIPPED_FILE.test(file)) continue;
    let dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    while (dir !== '' && !packageDirs.has(dir)) dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const key = dir === '' ? '.' : dir;
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  for (const list of groups.values()) list.sort();
  return groups;
}

/** The first exported function, class or constant of the package that another file of the package mentions. */
function firstDefinition(dir: string, files: readonly string[], taken: ReadonlySet<string>): { readonly symbol: string; readonly file: string } | undefined {
  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    let text = texts.get(file);
    if (text === undefined) {
      try {
        const buffer = fs.readFileSync(path.join(dir, file));
        text = buffer.length > MAX_SOURCE_BYTES ? '' : buffer.toString('utf8');
      } catch {
        text = '';
      }
      texts.set(file, text);
    }
    return text;
  };
  let tried = 0;
  for (const file of files) {
    for (const match of textOf(file).matchAll(EXPORT_NAME)) {
      const symbol = match[1];
      if (symbol === undefined || symbol.length < 4 || taken.has(symbol)) continue;
      tried += 1;
      if (tried > CANDIDATES_PER_PACKAGE) return undefined;
      const word = new RegExp(`\\b${symbol.replaceAll('$', '\\$')}\\b`);
      if (files.some((other) => other !== file && word.test(textOf(other)))) return { symbol, file };
    }
  }
  return undefined;
}

export async function runNoBreak(options: NoBreakOptions): Promise<NoBreakReport> {
  const startedAt = Date.now();
  const extraEnv = options.env ?? {};
  const wanted = options.symbols ?? 12;

  // The symbols: packages in a seeded order, the first definition per package.
  const groups = filesByPackage(trackedFiles(options.dir, extraEnv));
  const order = [...groups.keys()].sort();
  if (options.order !== 'name') {
    const random = seededRandom(options.seed ?? 27);
    for (let at = order.length - 1; at > 0; at -= 1) {
      const swap = Math.floor(random() * (at + 1));
      [order[at], order[swap]] = [order[swap] as string, order[at] as string];
    }
  }
  const picked: Array<{ readonly package: string; readonly symbol: string; readonly file: string }> = [];
  const taken = new Set<string>();
  for (const name of order) {
    if (picked.length >= wanted) break;
    const found = firstDefinition(options.dir, groups.get(name) ?? [], taken);
    if (found === undefined) continue;
    taken.add(found.symbol);
    picked.push({ package: name, ...found });
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-nobreak-'));
  const tiers: PreciseTier[] = [];
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...extraEnv,
    GSD_ATLAS_USER_DIR: path.join(scratch, 'user'),
    GSD_ATLAS_STORE_DIR: path.join(scratch, 'store'),
  };
  const composed = composeHost({
    cwd: options.dir,
    env,
    home: path.join(scratch, 'home'),
    stderr: process.stderr,
    ...(options.budgetMb === undefined ? {} : { totalMemBytes: ramForBudget(options.budgetMb) }),
    ...(options.precise === undefined ? {} : { precise: options.precise }),
    ...(options.lazy === true ? { tuning: { resolveBoundMs: 0 } } : {}),
    tierHook: (built) => {
      tiers.push(built);
    },
  });

  // Every sample period, the resident memory of every live worker as the operating system sees it (where `ps` exists).
  const pids = new Set<number>();
  const lastSample = new Map<number, number>();
  let peakSampled: number | null = null;
  let growth: number | null = null;
  const poll = (): void => {
    for (const each of tiers) {
      for (const info of each.info()) {
        if (info.pid === undefined) continue;
        pids.add(info.pid);
        const sample = sampleRssMb(info.pid);
        if (sample === null) continue;
        peakSampled = Math.max(peakSampled ?? 0, sample);
        const before = lastSample.get(info.pid);
        if (before !== undefined) growth = Math.max(growth ?? 0, sample - before);
        lastSample.set(info.pid, sample);
      }
    }
  };
  const timer = setInterval(poll, MEMORY_DEFAULTS.sampleMs);

  const answers: NoBreakAnswer[] = [];
  let buildMs = 0;
  try {
    const startedBuild = Date.now();
    const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: options.dir } });
    if (!built.ok) throw new Error(`build failed: ${built.diagnostics.map((entry) => entry.code).join(', ')}`);
    buildMs = Date.now() - startedBuild;

    for (const entry of picked) {
      const started = Date.now();
      let answer: Envelope | undefined;
      let crashed = false;
      try {
        for (;;) {
          answer = await composed.client.handle({
            protocol: PROTOCOL_VERSION,
            kind: 'code_refs',
            args: { name: entry.symbol, path: entry.file, repo: options.dir, limit: 200 },
          });
          if (!answer.ok) break;
          const rows = (answer.data as { results: RefRow[] }).results;
          if (rows.some((row) => row.tier === 'precise')) break;
          if (!(answer.degraded ?? []).includes('resolver_timeout') || Date.now() - started >= options.maxWaitMs) break;
          await sleep(250);
        }
      } catch {
        crashed = true;
      }
      poll();
      const rows = answer?.ok === true ? (answer.data as { results: RefRow[] }).results : [];
      const degraded = answer?.degraded ?? [];
      const infos = tiers.flatMap((each) => each.info());
      const rss = infos.map((info) => info.lastRssMb);
      const peaks = infos.map((info) => info.peakRssMb);
      const tiersUsed = [...new Set(rows.map((row) => row.tier))].sort();
      let outcome: NoBreakOutcome;
      if (crashed || answer === undefined || !answer.ok) outcome = 'crashed';
      else if (rows.some((row) => row.tier === 'precise')) outcome = 'resolved';
      else if (degraded.length > 0) outcome = 'degraded';
      else if (rows.length === 0) outcome = 'empty';
      else outcome = 'unexplained';
      answers.push({
        package: entry.package,
        symbol: entry.symbol,
        file: entry.file,
        refs: rows.length,
        tiers: tiersUsed,
        degraded,
        extracted: rows.some((row) => row.confidence === 'EXTRACTED'),
        workers: tiers[0]?.memory.pool.status().workers.length ?? 0,
        workerRssMb: rss.length === 0 ? null : Math.round(Math.max(...rss) * 10) / 10,
        peakRssMb: peaks.length === 0 ? null : Math.round(Math.max(...peaks) * 10) / 10,
        ms: Date.now() - started,
        outcome,
      });
    }

    const derived = tiers[0]?.memory.budget.derived ?? { budgetMb: 0, heapMb: 0, rssLimitMb: 0, usable: false };
    const limitMb = options.precise?.rssLimitMb ?? derived.rssLimitMb;
    const reported = answers.map((answer) => answer.peakRssMb).filter((value): value is number => value !== null);
    const peak = [peakSampled, ...reported].filter((value): value is number => value !== null);
    const peakRssMb = peak.length === 0 ? null : Math.max(...peak);
    const growthAllowanceMb = growth === null ? null : Math.round(growth * 10) / 10;
    const withinLimit = peakRssMb === null || peakRssMb - limitMb <= (growthAllowanceMb ?? 0);
    const crashedCount = answers.filter((answer) => answer.outcome === 'crashed').length;
    const unexplained = answers.filter((answer) => answer.outcome === 'unexplained').length;
    return {
      corpus: options.corpus,
      dir: options.dir,
      machine: { totalMemMb: Math.round(os.totalmem() / MIB) },
      budget: { ...derived, source: options.budgetMb === undefined ? 'machine' : '--budget-mb' },
      buildMs,
      answers,
      workers: { seen: pids.size, peakRssMb: peakRssMb === null ? null : Math.round(peakRssMb * 10) / 10, growthAllowanceMb, limitMb, withinLimit },
      crashed: crashedCount,
      unexplained,
      elapsedMs: Date.now() - startedAt,
      ok: answers.length > 0 && crashedCount === 0 && unexplained === 0 && withinLimit,
    };
  } finally {
    clearInterval(timer);
    await composed.dispose();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// --update (plan 03-29, TSM-06)

/** The update measure's stop rule: an answer that reflects the edit must arrive within a minute. The gate thresholds are plan 03-30's. */
export const UPDATE_LIMIT_MS = 60_000;

/** The function the edit appends: it calls the traced function, so the answer reflects the edit by one more reference. */
const PROBE_NAME = 'atlasUpdateProbe';
const probeText = (symbol: string): string => `\n// atlas update probe\nexport function ${PROBE_NAME}(): number {\n  return ${symbol}('1.0.0', '1.0.1');\n}\n`;

export interface UpdateOptions {
  readonly corpus: string;
  /** A prepared checkout. It is copied; the copy is edited. */
  readonly dir: string;
  readonly maxWaitMs: number;
  /** Extra environment for the git and Host children (the test kit's isolated git configuration). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface UpdateReport {
  readonly corpus: string;
  readonly dir: string;
  readonly symbol: string;
  readonly file: string;
  readonly buildMs: number;
  /** From writing the edit to the first `code_refs` answer that has a precise reference inside the appended function. */
  readonly editToPreciseMs: number | null;
  readonly reads: number;
  readonly before: { readonly total: number; readonly precise: number };
  readonly after: { readonly total: number; readonly precise: number };
  readonly probe: { readonly tier: string | null; readonly confidence: string | null };
  /** `update` messages sent to the worker, and the paths they listed. */
  readonly updates: number;
  readonly updatedPaths: number;
  readonly worker: {
    readonly programs: number;
    readonly rssMbBefore: number | null;
    readonly rssMbAfter: number | null;
    readonly peakRssMb: number | null;
    readonly rssMbSampledAfter: number | null;
  };
  readonly limits: { readonly updateMs: number };
  readonly ok: boolean;
}

/** The checkout copied without `node_modules`, which is linked instead: the project's own compiler is used, and copying it would take a minute. */
function copyCheckout(source: string, dest: string, linkModules = true): void {
  fs.cpSync(source, dest, { recursive: true, filter: (from) => path.basename(from) !== 'node_modules' });
  const modules = path.join(source, 'node_modules');
  if (linkModules && fs.existsSync(modules)) fs.symlinkSync(fs.realpathSync.native(modules), path.join(dest, 'node_modules'), 'junction');
}

interface ProbeRow extends RefRow {
  readonly enclosing?: string | null;
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateReport> {
  const target = TRACES[options.corpus];
  if (target === undefined) throw new Error(`no trace is defined for corpus ${options.corpus}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-update-'));
  const copy = path.join(scratch, 'checkout');
  const tiers: PreciseTier[] = [];
  let updates = 0;
  let updatedPaths = 0;
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(options.env ?? {}),
    GSD_ATLAS_USER_DIR: path.join(scratch, 'user'),
    GSD_ATLAS_STORE_DIR: path.join(scratch, 'store'),
  };
  try {
    copyCheckout(options.dir, copy);
    const composed = composeHost({
      cwd: copy,
      env,
      home: path.join(scratch, 'home'),
      stderr: process.stderr,
      precise: {
        onWire: (event) => {
          if (event.dir === 'out' && event.message.t === 'update') {
            updates += 1;
            updatedPaths += event.message.changed.length + event.message.removed.length;
          }
        },
      },
      tierHook: (built) => {
        tiers.push(built);
      },
    });
    try {
      const startedBuild = Date.now();
      const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: copy } });
      if (!built.ok) throw new Error(`build failed: ${built.diagnostics.map((entry) => entry.code).join(', ')}`);
      const buildMs = Date.now() - startedBuild;

      const refs = async (): Promise<ProbeRow[]> => {
        const answer = await composed.client.handle({
          protocol: PROTOCOL_VERSION,
          kind: 'code_refs',
          args: { name: target.symbol, path: target.file, repo: copy, limit: 200 },
        });
        return answer.ok ? (answer.data as { results: ProbeRow[] }).results : [];
      };
      const count = (rows: readonly ProbeRow[]): { total: number; precise: number } => ({ total: rows.length, precise: rows.filter((row) => row.tier === 'precise').length });
      const sampled = (): number | null => sampleRssMb(tiers.flatMap((each) => each.info())[0]?.pid);

      // The state before the edit: the traced function's references, answered from what the build stored.
      let baseline = await refs();
      for (let waited = Date.now(); !baseline.some((row) => row.tier === 'precise') && Date.now() - waited < options.maxWaitMs; ) {
        await sleep(250);
        baseline = await refs();
      }
      const rssMbBefore = tiers.flatMap((each) => each.info())[0]?.lastRssMb ?? null;

      // Save one file: append a comment and a new exported function that calls the traced one.
      const file = path.join(copy, target.file);
      const original = fs.readFileSync(file, 'utf8');
      const editedAt = Date.now();
      fs.writeFileSync(file, `${original}${probeText(target.symbol)}`);

      let reads = 0;
      let editToPreciseMs: number | null = null;
      let last: ProbeRow[] = [];
      let probe: ProbeRow | undefined;
      while (Date.now() - editedAt < Math.min(options.maxWaitMs, UPDATE_LIMIT_MS)) {
        reads += 1;
        last = await refs();
        probe = last.find((row) => row.enclosing === PROBE_NAME);
        if (probe?.tier === 'precise') {
          editToPreciseMs = Date.now() - editedAt;
          break;
        }
        await sleep(50);
      }
      const [info] = tiers.flatMap((each) => each.info());
      return {
        corpus: options.corpus,
        dir: options.dir,
        symbol: target.symbol,
        file: target.file,
        buildMs,
        editToPreciseMs,
        reads,
        before: count(baseline),
        after: count(last),
        probe: { tier: probe?.tier ?? null, confidence: probe?.confidence ?? null },
        updates,
        updatedPaths,
        worker: {
          programs: info?.programs ?? 0,
          rssMbBefore: rssMbBefore === null ? null : Math.round(rssMbBefore * 10) / 10,
          rssMbAfter: info === undefined ? null : Math.round(info.lastRssMb * 10) / 10,
          peakRssMb: info === undefined ? null : Math.round(info.peakRssMb * 10) / 10,
          rssMbSampledAfter: sampled(),
        },
        limits: { updateMs: UPDATE_LIMIT_MS },
        ok: editToPreciseMs !== null && baseline.some((row) => row.tier === 'precise'),
      };
    } finally {
      await composed.dispose();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The gate: --pr and --strict (plan 03-30, D-10, TSM-06)

// Each constant is named after its row of 03-CONSTANTS.md (Status: Approved). The three pull request ceilings are the approved
// looser rows (D-10: three times the roadmap figure); the three strict figures are ROADMAP criterion 2, locked. A test reads
// the file and compares, and there is no flag that overrides one.

/** `gate.buildPrCeilingMs`: the full build, including the eager pass, on a pull request. */
export const BUILD_PR_CEILING_MS = 90_000;
/** `gate.updatePrCeilingMs`: save one file to a precise answer that reflects it, on a pull request. */
export const UPDATE_PR_CEILING_MS = 15_000;
/** `gate.warmQueryPrCeilingMs`: a warm `code_refs`, on a pull request. */
export const WARM_QUERY_PR_CEILING_MS = 6_000;
/** `gate.buildStrictMs`: ROADMAP criterion 2, 30 seconds. */
export const BUILD_STRICT_MS = 30_000;
/** `gate.updateStrictMs`: ROADMAP criterion 2, 5 seconds. */
export const UPDATE_STRICT_MS = 5_000;
/** `gate.warmQueryStrictMs`: ROADMAP criterion 2, 2 seconds. */
export const WARM_QUERY_STRICT_MS = 2_000;

export type GateTier = 'pr' | 'strict';

/** Samples per tier (plan 03-30): the pull request tier gates the median of 5 updates and the p95 of 10 warm queries; the strict tier the p95 of 20 and of 50. */
export const GATE_SAMPLES: Readonly<Record<GateTier, { readonly update: number; readonly warm: number }>> = Object.freeze({
  pr: Object.freeze({ update: 5, warm: 10 }),
  strict: Object.freeze({ update: 20, warm: 50 }),
});

/** How often the update clock asks again (the freshness gate's poll interval). */
const GATE_POLL_MS = 25;

export interface Measurements {
  /** Milliseconds from the build request to its answer. */
  readonly buildMs: number;
  /** One per sample: from the file write to the first answer that reflects it. */
  readonly updateMs: readonly number[];
  /** One per sample: one warm `code_refs`. */
  readonly warmMs: readonly number[];
}

export type Budget = 'build' | 'update' | 'warm';

export interface Verdict {
  readonly budget: Budget;
  /** The `03-CONSTANTS.md` key of the ceiling used. */
  readonly key: string;
  readonly statistic: 'single' | 'median' | 'p95';
  readonly samples: number;
  readonly valueMs: number;
  readonly ceilingMs: number;
  readonly ok: boolean;
}

export interface Evaluation {
  readonly tier: GateTier;
  readonly verdicts: readonly Verdict[];
  readonly ok: boolean;
}

const JUDGEMENT = Object.freeze({
  pr: {
    build: { key: 'gate.buildPrCeilingMs', ceilingMs: BUILD_PR_CEILING_MS },
    update: { key: 'gate.updatePrCeilingMs', ceilingMs: UPDATE_PR_CEILING_MS, statistic: 'median' },
    warm: { key: 'gate.warmQueryPrCeilingMs', ceilingMs: WARM_QUERY_PR_CEILING_MS, statistic: 'p95' },
  },
  strict: {
    build: { key: 'gate.buildStrictMs', ceilingMs: BUILD_STRICT_MS },
    update: { key: 'gate.updateStrictMs', ceilingMs: UPDATE_STRICT_MS, statistic: 'p95' },
    warm: { key: 'gate.warmQueryStrictMs', ceilingMs: WARM_QUERY_STRICT_MS, statistic: 'p95' },
  },
} as const);

/** The samples sorted ascending; throws when there are none or one is not a duration (a gate that could not measure never passes). */
function sortedDurations(label: string, values: readonly number[]): number[] {
  if (values.length === 0) throw new RangeError(`${label}: no samples`);
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label}: ${String(value)} is not a duration`);
  }
  return [...values].sort((a, b) => a - b);
}

/** Judge the measurements against the tier's ceilings. Pure. Nearest-rank percentiles (the freshness gate's `percentile`). */
export function evaluate(measurements: Measurements, tier: GateTier): Evaluation {
  const rules = JUDGEMENT[tier];
  const [build] = sortedDurations('build', [measurements.buildMs]);
  const update = sortedDurations('update', measurements.updateMs);
  const warm = sortedDurations('warm', measurements.warmMs);
  const pick = (sorted: readonly number[], statistic: 'median' | 'p95'): number => percentile(sorted, statistic === 'median' ? 50 : 95);
  const verdicts: Verdict[] = [
    { budget: 'build', key: rules.build.key, statistic: 'single', samples: 1, valueMs: build as number, ceilingMs: rules.build.ceilingMs, ok: (build as number) <= rules.build.ceilingMs },
    (() => {
      const valueMs = pick(update, rules.update.statistic);
      return { budget: 'update' as const, key: rules.update.key, statistic: rules.update.statistic, samples: update.length, valueMs, ceilingMs: rules.update.ceilingMs, ok: valueMs <= rules.update.ceilingMs };
    })(),
    (() => {
      const valueMs = pick(warm, rules.warm.statistic);
      return { budget: 'warm' as const, key: rules.warm.key, statistic: rules.warm.statistic, samples: warm.length, valueMs, ceilingMs: rules.warm.ceilingMs, ok: valueMs <= rules.warm.ceilingMs };
    })(),
  ];
  return { tier, verdicts, ok: verdicts.every((verdict) => verdict.ok) };
}

/** What one measured run hands back: the numbers, and the facts that make two runs comparable. */
export interface GateRun {
  readonly corpus: string;
  /** The compiler the worker used; null when no worker ran (then no update sample could have been taken). */
  readonly compiler: { readonly source: string; readonly version: string } | null;
  readonly workerPeakRssMb: number | null;
  /** Distinct functions the warm queries cycled through. */
  readonly warmSymbols: number;
  readonly measurements: Measurements;
  /** The untimed first look at each warm function, in milliseconds (not gated; printed so a cold cost stays visible). */
  readonly firstLookMs?: readonly number[];
}

export interface GateRunOptions {
  readonly tier: GateTier;
  readonly corpus: string;
  /** A checkout to copy; without it the pinned corpus is fetched (or generated, for `fixture`). */
  readonly dir?: string;
  /** Run `npm ci --ignore-scripts` (fetched corpus) or link the checkout's `node_modules` (`--dir`): the project's own compiler. */
  readonly prepared: boolean;
  readonly samplesUpdate: number;
  readonly samplesWarm: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

// A generated repository for the tracer and the tests: `.cts` modules under one tsconfig, one file that calls them all.
const FIXTURE_TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);
const FIXTURE_MIN_MODULES = 24;

/** The files of the fixture repository: `modules` small `.cts` files and `src/use.cts`, which imports and calls every one. */
export function fixtureFiles(modules: number): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'fixture-gate', private: true }), 'tsconfig.json': FIXTURE_TSCONFIG };
  const imports: string[] = [];
  const calls: string[] = [];
  for (let index = 0; index < modules; index += 1) {
    const id = String(index).padStart(3, '0');
    files[`src/mod${id}.cts`] = `export function fixtureFn${id}(value: number): number {\n  return value + ${String(index)};\n}\n`;
    imports.push(`import { fixtureFn${id} } from './mod${id}.cjs';`);
    calls.push(`fixtureFn${id}(1)`);
  }
  files['src/use.cts'] = `${imports.join('\n')}\n\nexport function useAllFixtureFunctions(): number {\n  return ${calls.join(' + ')};\n}\n`;
  return files;
}

interface Workspace {
  readonly dir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cleanup: () => void;
}

/** The pinned corpus fetched (or prepared) into a new temporary folder. */
export async function fetchCheckout(corpus: string, prepared: boolean): Promise<{ readonly dir: string; readonly cleanup: () => void }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-precise-fetch-'));
  const cleanup = (): void => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  try {
    const dir = prepared ? prepareCorpus({ id: corpus, dest: scratch, npmCi: true }).dir : (await fetchCorpus({ id: corpus, destination: scratch })).dir;
    return { dir: fs.realpathSync.native(dir), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function openWorkspace(options: GateRunOptions, scratch: string): Promise<Workspace> {
  if (options.corpus === 'fixture') {
    const repo = await createTempGitRepo({
      runner: createRealRunner({ decide: allowAll }),
      world: { committed: fixtureFiles(Math.max(FIXTURE_MIN_MODULES, options.samplesUpdate + 4)) },
    });
    return { dir: fs.realpathSync.native(repo.dir), env: repo.envOverlay, cleanup: () => repo.cleanup() };
  }
  if (options.dir !== undefined) {
    const copy = path.join(scratch, 'checkout');
    copyCheckout(options.dir, copy, options.prepared);
    return { dir: fs.realpathSync.native(copy), env: {}, cleanup: () => undefined };
  }
  const fetched = await fetchCheckout(options.corpus, options.prepared);
  return { dir: fetched.dir, env: {}, cleanup: fetched.cleanup };
}

/** Tracked files that look like compiler sources, in name order. */
function sourceCandidates(dir: string, env: Readonly<Record<string, string | undefined>>): string[] {
  return trackedFiles(dir, env)
    .filter((file) => SOURCE_FILE.test(file) && !SKIPPED_FILE.test(file))
    .sort();
}

/** `count` files spread evenly over `files`; throws when there are fewer. */
function spread(files: readonly string[], count: number, what: string): string[] {
  if (files.length < count) throw new Error(`${what}: ${String(files.length)} usable files, ${String(count)} samples need one each`);
  return Array.from({ length: count }, (_, at) => files[Math.floor((at * files.length) / count)] as string);
}

/** Exported functions, classes and constants of `files` that another one of them mentions, in file order, at most `limit`. */
function exportedCandidates(dir: string, files: readonly string[], limit: number): Array<{ readonly symbol: string; readonly file: string }> {
  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    let text = texts.get(file);
    if (text === undefined) {
      try {
        const buffer = fs.readFileSync(path.join(dir, file));
        text = buffer.length > MAX_SOURCE_BYTES ? '' : buffer.toString('utf8');
      } catch {
        text = '';
      }
      texts.set(file, text);
    }
    return text;
  };
  const found: Array<{ symbol: string; file: string }> = [];
  const taken = new Set<string>();
  let tried = 0;
  for (const file of files) {
    for (const match of textOf(file).matchAll(EXPORT_NAME)) {
      const symbol = match[1];
      if (symbol === undefined || symbol.length < 4 || taken.has(symbol)) continue;
      tried += 1;
      if (tried > limit * 10) return found;
      const word = new RegExp(`\\b${symbol.replaceAll('$', '\\$')}\\b`);
      if (!files.some((other) => other !== file && word.test(textOf(other)))) continue;
      taken.add(symbol);
      found.push({ symbol, file });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/** The function the update samples append, and the call to it: the answer that lists the caller is the answer that reflects the edit. */
function gateProbe(index: number): { readonly callee: string; readonly caller: string; readonly text: string } {
  const callee = `atlasGateCallee${String(index)}`;
  const caller = `atlasGateCaller${String(index)}`;
  return { callee, caller, text: `\n// atlas gate probe\nfunction ${callee}(): number {\n  return ${String(index)};\n}\nfunction ${caller}(): number {\n  return ${callee}();\n}\n` };
}

/** Build, warm-query and update-edit one checkout through the composed Host, and report the milliseconds. */
export async function runGate(options: GateRunOptions): Promise<GateRun> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-gate-'));
  let workspace: Workspace | undefined;
  let composed: ReturnType<typeof composeHost> | undefined;
  const tiers: PreciseTier[] = [];
  try {
    workspace = await openWorkspace(options, scratch);
    const { dir } = workspace;

    // Which files to edit and which functions to ask about: only files a compiler config owns can have precise records.
    const owned = await ownedAmong(dir, sourceCandidates(dir, workspace.env));
    const ownedFiles = [...owned].sort();
    if (ownedFiles.length === 0) throw new Error('no source file of the checkout is owned by a compiler config; there is nothing to measure');
    const editFiles = spread(ownedFiles, options.samplesUpdate, 'update samples');
    const candidates = exportedCandidates(dir, ownedFiles, 120);
    const traced = TRACES[options.corpus];
    if (traced !== undefined && ownedFiles.includes(traced.file) && !candidates.some((entry) => entry.symbol === traced.symbol)) candidates.unshift(traced);

    for (const each of [path.join(scratch, 'home'), path.join(scratch, 'user'), path.join(scratch, 'store')]) fs.mkdirSync(each, { recursive: true });
    composed = composeHost({
      cwd: dir,
      env: { ...process.env, ...workspace.env, GSD_ATLAS_USER_DIR: path.join(scratch, 'user'), GSD_ATLAS_STORE_DIR: path.join(scratch, 'store') },
      home: path.join(scratch, 'home'),
      stderr: process.stderr,
      tierHook: (built) => {
        tiers.push(built);
      },
    });
    const host = composed;
    const refs = async (name: string, file: string): Promise<{ readonly ok: boolean; readonly rows: ProbeRow[] }> => {
      const answer = await host.client.handle({ protocol: PROTOCOL_VERSION, kind: 'code_refs', args: { name, path: file, repo: dir, limit: 200 } });
      return { ok: answer.ok, rows: answer.ok ? (answer.data as { results: ProbeRow[] }).results : [] };
    };

    // Build: from the request to its answer, the eager pass included.
    const startedBuild = performance.now();
    const built = await host.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: dir } });
    const buildMs = round1(performance.now() - startedBuild);
    if (!built.ok) throw new Error(`build failed: ${built.diagnostics.map((entry) => entry.code).join(', ')}`);

    // Warm queries: one untimed first look at candidate functions until enough have a precise record, then the timed cycle.
    const wanted = Math.min(10, options.samplesWarm);
    const symbols: Array<{ readonly symbol: string; readonly file: string }> = [];
    const firstLookMs: number[] = [];
    for (const entry of candidates) {
      if (symbols.length >= wanted) break;
      const began = performance.now();
      const looked = await refs(entry.symbol, entry.file);
      firstLookMs.push(round1(performance.now() - began));
      if (looked.ok && looked.rows.some((row) => row.tier === 'precise')) symbols.push(entry);
    }
    if (symbols.length < Math.min(3, wanted)) throw new Error(`only ${String(symbols.length)} function(s) of the checkout have a precise reference, ${String(Math.min(3, wanted))} needed for the warm queries`);
    const warmMs: number[] = [];
    for (let sample = 0; sample < options.samplesWarm; sample += 1) {
      const entry = symbols[sample % symbols.length] as { symbol: string; file: string };
      const began = performance.now();
      const answer = await refs(entry.symbol, entry.file);
      const elapsed = performance.now() - began;
      if (!answer.ok || answer.rows.length === 0) throw new Error(`warm query ${String(sample)} for ${entry.symbol} returned ${answer.ok ? 'no references' : 'an error'}`);
      warmMs.push(round1(elapsed));
    }

    // Update: a different owned file per sample; the clock starts when the write returns.
    const updateMs: number[] = [];
    for (let sample = 0; sample < editFiles.length; sample += 1) {
      const file = editFiles[sample] as string;
      const probe = gateProbe(sample);
      const full = path.join(dir, file);
      fs.writeFileSync(full, `${fs.readFileSync(full, 'utf8')}${probe.text}`);
      const saved = performance.now();
      for (;;) {
        const answer = await refs(probe.callee, file);
        if (answer.rows.some((row) => row.enclosing === probe.caller && row.tier === 'precise')) break;
        if (performance.now() - saved > UPDATE_LIMIT_MS) throw new Error(`update sample ${String(sample)} (${file}): no precise reference to ${probe.callee} within ${String(UPDATE_LIMIT_MS)} ms`);
        await sleep(GATE_POLL_MS);
      }
      updateMs.push(round1(performance.now() - saved));
    }

    const infos = tiers.flatMap((each) => each.info());
    const [info] = infos;
    const peaks = infos.map((each) => each.peakRssMb);
    return {
      corpus: options.corpus,
      compiler: info === undefined ? null : { source: info.compiler.source, version: info.compiler.version },
      workerPeakRssMb: peaks.length === 0 ? null : round1(Math.max(...peaks)),
      warmSymbols: symbols.length,
      measurements: { buildMs, updateMs, warmMs },
      firstLookMs,
    };
  } finally {
    if (composed !== undefined) await composed.dispose();
    workspace?.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Test seams of `main`: the measured run, the corpus fetch and the no-break trace. */
export interface GateDeps {
  readonly run?: (options: GateRunOptions) => Promise<GateRun>;
  readonly fetchCheckout?: typeof fetchCheckout;
  readonly runNoBreak?: typeof runNoBreak;
}

/** A positive whole number from a flag, or undefined when the flag is absent; null when it is present and wrong. */
function positive(text: string | undefined): number | undefined | null {
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Exit codes: 0 the mode's condition holds, 1 it does not, 2 usage. */
export async function main(
  argv: readonly string[],
  io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } },
  deps: GateDeps = {},
): Promise<number> {
  let values: {
    trace?: boolean;
    nobreak?: boolean;
    update?: boolean;
    pr?: boolean;
    strict?: boolean;
    prepared?: boolean;
    'samples-update'?: string;
    'samples-warm'?: string;
    lazy?: boolean;
    corpus?: string;
    dir?: string;
    config?: string;
    'max-wait-ms'?: string;
    'budget-mb'?: string;
    seed?: string;
    symbols?: string;
  };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        trace: { type: 'boolean' },
        nobreak: { type: 'boolean' },
        update: { type: 'boolean' },
        pr: { type: 'boolean' },
        strict: { type: 'boolean' },
        prepared: { type: 'boolean' },
        'samples-update': { type: 'string' },
        'samples-warm': { type: 'string' },
        lazy: { type: 'boolean' },
        corpus: { type: 'string' },
        dir: { type: 'string' },
        config: { type: 'string' },
        'max-wait-ms': { type: 'string' },
        'budget-mb': { type: 'string' },
        seed: { type: 'string' },
        symbols: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const usage = (message: string): number => {
    io.stderr.write(`precise-gate: ${message}\n${USAGE}`);
    return 2;
  };
  const modes = [values.trace, values.nobreak, values.update, values.pr, values.strict].filter((mode) => mode === true).length;
  if (modes > 1) return usage('--trace, --nobreak, --update, --pr and --strict are separate modes');
  if (modes === 0) return usage('--trace, --nobreak, --update, --pr or --strict is required');
  const maxWaitMs = positive(values['max-wait-ms']) ?? 120_000;
  const budgetMb = positive(values['budget-mb']);
  const seed = positive(values.seed);
  const symbols = positive(values.symbols);
  const samplesUpdate = positive(values['samples-update']);
  const samplesWarm = positive(values['samples-warm']);
  if (maxWaitMs === null) return usage('--max-wait-ms must be a positive whole number');
  if (budgetMb === null) return usage('--budget-mb must be a positive whole number');
  if (seed === null) return usage('--seed must be a positive whole number');
  if (symbols === null) return usage('--symbols must be a positive whole number');
  if (samplesUpdate === null) return usage('--samples-update must be a positive whole number');
  if (samplesWarm === null) return usage('--samples-warm must be a positive whole number');
  const corpus = values.corpus;

  if (values.pr === true || values.strict === true) {
    const tier: GateTier = values.pr === true ? 'pr' : 'strict';
    if (corpus === undefined || (corpus !== 'fixture' && TRACES[corpus] === undefined)) return usage(`--corpus must be one of fixture, ${Object.keys(TRACES).join(', ')}`);
    if (values.dir !== undefined && corpus === 'fixture') return usage('--dir is for a pinned corpus; the fixture is generated');
    if (values.dir !== undefined && !fs.existsSync(path.join(values.dir, '.git'))) return usage('--dir must be a git checkout');
    const sampleCounts = { update: samplesUpdate ?? GATE_SAMPLES[tier].update, warm: samplesWarm ?? GATE_SAMPLES[tier].warm };
    try {
      const run = await (deps.run ?? runGate)({
        tier,
        corpus,
        prepared: values.prepared === true,
        samplesUpdate: sampleCounts.update,
        samplesWarm: sampleCounts.warm,
        ...(values.dir === undefined ? {} : { dir: fs.realpathSync.native(values.dir) }),
      });
      const evaluation = evaluate(run.measurements, tier);
      io.stdout.write(
        `${JSON.stringify({
          gate: 'precise',
          tier,
          corpus: run.corpus,
          compiler: run.compiler,
          buildMs: run.measurements.buildMs,
          updateMs: run.measurements.updateMs,
          warmMs: run.measurements.warmMs,
          samples: { update: run.measurements.updateMs.length, warm: run.measurements.warmMs.length },
          warmSymbols: run.warmSymbols,
          firstLookMs: run.firstLookMs ?? [],
          workerPeakRssMb: run.workerPeakRssMb,
          verdicts: evaluation.verdicts,
          ok: evaluation.ok,
        })}\n`,
      );
      for (const verdict of evaluation.verdicts.filter((entry) => !entry.ok)) {
        io.stderr.write(`precise-gate: ${verdict.key} breached: ${verdict.budget} ${verdict.statistic} ${String(verdict.valueMs)} ms is over ${String(verdict.ceilingMs)} ms\n`);
      }
      return evaluation.ok ? 0 : 1;
    } catch (error) {
      io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (values.nobreak === true) {
    if (corpus === undefined || corpus === '') return usage('--corpus is required');
    if (values.dir !== undefined && !fs.existsSync(path.join(values.dir, '.git'))) return usage('--dir must be a git checkout');
    let fetched: { readonly dir: string; readonly cleanup: () => void } | undefined;
    try {
      // Without --dir the pinned corpus is fetched (no install, so the bundled compiler, unless --prepared).
      fetched = values.dir === undefined ? await (deps.fetchCheckout ?? fetchCheckout)(corpus, values.prepared === true) : undefined;
      const report = await (deps.runNoBreak ?? runNoBreak)({
        corpus,
        dir: fs.realpathSync.native(fetched?.dir ?? (values.dir as string)),
        maxWaitMs,
        ...(budgetMb === undefined ? {} : { budgetMb }),
        ...(seed === undefined ? {} : { seed }),
        ...(symbols === undefined ? {} : { symbols }),
        ...(values.lazy === true ? { lazy: true } : {}),
      });
      io.stdout.write(`${JSON.stringify(report)}\n`);
      return report.ok ? 0 : 1;
    } catch (error) {
      io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    } finally {
      fetched?.cleanup();
    }
  }

  if (values.update === true) {
    if (corpus === undefined || TRACES[corpus] === undefined) return usage(`--corpus must be one of ${Object.keys(TRACES).join(', ')}`);
    if (values.dir === undefined) return usage('--dir <prepared checkout> is required');
    if (!fs.existsSync(path.join(values.dir, '.git'))) return usage('--dir must be a git checkout');
    try {
      const report = await runUpdate({ corpus, dir: fs.realpathSync.native(values.dir), maxWaitMs });
      io.stdout.write(`${JSON.stringify(report)}\n`);
      return report.ok ? 0 : 1;
    } catch (error) {
      io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (corpus === undefined || TRACES[corpus] === undefined) return usage(`--corpus must be one of ${Object.keys(TRACES).join(', ')}`);
  let dir: string;
  let prepared: string | undefined;
  if (values.dir === undefined) {
    prepared = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-precise-corpus-'));
    try {
      dir = prepareCorpus({ id: corpus, dest: prepared, npmCi: true }).dir;
    } catch (error) {
      fs.rmSync(prepared, { recursive: true, force: true });
      io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  } else {
    if (!fs.existsSync(path.join(values.dir, '.git'))) return usage('--dir must be a git checkout');
    dir = fs.realpathSync.native(values.dir);
  }
  try {
    const trace = await runTrace({ corpus, dir, config: values.config ?? 'tsconfig.json', maxWaitMs, ...(budgetMb === undefined ? {} : { budgetMb }) });
    io.stdout.write(`${JSON.stringify(trace)}\n`);
    const wrongOwner = values.config !== undefined && trace.ownerConfig !== values.config;
    if (wrongOwner) io.stderr.write(`precise-gate: the owner config is ${String(trace.ownerConfig)}, not ${values.config}\n`);
    return trace.ok && !wrongOwner ? 0 : 1;
  } catch (error) {
    io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (prepared !== undefined) fs.rmSync(prepared, { recursive: true, force: true });
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
