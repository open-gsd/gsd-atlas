/**
 * The real Source Tree: git and the file system, reached only through the injected CommandRunner
 * (FND-06). No process module is imported here; every git command is built by `gitSpec`, which switches
 * off every repo-controlled execution path (filter drivers, fsmonitor, hooks).
 *
 * A snapshot costs four git starts however large the tree is: enumerate filter drivers, list tracked
 * files, list untracked-not-ignored files, and ONE batched `hash-object --stdin-paths` over all of them. The
 * ignore check for single saved paths (`unignoredPaths`) costs one git start and hashes nothing.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitSpec, listFilterNames } from '../command-runner/index.ts';
import type { CommandRunner, CommandSpec, RunContext } from '../command-runner/index.ts';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES, SourceTreeError } from './types.ts';
import { assertReadArguments, assertRepoRelative, assertRevision, batchPathReason, isObjectId, unhashableReason } from './validate.ts';
import { pickRootCommit } from './identity.ts';
import { listConfinedDirectory } from './list-directory.ts';
import { DEFAULT_READ_TEXT_BYTES, readConfinedText } from './read-text.ts';
import { filterSourceSet, SOURCE_PEEK_BYTES } from './source-set.ts';
import type { PathAttributes, PeekResult } from './source-set.ts';
import type {
  HashPathsResult,
  ListTreeResult,
  ReadManyResult,
  ReadTextResult,
  SnapshotResult,
  SourceSetOptions,
  SourceSetResult,
  SourceTree,
  SourceTreeIdentity,
  TreeEntry,
  WorktreeInfo,
} from './types.ts';
import { parseWorktreeList } from './worktrees.ts';

export interface SourceTreeOptions {
  /** The only way this module starts anything. */
  readonly runner: CommandRunner;
  /** The tenant's repository directory; object reads and identity act here. */
  readonly repoDir: string;
  /** Extra environment for every git spec (a test's config isolation). */
  readonly envOverlay?: Readonly<Record<string, string>>;
}

/** Listing and hashing output is bounded by memory, not by the runner's 16 MiB default. */
const BIG_OUTPUT_BYTES = 512 * 1024 * 1024;
/** How many paths are lstat-ed at once. */
const LSTAT_BATCH = 256;
/** Timeout of every git spec built here. Value: `git.timeoutMs` in 02-CONSTANTS.md (Status: Approved 2026-10-16). */
const GIT_TIMEOUT_MS = 60000;
/** Timeout of the one batched `hash-object`. Value: `git.hashBatchTimeoutMs` in 02-CONSTANTS.md (Approved 2026-10-16). */
const GIT_HASH_BATCH_TIMEOUT_MS = 120000;
/**
 * Output cap of `cat-file --batch-check` per input line is the larger of a found record and the echoed spec plus
 * ` missing`/` ambiguous` and a line feed. Derived from the request (`source.batchCheckLineBytes`, 02-CONSTANTS.md,
 * Addendum 2026-10-17, Approved): a found record is at most 94 bytes; the absent form is the spec plus 12.
 */
const CHECK_FOUND_LINE_BYTES = 94;
const CHECK_ABSENT_SUFFIX_BYTES = 12;
/** Per-record allowance of the object batch beyond the body (`source.batchRecordAllowanceBytes`, 02-CONSTANTS.md, Approved 2026-10-17). */
const BATCH_RECORD_ALLOWANCE_BYTES = 128;
/** `O_NOFOLLOW` where the platform has it (Windows has none; lstat is the guard there). */
const O_NOFOLLOW: number = (fs.constants as Partial<Record<string, number>>)['O_NOFOLLOW'] ?? 0;

