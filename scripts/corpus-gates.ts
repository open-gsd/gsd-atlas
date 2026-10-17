/**
 * node scripts/corpus-gates.ts [--corpus gsd-core] [--keep]
 *
 * The pinned-corpus build gate (ROADMAP success criterion 1, LNG-02, LNG-05, STO-05). It checks the corpus out at
 * its manifest SHA into a temporary directory (never a user's checkout), runs `build` through the composed Host
 * (the same composition the bins use), builds a second time, and then checks the result against facts it works out
 * for itself from git and the file system:
 *
 *   - every indexed path is in git's file list (tracked plus untracked-not-ignored);
 *   - the indexed set equals an independently audited source set, so no generated, vendored, binary, LFS-pointer,
 *     ignored or unclaimed file is indexed and no source file is missing;
 *   - the accounting identity: indexed plus skipped plus unclaimed plus too-large equals the files git lists;
 *   - the second build parses zero files and links every one;
 *   - the share of files with grammar parse errors, per module, is at most the DESIGN budget of 0.5 percent;
 *   - the database is at most the approved `gate.storeMaxBytes`.
 *
 * Every figure is a count, a size or a ratio, so the gate is stable on a hosted runner; the wall-clock times of the
 * two builds are printed for the nightly record and asserted nowhere. Exit code 1 when any check fails.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { composeHost } from '../src/bin/compose.ts';
import { STORE_FILE_NAME } from '../src/fact-store/schema.ts';
import { PROTOCOL_VERSION, isInside } from '../src/facts/index.ts';
import { DEFAULT_INDEXER_CONFIG } from '../src/indexer/defaults.ts';
import { readModuleInputs } from '../src/lang/index.ts';
import { openDatabase } from '../src/sqlite/index.ts';
import { SOURCE_TREE_CODES } from '../src/source-tree/index.ts';
import { SOURCE_PEEK_BYTES, extensionOf } from '../src/source-tree/source-set.ts';
import { unhashableReason } from '../src/source-tree/validate.ts';
import { fetchCorpus } from './corpus-fetch.ts';
import type { FetchCorpusOptions, FetchedCorpus } from './corpus-fetch.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** The approved `gate.storeMaxBytes` of 02-CONSTANTS.md (Status: Approved): the DESIGN budget of 50 MB at gsd-core. */
export const STORE_MAX_BYTES = 52_428_800;

/** DESIGN budget: files with grammar parse errors per module, at most 0.5 percent. */
export const PARSE_ERROR_RATIO_MAX = 0.005;

/** The approved `sqlite.busyTimeoutMs` of 02-CONSTANTS.md, used for the read-only look at the finished store. */
const STORE_READ_BUSY_MS = 5000;

const LFS_SPEC_LINE = 'version https://git-lfs.github.com/spec/v1';

/** What one `build` reported (the counts of the Host's build envelope) and how long it took. */
export interface BuildFigures {
  readonly files: number;
  readonly parsed: number;
  readonly linked: number;
  readonly removed: number;
  /** Snapshot diagnostics plus one per dropped source file plus one aggregate count of unclaimed files. */
  readonly skipped: number;
  readonly failed: number;
  readonly failedCodes: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
}

export interface ModuleRow {
  readonly module: string;
  /** Distinct live file contents the module extracted. */
  readonly files: number;
  /** Of those, the ones whose parse had error nodes. */
  readonly errorFiles: number;
}

/** What the store holds after the builds, read through the SQLite kit on a read-only connection. */
export interface StoreSummary {
  readonly modules: readonly ModuleRow[];
  /** Every path of every overlay. */
  readonly indexedPaths: readonly string[];
}

/** The files git lists for a checkout, worked out with git alone. */
export interface GitList {
  /** Tracked (not submodule) plus untracked-not-ignored paths. */
  readonly files: ReadonlySet<string>;
  /** Submodule entries and nested repositories: listed by git, never hashed as files. */
  readonly gitlinks: number;
  readonly total: number;
}

