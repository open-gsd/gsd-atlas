import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { validateCorpora } from '../corpus.ts';

/**
 * node scripts/eval/prepare-corpus.ts --corpus gsd-core --dest <dir> [--no-npm-ci]
 *
 * Prepares the checkout every eval and oracle run uses (EVL-02, OQ8): the pinned corpus commit is
 * fetched by running the existing `scripts/corpus-fetch.ts` as a child process, then
 * `npm ci --ignore-scripts` runs inside it so the project's own TypeScript 6.x is installed and
 * used (D-13). The compiler version, the lock file hash and whether `npm ci` ran are written to
 * `.eval-prepared.json` in the checkout; the pre-registration copies them. With `--no-npm-ci`
 * (OQ8 overturned) nothing is installed and the record says the bundled compiler will be used.
 *
 * Dev-time tooling only: the fetch and the install use the network. No package script is ever run
 * (T-03-72): `--ignore-scripts` is always on the argument array, and the environment forces it
 * too. Every child process gets an argument array, never a shell string. The checkout lives in a
 * throwaway directory outside this repository.
 *
 * Live use on Windows: npm is run as `node npm-cli.js`, found next to `node.exe` or through
 * `npm_execpath`; the `npm.cmd` shim is never spawned (Node refuses `.cmd` without a shell), so a
 * Windows machine whose npm is not laid out that way passes its own command through `npm`.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'corpora', 'corpora.json');

/** The file in the checkout that records how it was prepared. */
export const RECORD_FILE = '.eval-prepared.json';

const CHILD_TIMEOUT_MS = 30 * 60 * 1000;
const CHILD_MAX_BUFFER = 1 << 26;

export type PrepareErrorCode =
  | 'manifest_invalid'
  | 'unknown_corpus'
  | 'corpus_not_pinned'
  | 'destination_inside_repo'
  | 'fetch_failed'
  | 'sha_mismatch'
  | 'install_failed'
  | 'npm_unavailable'
  | 'record_missing'
  | 'record_invalid'
  | 'clone_destination_not_empty'
  | 'clone_destination_inside_source';

export class PrepareError extends Error {
  readonly code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PrepareError';
    this.code = code;
  }
}

export const PreparedRecordSchema = z.strictObject({
  corpusId: z.string().min(1),
  sha: z.string().min(1),
  npmCi: z.boolean(),
  /** Version of `node_modules/typescript` after the install; null when nothing was installed. */
  typescriptVersion: z.string().min(1).nullable(),
  /** sha256 of `package-lock.json` with CRLF read as LF; null when nothing was installed. */
  lockSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  dir: z.string().min(1),
});
export type PreparedRecord = z.infer<typeof PreparedRecordSchema>;

/** An executable and the arguments that come before the ones this module appends. */
export interface Command {
  command: string;
  args: string[];
}

export interface PrepareOptions {
  /** Corpus id in `corpora/corpora.json`. */
  id: string;
  /** Directory that will hold the new checkout directory. Must be outside this repository. */
  dest: string;
  /** Run `npm ci --ignore-scripts` in the checkout (OQ8 default). */
  npmCi: boolean;
  /** Replaces `node scripts/corpus-fetch.ts`; `<id> --dest <dir>` is appended. For tests. */
  fetchCommand?: Command;
  /** Replaces the resolved npm; `ci --ignore-scripts ...` is appended. For tests. */
  npm?: Command;
  /** Replaces `corpora/corpora.json`. For tests. */
  manifest?: unknown;
}

// ---------------------------------------------------------------------------------------------
// Paths and git

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** realpath of `target`, resolving the nearest existing ancestor and appending the rest as written. */
function resolveThroughExisting(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') && name !== 'GIT_SSL_NO_VERIFY') delete env[name];
  }
  return env;
}

function git(dir: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv(), windowsHide: true });
  return {
    ok: result.error === undefined && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.error === undefined ? (result.stderr ?? '') : result.error.message,
  };
}

// ---------------------------------------------------------------------------------------------
// The manifest

interface PinnedEntry {
  id: string;
  sha: string;
}

function loadManifest(injected: unknown): unknown {
  if (injected !== undefined) return injected;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as unknown;
}