const decoder = new TextDecoder();

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createSourceTree(options: SourceTreeOptions): SourceTree {
  const { runner, repoDir } = options;
  const env = options.envOverlay;
  const ctx: RunContext = { repo: repoDir };

  const spec = (sub: readonly string[], worktree: string, extra: Partial<Parameters<typeof gitSpec>[1]> = {}): CommandSpec =>
    gitSpec(sub, { worktree, ...(env === undefined ? {} : { env }), ...extra });

  async function gitText(s: CommandSpec, label: string): Promise<string> {
    const result = await runner.run(s, ctx);
    if (!result.ok) {
      const why = result.denied?.message ?? result.spawnError?.message ?? decoder.decode(result.stderr).trim();
      throw new SourceTreeError('git_failed', `git ${label} failed: ${why || `exit ${String(result.exitCode)}`}`);
    }
    return decoder.decode(result.stdout);
  }

  async function snapshot(worktree: string): Promise<SnapshotResult> {
    const diagnostics: Diagnostic[] = [];
    const skip = (code: string, severity: Diagnostic['severity'], message: string, subject: string): void => {
      diagnostics.push(diagnostic(code, severity, message, subject));
    };

    // 1. Every configured filter driver, so the hash call can neutralise each of them.
    const filterNames = await listFilterNames(runner, worktree, ctx, env, GIT_TIMEOUT_MS);

    // 2. Tracked entries: "<mode> <hash> <stage>\t<path>" separated by NUL. The index hash is not used:
    //    the working-tree content is what gets hashed, so an edited file is reported as edited.
    const candidates = new Set<string>();
    const tracked = await gitText(
      spec(['ls-files', '-z', '-s'], worktree, { maxStdoutBytes: BIG_OUTPUT_BYTES, timeoutMs: GIT_TIMEOUT_MS }),
      'ls-files -s',
    );
    for (const entry of tracked.split('\0')) {
      if (entry === '') continue;
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      const mode = entry.slice(0, entry.indexOf(' '));
      const rel = entry.slice(tab + 1);
      if (mode === '160000') {
        skip(SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a submodule entry is not hashed as a file', rel);
        continue;
      }
      candidates.add(rel);
    }

    // 3. Untracked files git does not ignore. A nested repository shows up as "dir/".
    const untracked = await gitText(
      spec(['ls-files', '-z', '--others', '--exclude-standard'], worktree, { maxStdoutBytes: BIG_OUTPUT_BYTES, timeoutMs: GIT_TIMEOUT_MS }),
      'ls-files --others',
    );
    for (const rel of untracked.split('\0')) {
      if (rel === '') continue;
      if (rel.endsWith('/')) {
        skip(SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a nested repository is not hashed as a file', rel.slice(0, -1));
        continue;
      }
      candidates.add(rel);
    }

    // 4. Keep only what can be hashed safely: skip, with a diagnostic, instead of failing the batch.
    const hashable = await vetPaths(worktree, [...candidates].sort(compareCodeUnits), diagnostics);

    // 5. One batched hash over everything that is left.
    const files = await hashBatch(worktree, hashable, filterNames);
    return { files, diagnostics };
  }

  /**
   * The ignore oracle (plan 02-46): ONE `ls-files -z --cached --others --exclude-standard` with no pathspec and nothing
   * on stdin, filtered here by exact string equality against the requested names. Nothing a watcher or a repository
   * supplied reaches git, so no name can be read as an option, a pattern or a magic pathspec. The cost is the listing
   * of the tree once per call, without hashing a single file (the snapshot listed twice and hashed everything).
   */
  async function unignoredPaths(worktree: string, paths: readonly string[]): Promise<ReadonlySet<string>> {
    assertRepoRelative(paths);
    const asked = new Set(paths);
    if (asked.size === 0) return new Set();
    const listing = await gitText(
      spec(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], worktree, { maxStdoutBytes: BIG_OUTPUT_BYTES, timeoutMs: GIT_TIMEOUT_MS }),
      'ls-files --cached --others',
    );
    const found = new Set<string>();
    for (const entry of listing.split('\0')) {
      if (entry !== '' && asked.has(entry)) found.add(entry);
    }
    return found;
  }

  /**
   * Lstat-classifies sorted, unique candidate paths: the ones git can hash as regular files are returned, every
   * other one is reported into `diagnostics` with its code (snapshot and hashPaths share this, so they agree).
   */
  async function vetPaths(worktree: string, ordered: readonly string[], diagnostics: Diagnostic[]): Promise<string[]> {
    const skip = (code: string, severity: Diagnostic['severity'], message: string, subject: string): void => {
      diagnostics.push(diagnostic(code, severity, message, subject));
    };
    const hashable: string[] = [];
    for (let at = 0; at < ordered.length; at += LSTAT_BATCH) {
      const slice = ordered.slice(at, at + LSTAT_BATCH);
      const kinds = await Promise.all(
        slice.map(async (rel): Promise<'ok' | 'bad' | 'missing' | 'symlink' | 'dir' | 'special'> => {
          if (unhashableReason(rel) !== null) return 'bad';
          try {
            const st = await fs.promises.lstat(path.join(worktree, rel));
            if (st.isSymbolicLink()) return 'symlink';
            if (st.isDirectory()) return 'dir';
            return st.isFile() ? 'ok' : 'special';
          } catch {
            return 'missing';
          }
        }),
      );
      slice.forEach((rel, i) => {
        switch (kinds[i]) {
          case 'ok':
            hashable.push(rel);
            break;
          case 'bad':
            skip(SOURCE_TREE_CODES.unhashablePath, 'warning', unhashableReason(rel) ?? 'unhashable path', rel);
            break;
          case 'missing':
            skip(SOURCE_TREE_CODES.missingOnDisk, 'info', 'git lists this path but it is not on disk (deleted or sparse)', rel);
            break;
          case 'symlink':
            skip(SOURCE_TREE_CODES.symlinkSkipped, 'info', 'a symbolic link is never followed', rel);
            break;
          case 'dir':
            skip(SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a directory is not hashed as a file', rel);
            break;
          default:
            skip(SOURCE_TREE_CODES.unhashablePath, 'warning', 'not a regular file', rel);
        }
      });
    }
    return hashable;
  }

  /** ONE `hash-object --stdin-paths` over vetted paths, one per line; ids come back in input order. */
  async function hashBatch(worktree: string, hashable: readonly string[], filterNames: readonly string[]): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    if (hashable.length === 0) return files;
    const out = await gitText(
      spec(['hash-object', '--stdin-paths'], worktree, {
        filterNames,
        stdin: hashable.join('\n') + '\n',
        maxStdoutBytes: BIG_OUTPUT_BYTES,
        timeoutMs: GIT_HASH_BATCH_TIMEOUT_MS,
      }),
      'hash-object --stdin-paths',
    );
    const ids = out.split('\n');
    if (ids[ids.length - 1] === '') ids.pop();
    if (ids.length !== hashable.length || !ids.every(isObjectId)) {
      throw new SourceTreeError(
        SOURCE_TREE_CODES.hashOutputMismatch,
        `git hash-object returned ${ids.length} ids for ${hashable.length} paths`,
      );
    }
    hashable.forEach((rel, i) => files.set(rel, ids[i] as string));
    return files;
  }

  async function hashPaths(worktree: string, paths: readonly string[]): Promise<HashPathsResult> {
    const diagnostics: Diagnostic[] = [];
    const hashable = await vetPaths(worktree, [...new Set(paths)].sort(compareCodeUnits), diagnostics);
    if (hashable.length === 0) return { files: new Map(), diagnostics };
    // Filter drivers are enumerated on every call, never cached, so a driver added since the last call is neutralised.
    const filterNames = await listFilterNames(runner, worktree, ctx, env, GIT_TIMEOUT_MS);
    return { files: await hashBatch(worktree, hashable, filterNames), diagnostics };
  }

  /**
   * One `git check-attr -z --stdin` run for every path. With `-z` the input is NUL-separated and the output is
   * `<path> NUL <attribute> NUL <value> NUL` per path and attribute, so no name can be misread. A value of
   * `set` or `true` turns the attribute on; `unset`, `unspecified`, `false` and anything else leave it off.
   */
  async function checkAttr(worktree: string, paths: readonly string[]): Promise<Map<string, PathAttributes>> {
    const attributes = ['linguist-generated', 'linguist-vendored'] as const;
    const out = await gitText(
      spec(['check-attr', '-z', '--stdin', ...attributes], worktree, {
        stdin: paths.map((p) => `${p}\0`).join(''),
        maxStdoutBytes: BIG_OUTPUT_BYTES,
        timeoutMs: GIT_TIMEOUT_MS,
      }),
      'check-attr',
    );
    const fields = out.split('\0');
    if (fields[fields.length - 1] === '') fields.pop();
    if (fields.length !== paths.length * attributes.length * 3) {
      throw new SourceTreeError('git_failed', `git check-attr returned ${String(fields.length / 3)} records for ${String(paths.length * attributes.length)} expected`);
    }
    const found = new Map<string, { generated: boolean; vendored: boolean }>();
    for (let at = 0; at < fields.length; at += 3) {
      const rel = fields[at] as string;
      const name = fields[at + 1];
      const on = fields[at + 2] === 'set' || fields[at + 2] === 'true';
      const entry = found.get(rel) ?? { generated: false, vendored: false };
      if (name === 'linguist-generated') entry.generated = on;
      else if (name === 'linguist-vendored') entry.vendored = on;
      found.set(rel, entry);
    }
    return found;
  }

  /**
   * Size and first 8 KB of one file. lstat refuses a link or a non-regular file up front, and the open adds
   * O_NOFOLLOW where the platform has it, so a file swapped for a link after the lstat is still never followed.
   */
  async function peek(worktree: string, rel: string): Promise<PeekResult> {
    const full = path.join(worktree, rel);
    try {
      const st = await fs.promises.lstat(full);
      if (st.isSymbolicLink()) return { kind: 'symlink' };
      if (st.isDirectory()) return { kind: 'dir' };
      if (!st.isFile()) return { kind: 'special' };
    } catch {
      return { kind: 'missing' };
    }
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(full, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      return { kind: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'symlink' : 'missing' };
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) return { kind: 'special' };
      const buffer = Buffer.alloc(Math.min(SOURCE_PEEK_BYTES, st.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { kind: 'ok', size: st.size, head: buffer.subarray(0, bytesRead) };
    } catch {
      return { kind: 'missing' };
    } finally {
      await handle.close();
    }
  }

  /** One `check-attr` run for the paths `hashPaths` would hash (same vetting), none when nothing is left. */
  async function pathAttributes(worktree: string, paths: readonly string[]): Promise<ReadonlyMap<string, PathAttributes>> {
    const vetted = await vetPaths(worktree, [...new Set(paths)].sort(compareCodeUnits), []);
    if (vetted.length === 0) return new Map();
    return checkAttr(worktree, vetted);
  }

  function sourceSet(worktree: string, files: ReadonlyMap<string, string>, options: SourceSetOptions): Promise<SourceSetResult> {
    return filterSourceSet({
      files,
      options,
      checkAttr: (paths) => checkAttr(worktree, paths),
      peek: (rel) => peek(worktree, rel),
    });
  }

  /** Runs an object read where exit 1 (`-e`) or 128 (not found) are answers, not failures. */
  async function probe(s: CommandSpec, label: string): Promise<{ stdout: Uint8Array; found: boolean }> {
    const result = await runner.run(s, ctx);
    if (result.denied !== undefined || result.spawnError !== undefined || result.timedOut || result.truncated) {
      const why = result.denied?.message ?? result.spawnError?.message ?? (result.timedOut ? 'timed out' : 'output exceeded its cap');
      throw new SourceTreeError('git_failed', `git ${label} failed: ${why}`);
    }
    return { stdout: result.stdout, found: result.exitCode === 0 };
  }

  async function hasObject(hash: string): Promise<boolean> {
    if (!isObjectId(hash)) return false;
    const { found } = await probe(spec(['cat-file', '-e', hash], repoDir, { timeoutMs: GIT_TIMEOUT_MS }), 'cat-file -e');
    return found;
  }

  async function read(commit: string, relPath: string, readOptions?: { readonly maxBytes?: number }): Promise<Uint8Array | null> {
    assertReadArguments(commit, relPath);
    const cap = readOptions?.maxBytes ?? DEFAULT_READ_TEXT_BYTES;
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new SourceTreeError('invalid_argument', `maxBytes must be a non-negative integer, got ${String(cap)}`);
    }
    // The runner stops git one byte past the cap, so an oversize blob is never buffered whole.
    const result = await runner.run(
      spec(['cat-file', 'blob', `${commit}:${relPath}`], repoDir, { maxStdoutBytes: cap + 1, timeoutMs: GIT_TIMEOUT_MS }),
      ctx,
    );
    if (result.denied !== undefined || result.spawnError !== undefined || result.timedOut) {
      const why = result.denied?.message ?? result.spawnError?.message ?? 'timed out';
      throw new SourceTreeError('git_failed', `git cat-file blob failed: ${why}`);
    }
    if (result.stdout.length > cap) {
      throw new SourceTreeError(SOURCE_TREE_CODES.sourceTooLarge, `the blob is over the ${String(cap)}-byte read cap`);
    }
    if (result.truncated) throw new SourceTreeError('git_failed', 'git cat-file blob failed: output exceeded its cap');
    return result.exitCode === 0 ? result.stdout : null;
  }

  async function resolveCommit(rev: string): Promise<string | null> {
    assertRevision(rev);
    const { stdout, found } = await probe(
      spec(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], repoDir, { timeoutMs: GIT_TIMEOUT_MS }),
      'rev-parse --verify',
    );
    if (!found) return null;
    const id = decoder.decode(stdout).trim();
    return isObjectId(id) ? id : null;
  }

  async function listTree(commit: string): Promise<ListTreeResult> {
    assertReadArguments(commit, 'x');
    const result = await runner.run(
      spec(['ls-tree', '-r', '-z', '--full-tree', commit], repoDir, { maxStdoutBytes: BIG_OUTPUT_BYTES, timeoutMs: GIT_TIMEOUT_MS }),
      ctx,
    );
    if (result.denied !== undefined || result.spawnError !== undefined || result.timedOut || result.truncated) {
      const why = result.denied?.message ?? result.spawnError?.message ?? 'timed out or output exceeded its cap';
      throw new SourceTreeError('git_failed', `git ls-tree failed: ${why}`);
    }
    if (!result.ok) {
      // 128: the commit (or a tree it needs) is not in this object database; nothing was fetched.
      throw new SourceTreeError(SOURCE_TREE_CODES.commitNotFound, `commit ${commit.slice(0, 64)} is not available in this repository`);
    }
    const entries: TreeEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const record of decoder.decode(result.stdout).split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      const rel = record.slice(tab + 1);
      if (mode === undefined || type === undefined || oid === undefined) continue;
      if (mode === '120000') {
        diagnostics.push(diagnostic(SOURCE_TREE_CODES.symlinkSkipped, 'info', 'a symbolic link is never followed', rel));
      } else if (mode === '160000' || type === 'commit') {
        diagnostics.push(diagnostic(SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a submodule entry is not read as a file', rel));
      } else if (type === 'blob') {
        entries.push({ path: rel, mode, type, oid });
      }
    }
    entries.sort((a, b) => compareCodeUnits(a.path, b.path));
    diagnostics.sort((a, b) => compareCodeUnits(a.subject ?? '', b.subject ?? ''));
    return { entries, diagnostics };
  }

  async function readMany(
    commit: string,
    paths: readonly string[],
    readOptions?: { readonly maxBlobBytes?: number },
  ): Promise<ReadManyResult> {
    assertReadArguments(commit, 'x');
    const cap = readOptions?.maxBlobBytes ?? DEFAULT_READ_TEXT_BYTES;
    const blobs = new Map<string, Uint8Array | null>();
    const diagnostics: Diagnostic[] = [];
    const asked: string[] = [];
    for (const rel of new Set(paths)) {
      const reason = batchPathReason(rel);
      if (reason !== null) {
        blobs.set(rel, null);
        diagnostics.push(diagnostic(SOURCE_TREE_CODES.unhashablePath, 'warning', reason, rel));
      } else {
        asked.push(rel);
      }
    }
    if (asked.length === 0) return { blobs, diagnostics };

    // Step 1, sizes only: one short line per input. The first line proves the commit exists (an unknown commit
    // would otherwise look like "every path missing") and names the commit id the second step reads from.
    const lines = [`${commit}^{commit}`, ...asked.map((rel) => `${commit}:${rel}`)];
    const checkCap = lines.reduce((sum, line) => sum + Math.max(CHECK_FOUND_LINE_BYTES, Buffer.byteLength(line) + CHECK_ABSENT_SUFFIX_BYTES), 0);
    const checked = await runObjectBatch(
      spec(['cat-file', '--batch-check'], repoDir, { stdin: `${lines.join('\n')}\n`, maxStdoutBytes: checkCap, timeoutMs: GIT_TIMEOUT_MS }),
      'cat-file --batch-check',
      commit,
    );
    const sizes = parseBatchCheck(checked, lines.length);
    const commitSize = sizes[0];
    if (commitSize?.kind !== 'found') {
      throw new SourceTreeError(SOURCE_TREE_CODES.commitNotFound, `commit ${commit.slice(0, 64)} is not available in this repository`);
    }

    // Step 2, bytes: only the blobs at or under the cap, with an output cap that follows their sizes.
    const selected: string[] = [];
    let selectedBytes = 0;
    asked.forEach((rel, i) => {
      const size = sizes[i + 1];
      if (size?.kind === 'found' && size.type === 'blob' && size.size <= cap) {
        selected.push(rel);
        selectedBytes += size.size;
      }
    });
    let bytesOf = new Map<string, Uint8Array>();
    if (selected.length > 0) {
      // The peeled commit id (not the caller's spelling of it), so a ref that moves between the two runs cannot
      // make the second answer differ from the sizes the cap was computed from.
      const pinned = commitSize.oid;
      const batchLines = [pinned, ...selected.map((rel) => `${pinned}:${rel}`)];
      const batchCap = commitSize.size + selectedBytes + BATCH_RECORD_ALLOWANCE_BYTES * batchLines.length;
      const out = await runObjectBatch(
        spec(['cat-file', '--batch'], repoDir, { stdin: `${batchLines.join('\n')}\n`, maxStdoutBytes: batchCap, timeoutMs: GIT_HASH_BATCH_TIMEOUT_MS }),
        'cat-file --batch',
        commit,
      );
      const records = parseObjectBatch(out, batchLines.length);
      if (records[0]?.kind !== 'found') {
        throw new SourceTreeError(SOURCE_TREE_CODES.commitNotFound, `commit ${commit.slice(0, 64)} is not available in this repository`);
      }
      bytesOf = new Map();
      selected.forEach((rel, i) => {
        const record = records[i + 1];
        if (record?.kind !== 'found' || record.type !== 'blob') {
          throw new SourceTreeError('git_failed', 'git cat-file --batch output is malformed: a blob changed between the size check and the read');
        }
        bytesOf.set(rel, record.bytes());
      });
    }
    asked.forEach((rel, i) => {
      const size = sizes[i + 1];
      const bytes = bytesOf.get(rel);
      if (bytes !== undefined) {
        blobs.set(rel, bytes);
      } else {
        blobs.set(rel, null);
        if (size?.kind === 'found' && size.type === 'blob') {
          diagnostics.push(diagnostic(SOURCE_TREE_CODES.sourceTooLarge, 'info', `the blob is ${String(size.size)} bytes, over the ${String(cap)}-byte cap`, rel));
        }
      }
    });
    return { blobs, diagnostics };
  }

  /** Runs one `cat-file` batch where exit 128 means "an object is not here" and anything else not ok is a failure. */
  async function runObjectBatch(s: CommandSpec, label: string, commit: string): Promise<Uint8Array> {
    const result = await runner.run(s, ctx);
    if (!result.ok && result.exitCode === 128 && result.denied === undefined && result.spawnError === undefined) {
      // git died on an object it could not read (a shallow or partial clone): nothing is fetched, so say so.
      throw new SourceTreeError(SOURCE_TREE_CODES.commitNotFound, `an object of commit ${commit.slice(0, 64)} is not available in this repository`);
    }
    if (!result.ok) {
      const why = result.denied?.message ?? result.spawnError?.message ?? (result.timedOut ? 'timed out' : result.truncated ? 'output exceeded its cap' : `exit ${String(result.exitCode)}`);
      throw new SourceTreeError('git_failed', `git ${label} failed: ${why}`);
    }
    return result.stdout;
  }

  async function identity(): Promise<SourceTreeIdentity> {
    // An unborn branch has no HEAD: rev-list fails with 128 and the repository has no root commit yet.
    const roots = await probe(spec(['rev-list', '--max-parents=0', 'HEAD'], repoDir, { timeoutMs: GIT_TIMEOUT_MS }), 'rev-list --max-parents=0');
    // Several roots print in no stable order; the smallest id is the identity (WR-06, see identity.ts).
    const rootCommit = roots.found ? pickRootCommit(decoder.decode(roots.stdout)) : null;
    const common = (
      await gitText(spec(['rev-parse', '--git-common-dir'], repoDir, { timeoutMs: GIT_TIMEOUT_MS }), 'rev-parse --git-common-dir')
    ).trim();
    const realCommon = fs.realpathSync.native(path.resolve(repoDir, common));
    const storeId = createHash('sha256').update(`${rootCommit ?? ''}\n${realCommon}`).digest('hex').slice(0, 16);
    return { rootCommit, storeId, commonDir: realCommon };
  }

  async function worktrees(): Promise<readonly WorktreeInfo[]> {
    let output: string;
    try {
      output = await gitText(
        spec(['worktree', 'list', '--porcelain', '-z'], repoDir, { maxStdoutBytes: BIG_OUTPUT_BYTES, timeoutMs: GIT_TIMEOUT_MS }),
        'worktree list --porcelain -z',
      );
    } catch (error) {
      if (error instanceof SourceTreeError && error.code === 'git_failed') {
        throw new SourceTreeError('git_failed', `${error.message} (listing worktrees needs git 2.36 or newer for the -z form)`);
      }
      throw error;
    }
    return parseWorktreeList(output).map((w) => {
      try {
        return { ...w, path: fs.realpathSync.native(w.path) };
      } catch {
        // The directory is gone (deleted checkout): keep the path git reports, and say so. Git prints a Windows path
        // with forward slashes (`C:/Users/x`); `normalize` gives it the separators `realpath` gives every other entry
        // (found by plan 02-26 on Windows CI: a caller that looks the entry up by its native path found nothing).
        return { ...w, path: path.normalize(w.path), prunable: true };
      }
    });
  }

  function readText(worktree: string, relPath: string, readOptions?: { readonly maxBytes?: number }): Promise<ReadTextResult> {
    return readConfinedText(worktree, relPath, readOptions?.maxBytes ?? DEFAULT_READ_TEXT_BYTES);
  }

  return {
    snapshot,
    hashPaths,
    unignoredPaths,
    pathAttributes,
    sourceSet,
    worktrees,
    readText,
    listDirectory: listConfinedDirectory,
    hasObject,
    read,
    identity,
    resolveCommit,
    listTree,
    readMany,
  };
}

/** One answer of `cat-file --batch-check`: the object's id, type and size, or `missing`/`ambiguous`. */
type CheckRecord =
  | { readonly kind: 'found'; readonly oid: string; readonly type: string; readonly size: number }
  | { readonly kind: 'absent' };

/**
 * Parses the output of `git cat-file --batch-check` for exactly `expected` requests, one line each, in request
 * order. A found line is `<oid> <type> <size>`; an absent one is `<spec> missing` or `<spec> ambiguous`, where
 * the echoed spec is repository-chosen text, so only the suffix is looked at and the answer is matched to its
 * request by position, never by the echoed name. Anything else throws `git_failed`.
 */
function parseBatchCheck(out: Uint8Array, expected: number): CheckRecord[] {
  const lines = Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const bad = (why: string): SourceTreeError => new SourceTreeError('git_failed', `git cat-file --batch-check output is malformed: ${why}`);
  if (lines.length !== expected) throw bad(`${String(lines.length)} answers for ${String(expected)} requests`);
  return lines.map((line): CheckRecord => {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/.exec(line);
    if (match !== null) {
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size)) throw bad('a size is not a safe integer');
      return { kind: 'found', oid: match[1] as string, type: match[2] as string, size };
    }
    if (line.endsWith(' missing') || line.endsWith(' ambiguous')) return { kind: 'absent' };
    throw bad('a line is not "<oid> <type> <size>"');
  });
}