/** The source-set rules (LNG-05) applied a second time, independently of the product. */
export interface SourceAudit {
  /** Everything git lists. */
  readonly total: number;
  /** Hashable files whose extension no loaded module claims. */
  readonly unclaimed: number;
  /** Listed paths that cannot be hashed as regular files: links, directories, odd names, missing. */
  readonly snapshotSkipped: readonly string[];
  /** Claimed files over the byte cap: recorded in the overlay but not parsed. */
  readonly oversize: readonly string[];
  /** Claimed files that should be indexed. */
  readonly kept: readonly string[];
  /** Claimed files the rules drop, by diagnostic code. */
  readonly dropped: Readonly<Record<string, readonly string[]>>;
}

export interface GateInputs {
  readonly first: BuildFigures;
  readonly second: BuildFigures;
  readonly gitFiles: ReadonlySet<string>;
  readonly audit: SourceAudit;
  readonly store: StoreSummary;
  readonly databaseBytes: number;
  readonly maxStoreBytes: number;
  readonly maxParseErrorRatio: number;
}

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const sample = (paths: readonly string[]): string => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? `, and ${String(paths.length - 5)} more` : ''}`;

/** Evaluate every gate over the measured facts. Pure: no I/O. */
export function evaluateGates(inputs: GateInputs): Check[] {
  const { first, second, audit, store } = inputs;
  const checks: Check[] = [];

  const indexed = store.indexedPaths;
  const foreign = indexed.filter((entry) => !inputs.gitFiles.has(entry));
  checks.push({
    name: 'indexed paths are in the git file list',
    ok: foreign.length === 0,
    detail: foreign.length === 0 ? `${String(indexed.length)} indexed paths, all listed by git` : `${String(foreign.length)} indexed paths git does not list: ${sample(foreign)}`,
  });

  const expected = new Set([...audit.kept, ...audit.oversize]);
  const actual = new Set(indexed);
  const extra = [...actual].filter((entry) => !expected.has(entry)).sort();
  const missing = [...expected].filter((entry) => !actual.has(entry)).sort();
  checks.push({
    name: 'indexed set equals the audited source set',
    ok: extra.length === 0 && missing.length === 0,
    detail:
      extra.length === 0 && missing.length === 0
        ? `${String(actual.size)} paths indexed, the audit expects the same ${String(expected.size)}`
        : `indexed but not expected: ${extra.length === 0 ? 'none' : sample(extra)}; expected but not indexed: ${missing.length === 0 ? 'none' : sample(missing)}`,
  });

  // The aggregate "no module claims" diagnostic is one entry however many files it counts.
  const aggregate = audit.unclaimed > 0 ? 1 : 0;
  const accounted = first.files + (first.skipped - aggregate) + audit.oversize.length + audit.unclaimed;
  checks.push({
    name: 'accounting identity',
    ok: accounted === audit.total,
    detail: `indexed ${String(first.files)} + skipped ${String(first.skipped - aggregate)} + too large ${String(audit.oversize.length)} + unclaimed ${String(audit.unclaimed)} = ${String(accounted)}; git lists ${String(audit.total)}`,
  });

  checks.push({
    name: 'second build parses zero files',
    ok: second.parsed === 0 && second.linked === second.files && second.files === first.files,
    detail: `parsed ${String(second.parsed)}, linked ${String(second.linked)} of ${String(second.files)} files (first build: ${String(first.files)})`,
  });

  for (const row of [...store.modules].sort((a, b) => a.module.localeCompare(b.module))) {
    const ratio = row.files === 0 ? 0 : row.errorFiles / row.files;
    checks.push({
      name: `parse-error ratio ${row.module}`,
      ok: ratio <= inputs.maxParseErrorRatio,
      detail: `${String(row.errorFiles)} of ${String(row.files)} files have parse errors (${(ratio * 100).toFixed(2)}%, limit ${(inputs.maxParseErrorRatio * 100).toFixed(2)}%)`,
    });
  }

  checks.push({
    name: 'database size',
    ok: inputs.databaseBytes <= inputs.maxStoreBytes,
    detail: `${String(inputs.databaseBytes)} bytes, limit ${String(inputs.maxStoreBytes)}`,
  });
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Facts worked out from git and the file system

function gitBuffer(dir: string, args: readonly string[], input?: string): Buffer {
  const result = spawnSync('git', [...args], {
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 512 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout;
}

/** Tracked plus untracked-not-ignored paths of the checkout at `dir`, from `git ls-files` alone. */
export function listGitFiles(dir: string): GitList {
  const files = new Set<string>();
  let gitlinks = 0;
  for (const entry of gitBuffer(dir, ['ls-files', '-z', '-s']).toString('utf8').split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    if (entry.slice(0, entry.indexOf(' ')) === '160000') gitlinks += 1;
    else files.add(entry.slice(tab + 1));
  }
  for (const entry of gitBuffer(dir, ['ls-files', '-z', '--others', '--exclude-standard']).toString('utf8').split('\0')) {
    if (entry === '') continue;
    if (entry.endsWith('/')) gitlinks += 1;
    else files.add(entry);
  }
  return { files, gitlinks, total: files.size + gitlinks };
}

/** `linguist-generated` and `linguist-vendored`, from one `git check-attr` run. */
function linguistAttributes(dir: string, paths: readonly string[]): Map<string, { generated: boolean; vendored: boolean }> {
  const found = new Map<string, { generated: boolean; vendored: boolean }>();
  if (paths.length === 0) return found;
  const out = gitBuffer(dir, ['check-attr', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'], paths.map((entry) => `${entry}\0`).join(''))
    .toString('utf8')
    .split('\0');
  if (out[out.length - 1] === '') out.pop();
  for (let at = 0; at + 2 < out.length; at += 3) {
    const rel = out[at] as string;
    const entry = found.get(rel) ?? { generated: false, vendored: false };
    const on = out[at + 2] === 'set' || out[at + 2] === 'true';
    if (out[at + 1] === 'linguist-generated') entry.generated = on;
    else entry.vendored = on;
    found.set(rel, entry);
  }
  return found;
}

/** Size and first bytes of a regular file, or null when it cannot be opened as one. */
function peek(full: string): { size: number; head: Buffer } | null {
  let fd: number;
  try {
    fd = fs.openSync(full, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const head = Buffer.alloc(Math.min(SOURCE_PEEK_BYTES, stat.size));
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return { size: stat.size, head: head.subarray(0, read) };
  } finally {
    fs.closeSync(fd);
  }
}

function isLfsPointer(head: Buffer): boolean {
  const line = Buffer.from(LFS_SPEC_LINE);
  if (head.length < line.length || !head.subarray(0, line.length).equals(line)) return false;
  const next = head[line.length];
  return next === undefined || next === 0x0a || next === 0x0d;
}

/**
 * Apply the LNG-05 rules to what git lists, written out again here rather than called from the product so that a
 * mistake in the product's rules shows up as a difference: a name git can hash, a regular file, a claimed
 * extension, not marked generated or vendored, not over the byte cap, no NUL byte in the first 8 KB, not an LFS pointer.
 */
export function auditSourceSet(dir: string, listed: GitList, claimed: ReadonlySet<string>, maxBytes: number): SourceAudit {
  const snapshotSkipped: string[] = [];
  const hashable: string[] = [];
  for (const rel of [...listed.files].sort()) {
    if (unhashableReason(rel) !== null) {
      snapshotSkipped.push(rel);
      continue;
    }
    let regular = false;
    try {
      regular = fs.lstatSync(path.join(dir, rel)).isFile();
    } catch {
      regular = false;
    }
    if (regular) hashable.push(rel);
    else snapshotSkipped.push(rel);
  }
  snapshotSkipped.push(...Array.from({ length: listed.gitlinks }, (_, index) => `(submodule or nested repository ${String(index + 1)})`));

  const candidates = hashable.filter((rel) => claimed.has(extensionOf(rel)));
  const unclaimed = hashable.length - candidates.length;
  const attributes = linguistAttributes(dir, candidates);
  const dropped: Record<string, string[]> = {};
  const drop = (code: string, rel: string): void => {
    (dropped[code] ??= []).push(rel);
  };
  const kept: string[] = [];
  const oversize: string[] = [];
  for (const rel of candidates) {
    const attr = attributes.get(rel);
    if (attr?.generated === true) drop(SOURCE_TREE_CODES.generatedSkipped, rel);
    else if (attr?.vendored === true) drop(SOURCE_TREE_CODES.vendoredSkipped, rel);
    else {
      const seen = peek(path.join(dir, rel));
      if (seen === null) drop(SOURCE_TREE_CODES.missingOnDisk, rel);
      else if (seen.size > maxBytes) oversize.push(rel);
      else if (seen.head.includes(0)) drop(SOURCE_TREE_CODES.binarySkipped, rel);
      else if (isLfsPointer(seen.head)) drop(SOURCE_TREE_CODES.lfsPointerSkipped, rel);
      else kept.push(rel);
    }
  }
  return { total: listed.total, unclaimed, snapshotSkipped, oversize, kept, dropped };
}

/** The extensions the built-in modules claim, lower case with the dot. */
function claimedExtensions(moduleRoot: string): Set<string> {
  const claimed = new Set<string>();
  for (const name of fs.readdirSync(moduleRoot)) {
    const dir = path.join(moduleRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const inputs = readModuleInputs(dir);
    if (!inputs.ok) continue;
    for (const extension of inputs.manifest.extensions) claimed.add(extension.toLowerCase());
  }
  return claimed;
}

/** Read the finished store: per-module parse-error counts and every indexed path. */
export async function readStoreSummary(file: string): Promise<StoreSummary> {
  const db = await openDatabase(file, { readOnly: true, timeoutMs: STORE_READ_BUSY_MS });
  try {
    const modules = db
      .prepare("SELECT module, COUNT(*) AS files, SUM(CASE WHEN error_bytes > 0 THEN 1 ELSE 0 END) AS errorFiles FROM files WHERE state = 'live' GROUP BY module ORDER BY module")
      .all()
      .map((row) => ({ module: String(row['module']), files: Number(row['files']), errorFiles: Number(row['errorFiles'] ?? 0) }));
    const indexedPaths = db
      .prepare('SELECT path FROM overlay_files ORDER BY path')
      .all()
      .map((row) => String(row['path']));
    return { modules, indexedPaths };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The run

/** What a build step hands back. */
export interface BuildOutcome {
  readonly first: BuildFigures;
  readonly second: BuildFigures;
  /** The store database file the builds wrote. */
  readonly storeFile: string;
}

export interface BuildStepInput {
  readonly dir: string;
  readonly workDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly storeRoot: string;
}

export interface CorpusGatesOptions {
  /** Corpus id from corpora/corpora.json. Default `gsd-core`. */
  readonly corpus?: string;
  /** Keep the work directory (the checkout and the store) for inspection. */
  readonly keep?: boolean;
  /** Replaces the corpus fetch. Tests inject a local repository here so they need no network. */
  readonly fetch?: (options: FetchCorpusOptions) => Promise<FetchedCorpus>;
  /** Replaces the two builds through the composed Host. */
  readonly buildCommand?: (input: BuildStepInput) => Promise<BuildOutcome>;
  /** Replaces the read of the finished store. */
  readonly readStore?: (file: string) => Promise<StoreSummary>;
  /** Directory the work directory is created in. Default the system temp directory. */
  readonly tmpRoot?: string;
  /** Where the lines go. Default stdout. */
  readonly out?: (line: string) => void;
  readonly maxStoreBytes?: number;
  readonly maxParseErrorRatio?: number;
}

export interface CorpusGatesReport {
  readonly ok: boolean;
  readonly checks: readonly Check[];
  readonly first: BuildFigures;
  readonly second: BuildFigures;
  readonly audit: SourceAudit;
  readonly store: StoreSummary;
  readonly databaseBytes: number;
  readonly sha: string;
  /** The (removed unless `keep`) directory the run worked in. */
  readonly workDir: string;
}

/** Windows keeps files locked briefly after a child exits, hence the retries. */
function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

interface BuildEnvelopeData {
  readonly files: number;
  readonly parsed: number;
  readonly linked: number;
  readonly removed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failedCodes: Record<string, number>;
}

/** Build `dir` twice through the composed Host (the real runner, pooled engine, Governor and watcher). */
async function buildThroughHost(input: BuildStepInput): Promise<BuildOutcome> {
  const composed = composeHost({ cwd: input.dir, env: input.env, stderr: process.stderr, home: input.home });
  try {
    const run = async (): Promise<BuildFigures> => {
      const began = performance.now();
      const envelope = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: input.dir } });
      const elapsedMs = performance.now() - began;
      if (!envelope.ok || envelope.data === null) {
        throw new Error(`build failed: ${envelope.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
      }
      const data = envelope.data as BuildEnvelopeData;
      return { files: data.files, parsed: data.parsed, linked: data.linked, removed: data.removed, skipped: data.skipped, failed: data.failed, failedCodes: data.failedCodes, elapsedMs };
    };
    const first = await run();
    const second = await run();
    return { first, second, storeFile: storeFileUnder(input.storeRoot) };
  } finally {
    await composed.dispose();
  }
}