/** The pinned entry for `id`; throws for an invalid manifest, an unknown id or an unpinned entry. */
function pinnedEntry(manifest: unknown, id: string): PinnedEntry {
  const errors = validateCorpora(manifest);
  if (errors.length > 0) throw new PrepareError('manifest_invalid', errors.join('; '));
  const corpora = (manifest as { corpora: Array<Record<string, unknown>> }).corpora;
  const entry = corpora.find((candidate) => candidate['id'] === id);
  if (entry === undefined) {
    const known = corpora.map((candidate) => String(candidate['id'])).join(', ');
    throw new PrepareError('unknown_corpus', `no corpus "${id}" in the manifest (known: ${known})`);
  }
  if (entry['status'] !== 'pinned') {
    throw new PrepareError('corpus_not_pinned', `corpus "${id}" has status ${String(entry['status'])}; only a pinned corpus can be prepared`);
  }
  return { id, sha: String(entry['sha']) };
}

// ---------------------------------------------------------------------------------------------
// npm

/**
 * npm as `node npm-cli.js`: from `npm_execpath` when the script runs under npm, else the copy that
 * ships next to the running node. Falls back to a bare `npm` on a POSIX system.
 */
export function resolveNpm(): Command {
  const fromEnv = process.env['npm_execpath'];
  if (fromEnv !== undefined && /npm-cli\.[cm]?js$/.test(fromEnv) && fs.existsSync(fromEnv)) {
    return { command: process.execPath, args: [fromEnv] };
  }
  const binDir = path.dirname(process.execPath);
  const candidates = [
    path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  if (process.platform === 'win32') {
    throw new PrepareError('npm_unavailable', 'npm-cli.js was not found next to node.exe and npm_execpath is not set; the npm.cmd shim is not supported');
  }
  return { command: 'npm', args: [] };
}

function readTypescriptVersion(dir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null;
  } catch {
    return null;
  }
}