/** One answer of `cat-file --batch`: an object (its bytes are copied out only on request) or `missing`/`ambiguous`. */
type BatchRecord =
  | { readonly kind: 'found'; readonly type: string; readonly size: number; bytes(): Uint8Array }
  | { readonly kind: 'absent' };

/**
 * Parses the output of `git cat-file --batch` for exactly `expected` requests, in request order. Each answer is
 * a header line `<oid> <type> <size>` followed by exactly `size` bytes and a newline, or `<spec> missing` or
 * `<spec> ambiguous`. The size, never a scan for newlines, says where a body ends, so a body holding
 * header-looking lines or NUL cannot desynchronise the stream. Anything else throws `git_failed`.
 */
function parseObjectBatch(out: Uint8Array, expected: number): BatchRecord[] {
  const buffer = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  const records: BatchRecord[] = [];
  let at = 0;
  const bad = (why: string): SourceTreeError => new SourceTreeError('git_failed', `git cat-file --batch output is malformed: ${why}`);
  while (records.length < expected) {
    const eol = buffer.indexOf(0x0a, at);
    if (eol === -1) throw bad(`${String(records.length)} of ${String(expected)} answers`);
    const header = buffer.toString('utf8', at, eol);
    at = eol + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      records.push({ kind: 'absent' });
      continue;
    }
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/.exec(header);
    if (match === null) throw bad('a header line is not "<oid> <type> <size>"');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || at + size + 1 > buffer.length || buffer[at + size] !== 0x0a) throw bad('a body does not match its declared size');
    const start = at;
    records.push({ kind: 'found', type: match[2] as string, size, bytes: () => Uint8Array.from(buffer.subarray(start, start + size)) });
    at += size + 1;
  }
  if (at !== buffer.length) throw bad('unexpected output after the last answer');
  return records;
}