/** The one store directory the override created, and its database file. */
function storeFileUnder(storeRoot: string): string {
  const stores = fs.readdirSync(storeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (stores.length !== 1) throw new Error(`expected one store under ${storeRoot}, found ${String(stores.length)}`);
  return path.join(storeRoot, (stores[0] as fs.Dirent).name, STORE_FILE_NAME);
}

function databaseBytes(file: string): number {
  let bytes = 0;
  for (const suffix of ['', '-wal']) {
    try {
      bytes += fs.statSync(file + suffix).size;
    } catch {
      // absent: a closed store has no log
    }
  }
  return bytes;
}

const percent = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;

function describeBuild(label: string, figures: BuildFigures): string {
  const codes = Object.entries(figures.failedCodes).map(([code, count]) => `${code}=${String(count)}`).join(',');
  return `${label}: files ${String(figures.files)} parsed ${String(figures.parsed)} linked ${String(figures.linked)} removed ${String(figures.removed)} skipped ${String(figures.skipped)} failed ${String(figures.failed)}${codes === '' ? '' : ` (${codes})`} elapsed ${String(Math.round(figures.elapsedMs))} ms`;
}

/**
 * Fetch the pinned corpus, build it twice through the Host and evaluate every gate. The work directory is removed
 * in `finally`, whatever happens (unless `keep`).
 */
export async function runCorpusGates(options: CorpusGatesOptions = {}): Promise<CorpusGatesReport> {
  const corpus = options.corpus ?? 'gsd-core';
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const tmpRoot = path.resolve(options.tmpRoot ?? os.tmpdir());
  const realRepo = fs.realpathSync.native(repoRoot);
  const inside = (): boolean => isInside(realRepo, tmpRoot) || isInside(repoRoot, tmpRoot);
  // Refused before anything is created, then again after the real path is known.
  if (inside()) {
    throw new Error(`${tmpRoot} is inside the repository (${repoRoot}); a corpus checkout must never land in a checkout`);
  }
  fs.mkdirSync(tmpRoot, { recursive: true });
  if (isInside(realRepo, fs.realpathSync.native(tmpRoot))) {
    throw new Error(`${tmpRoot} is inside the repository (${repoRoot}); a corpus checkout must never land in a checkout`);
  }
  const workDir = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpRoot), 'gsd-atlas-corpus-gates-'));
  try {
    const fetched = await (options.fetch ?? fetchCorpus)({ id: corpus, destination: path.join(workDir, 'checkout') });
    out(`corpus-gates: corpus ${corpus} at ${fetched.sha.slice(0, 12)}`);

    const storeRoot = path.join(workDir, 'stores');
    const userDir = path.join(workDir, 'user');
    const home = path.join(workDir, 'home');
    for (const dir of [storeRoot, userDir, home]) fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, GSD_ATLAS_USER_DIR: userDir, GSD_ATLAS_STORE_DIR: storeRoot };

    const built = await (options.buildCommand ?? buildThroughHost)({ dir: fetched.dir, workDir, env, home, storeRoot });
    out(describeBuild('first build', built.first));
    out(describeBuild('second build', built.second));

    const listed = listGitFiles(fetched.dir);
    const moduleRoot = path.join(repoRoot, 'modules');
    const audit = auditSourceSet(fetched.dir, listed, claimedExtensions(moduleRoot), DEFAULT_INDEXER_CONFIG.maxFileBytes);
    const store = await (options.readStore ?? readStoreSummary)(built.storeFile);
    const bytes = databaseBytes(built.storeFile);

    const dropped = Object.entries(audit.dropped).map(([code, paths]) => `${code}=${String(paths.length)}`);
    out(
      `corpus-gates: git lists ${String(audit.total)} files: indexed ${String(audit.kept.length)}, too large ${String(audit.oversize.length)}, ` +
        `unclaimed ${String(audit.unclaimed)}, not hashable ${String(audit.snapshotSkipped.length)}${dropped.length === 0 ? '' : `, ${dropped.join(', ')}`}`,
    );
    for (const row of store.modules) {
      out(`corpus-gates: module ${row.module}: ${String(row.files)} files, ${String(row.errorFiles)} with parse errors (${percent(row.files === 0 ? 0 : row.errorFiles / row.files)})`);
    }
    out(`corpus-gates: database bytes ${String(bytes)} (limit ${String(options.maxStoreBytes ?? STORE_MAX_BYTES)})`);

    const checks = evaluateGates({
      first: built.first,
      second: built.second,
      gitFiles: listed.files,
      audit,
      store,
      databaseBytes: bytes,
      maxStoreBytes: options.maxStoreBytes ?? STORE_MAX_BYTES,
      maxParseErrorRatio: options.maxParseErrorRatio ?? PARSE_ERROR_RATIO_MAX,
    });
    for (const check of checks) out(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    return {
      ok: checks.every((check) => check.ok),
      checks,
      first: built.first,
      second: built.second,
      audit,
      store,
      databaseBytes: bytes,
      sha: fetched.sha,
      workDir,
    };
  } finally {
    if (options.keep !== true) removeTree(workDir);
  }
}

/** The command-line body, with the output sink injected. Returns the exit code. */
export async function runCli(argv: string[], write: (text: string) => void, overrides: Partial<CorpusGatesOptions> = {}): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { corpus: { type: 'string' }, keep: { type: 'boolean' } }, strict: true });
  const report = await runCorpusGates({
    ...(values.corpus === undefined ? {} : { corpus: values.corpus }),
    ...(values.keep === true ? { keep: true } : {}),
    out: (line) => {
      write(`${line}\n`);
    },
    ...overrides,
  });
  write(`corpus-gates: ${report.ok ? 'OK' : 'FAILED'}\n`);
  return report.ok ? 0 : 1;
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
      process.stderr.write(`corpus-gates: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