function hashLockFile(dir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(text).digest('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Preparation

function defaultFetchCommand(): Command {
  return { command: process.execPath, args: [path.join(REPO_ROOT, 'scripts', 'corpus-fetch.ts')] };
}

function writeRecord(dir: string, record: PreparedRecord): void {
  fs.writeFileSync(path.join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  // Keep `git status` of the checkout clean: the record is ours, not the corpus's.
  const exclude = git(dir, ['rev-parse', '--git-path', 'info/exclude']);
  if (!exclude.ok) return;
  try {
    const file = path.resolve(dir, exclude.stdout.trim());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${RECORD_FILE}\n`);
  } catch {
    // best effort: a dirty status line is not an error
  }
}

/**
 * Fetches corpus `id` at its manifest SHA into a new directory under `dest`, optionally installs
 * its dependencies with scripts disabled, and writes the preparation record. A failure removes the
 * checkout this call created.
 */
export function prepareCorpus(options: PrepareOptions): PreparedRecord {
  const entry = pinnedEntry(loadManifest(options.manifest), options.id);

  const dest = resolveThroughExisting(options.dest);
  if (isInside(fs.realpathSync.native(REPO_ROOT), dest)) {
    throw new PrepareError('destination_inside_repo', `${options.dest} is inside the repository working tree; a corpus checkout must never land in a checkout`);
  }

  const fetch = options.fetchCommand ?? defaultFetchCommand();
  const fetched = spawnSync(fetch.command, [...fetch.args, options.id, '--dest', dest], {
    encoding: 'utf8',
    maxBuffer: CHILD_MAX_BUFFER,
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (fetched.error !== undefined || fetched.status !== 0) {
    const why = fetched.error === undefined ? (fetched.stderr ?? '').trim() : fetched.error.message;
    throw new PrepareError('fetch_failed', `corpus-fetch for ${options.id} failed (${String(fetched.status)}): ${why}`);
  }
  const printed = (fetched.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop();
  if (printed === undefined || !fs.existsSync(printed)) {
    throw new PrepareError('fetch_failed', `corpus-fetch printed no checkout directory (last line: ${String(printed)})`);
  }
  const dir = fs.realpathSync.native(printed);
  // Only a directory this call's fetch created directly under `dest` may be cleaned up on failure.
  const owned = path.dirname(dir) === fs.realpathSync.native(dest);

  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (!head.ok || head.stdout.trim() !== entry.sha) {
      throw new PrepareError('sha_mismatch', `${options.id} is at ${head.stdout.trim() || '(unknown)'} instead of the manifest SHA ${entry.sha}`);
    }

    let typescriptVersion: string | null = null;
    let lockSha256: string | null = null;
    if (options.npmCi) {
      const npm = options.npm ?? resolveNpm();
      // `--ignore-scripts` is on the argument array and in the environment: no package script runs (T-03-72).
      const args = [...npm.args, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
      const installed = spawnSync(npm.command, args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, npm_config_ignore_scripts: 'true' },
        maxBuffer: CHILD_MAX_BUFFER,
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true,
      });
      if (installed.error !== undefined || installed.status !== 0) {
        const why = installed.error === undefined ? (installed.stderr ?? '').trim().slice(-2000) : installed.error.message;
        throw new PrepareError('install_failed', `npm ci --ignore-scripts failed in ${dir} (${String(installed.status)}): ${why}`);
      }
      typescriptVersion = readTypescriptVersion(dir);
      lockSha256 = hashLockFile(dir);
    }

    const record: PreparedRecord = { corpusId: options.id, sha: entry.sha, npmCi: options.npmCi, typescriptVersion, lockSha256, dir };
    writeRecord(dir, record);
    return record;
  } catch (error) {
    if (owned) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

/**
 * Reads the preparation record of a checkout and checks it against the manifest: the corpus must be
 * pinned and the recorded SHA must be the manifest SHA. `dir` in the result is where the checkout is now.
 */
export function readPreparedRecord(dir: string, manifest?: unknown): PreparedRecord {
  const file = path.join(dir, RECORD_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PrepareError('record_missing', `${file} does not exist; the checkout was not prepared by prepare-corpus`);
  }
  let parsed: PreparedRecord;
  try {
    parsed = PreparedRecordSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new PrepareError('record_invalid', `${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = pinnedEntry(loadManifest(manifest), parsed.corpusId);
  if (parsed.sha !== entry.sha) {
    throw new PrepareError('sha_mismatch', `${file} records ${parsed.sha} but the manifest pins ${parsed.corpusId} at ${entry.sha}`);
  }
  let where = path.resolve(dir);
  try {
    where = fs.realpathSync.native(dir);
  } catch {
    // keep the resolved spelling
  }
  return { ...parsed, dir: where };
}

// ---------------------------------------------------------------------------------------------
// Per-session copies

/**
 * Keeps a symbolic link only when it is relative and its fully resolved target lies inside the
 * tree being copied. An absolute link would point back into the prepared source from a session's
 * copy, and a link that leaves the tree (or cannot be resolved) would be read through; both are
 * skipped, so a session can neither read nor change anything outside its own copy.
 */
function keepEntry(sourceRoot: string, entry: string): boolean {
  if (!fs.lstatSync(entry).isSymbolicLink()) return true;
  if (path.isAbsolute(fs.readlinkSync(entry))) return false;
  try {
    return isInside(sourceRoot, fs.realpathSync.native(entry));
  } catch {
    return false;
  }
}

/**
 * Copies the prepared checkout `from` to the new directory `to` for one eval session. Uses
 * copy-on-write where the file system supports it (`COPYFILE_FICLONE` falls back to a plain copy),
 * recreates relative links that stay inside the tree as links, skips every other link, and never
 * writes to `from`. `to` must not exist or must be an empty directory.
 */
export function cloneCheckout(from: string, to: string): void {
  const source = fs.realpathSync.native(from);
  const target = path.resolve(to);
  if (isInside(source, resolveThroughExisting(target))) {
    throw new PrepareError('clone_destination_inside_source', `${to} is inside ${from}`);
  }
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length > 0) {
      throw new PrepareError('clone_destination_not_empty', `${to} exists and is not an empty directory`);
    }
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (entry) => keepEntry(source, entry),
  });
}

// ---------------------------------------------------------------------------------------------
// Command line

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export interface CliDeps {
  fetchCommand?: Command;
  npm?: Command;
  manifest?: unknown;
}

const USAGE = 'usage: node scripts/eval/prepare-corpus.ts --corpus <id> --dest <dir> [--no-npm-ci]\n';

/** Exit codes: 0 prepared, 1 fetch or install failed, 2 usage. The directory is the last line of stdout. */
export function runCli(argv: readonly string[], io: CliIo, deps: CliDeps = {}): number {
  let values: { corpus?: string; dest?: string; 'no-npm-ci'?: boolean };
  try {
    values = parseArgs({
      args: [...argv],
      options: { corpus: { type: 'string' }, dest: { type: 'string' }, 'no-npm-ci': { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.stderr.write(`prepare-corpus: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.corpus === undefined || values.dest === undefined) {
    io.stderr.write(`prepare-corpus: --corpus and --dest are required\n${USAGE}`);
    return 2;
  }
  try {
    const record = prepareCorpus({
      id: values.corpus,
      dest: values.dest,
      npmCi: values['no-npm-ci'] !== true,
      ...(deps.fetchCommand === undefined ? {} : { fetchCommand: deps.fetchCommand }),
      ...(deps.npm === undefined ? {} : { npm: deps.npm }),
      ...(deps.manifest === undefined ? {} : { manifest: deps.manifest }),
    });
    io.stderr.write(`${JSON.stringify(record)}\n`);
    io.stdout.write(`${record.dir}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`prepare-corpus: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
