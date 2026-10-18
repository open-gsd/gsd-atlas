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
 * `--trace` is the only mode. The thresholds of the gates and the CI wiring belong to plan 03-30; the two limits below are
 * the tracer's own stop rule (a first precise answer slower than 30 seconds, or a worker above 1 GB, is reported and
 * stops the plan rather than being loosened).
 *
 * The checkout is the one `scripts/eval/prepare-corpus.ts` prepares (OQ8: `npm ci --ignore-scripts`, so the project's own
 * TypeScript 6.x is used). Without `--dir` this script prepares one in a temporary directory, which uses the network. The
 * checkout is only read; the store, the user directory and the cache go to a temporary directory that is removed at the end.
 * Dev-time tooling: nothing in the shipped package imports it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { composeHost } from '../src/bin/compose.ts';
import { createRealRunner } from '../src/command-runner/index.ts';
import { PROTOCOL_VERSION } from '../src/facts/index.ts';
import type { Envelope } from '../src/facts/index.ts';
import type { PreciseTier } from '../src/precise-resolver/index.ts';
import { createProjectModel } from '../src/project-model/index.ts';
import type { ProjectFs } from '../src/project-model/index.ts';
import { createSourceTree } from '../src/source-tree/index.ts';
import { prepareCorpus } from './eval/prepare-corpus.ts';

/** The tracer's stop rule. */
export const LIMITS = Object.freeze({ firstPreciseMs: 30_000, rssMb: 1024 });

/** What each corpus traces: the function and the file that defines it. */
const TRACES: Readonly<Record<string, { readonly symbol: string; readonly file: string }>> = Object.freeze({
  'gsd-core': { symbol: 'compareSemverCore', file: 'src/semver-compare.cts' },
});

const USAGE = 'usage: node scripts/precise-gate.ts --trace --corpus gsd-core [--dir <prepared checkout>] [--config tsconfig.json] [--max-wait-ms 120000]\n';

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

/** The config that owns `file`, found with the compiler-free ProjectModel over the checkout (the same reader the Host uses). */
async function ownerOf(dir: string, file: string): Promise<string | null> {
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: dir });
  const fsView: ProjectFs = {
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
  const model = createProjectModel('typescript', fsView);
  if (model === undefined) return null;
  const description = await model.describe({ overlayPaths: [file], fs: fsView });
  return description.ownerOf(file) ?? null;
}

export interface TraceOptions {
  readonly corpus: string;
  readonly dir: string;
  readonly config: string;
  readonly maxWaitMs: number;
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
      limits: LIMITS,
      withinLimits,
      ok: firstPreciseMs !== null && withinLimits,
    };
  } finally {
    await composed.dispose();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Exit codes: 0 a precise record exists within the limits, 1 none or a limit exceeded, 2 usage. */
export async function main(argv: readonly string[], io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } }): Promise<number> {
  let values: { trace?: boolean; corpus?: string; dir?: string; config?: string; 'max-wait-ms'?: string };
  try {
    values = parseArgs({
      args: [...argv],
      options: { trace: { type: 'boolean' }, corpus: { type: 'string' }, dir: { type: 'string' }, config: { type: 'string' }, 'max-wait-ms': { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.stderr.write(`precise-gate: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.trace !== true) {
    io.stderr.write(`precise-gate: --trace is the only mode and is required\n${USAGE}`);
    return 2;
  }
  const corpus = values.corpus;
  if (corpus === undefined || TRACES[corpus] === undefined) {
    io.stderr.write(`precise-gate: --corpus must be one of ${Object.keys(TRACES).join(', ')}\n${USAGE}`);
    return 2;
  }
  const maxWaitMs = values['max-wait-ms'] === undefined ? 120_000 : Number(values['max-wait-ms']);
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1) {
    io.stderr.write(`precise-gate: --max-wait-ms must be a positive whole number\n${USAGE}`);
    return 2;
  }
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
    if (!fs.existsSync(path.join(values.dir, '.git'))) {
      io.stderr.write(`precise-gate: --dir must be a git checkout\n${USAGE}`);
      return 2;
    }
    dir = fs.realpathSync.native(values.dir);
  }
  try {
    const trace = await runTrace({ corpus, dir, config: values.config ?? 'tsconfig.json', maxWaitMs });
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
