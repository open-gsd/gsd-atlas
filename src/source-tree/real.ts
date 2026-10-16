/**
 * The real Source Tree: git and the file system, reached only through the injected CommandRunner
 * (FND-06). No process module is imported here; every git command is built by `gitSpec`, which switches
 * off every repo-controlled execution path (filter drivers, fsmonitor, hooks).
 *
 * A snapshot costs four git starts however large the tree is: enumerate filter drivers, list tracked
 * files, list untracked-not-ignored files, and ONE batched `hash-object --stdin-paths` over all of them.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitSpec, listFilterNames } from '../command-runner/index.ts';
import type { CommandRunner, CommandSpec, RunContext } from '../command-runner/index.ts';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES, SourceTreeError } from './types.ts';
import { assertReadArguments, isObjectId, unhashableReason } from './validate.ts';
import { filterSourceSet, SOURCE_PEEK_BYTES } from './source-set.ts';
import type { PathAttributes, PeekResult } from './source-set.ts';
import type { HashPathsResult, SnapshotResult, SourceSetOptions, SourceSetResult, SourceTree, SourceTreeIdentity } from './types.ts';

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
    const filterNames = await listFilterNames(runner, worktree, ctx, env);

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
    const filterNames = await listFilterNames(runner, worktree, ctx, env);
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
      const why = result.denied?.message ?? result.spawnError?.message ?? 'timed out or output exceeded its cap';
      throw new SourceTreeError('git_failed', `git ${label} failed: ${why}`);
    }
    return { stdout: result.stdout, found: result.exitCode === 0 };
  }

  async function hasObject(hash: string): Promise<boolean> {
    if (!isObjectId(hash)) return false;
    const { found } = await probe(spec(['cat-file', '-e', hash], repoDir), 'cat-file -e');
    return found;
  }

  async function read(commit: string, relPath: string): Promise<Uint8Array | null> {
    assertReadArguments(commit, relPath);
    const { stdout, found } = await probe(
      spec(['cat-file', 'blob', `${commit}:${relPath}`], repoDir, { maxStdoutBytes: BIG_OUTPUT_BYTES }),
      'cat-file blob',
    );
    return found ? stdout : null;
  }

  async function identity(): Promise<SourceTreeIdentity> {
    // An unborn branch has no HEAD: rev-list fails with 128 and the repository has no root commit yet.
    const roots = await probe(spec(['rev-list', '--max-parents=0', 'HEAD'], repoDir), 'rev-list --max-parents=0');
    const rootCommit = roots.found ? (decoder.decode(roots.stdout).split('\n')[0] ?? '') || null : null;
    const common = (await gitText(spec(['rev-parse', '--git-common-dir'], repoDir), 'rev-parse --git-common-dir')).trim();
    const realCommon = fs.realpathSync.native(path.resolve(repoDir, common));
    const storeId = createHash('sha256').update(`${rootCommit ?? ''}\n${realCommon}`).digest('hex').slice(0, 16);
    return { rootCommit, storeId };
  }

  return { snapshot, hashPaths, sourceSet, hasObject, read, identity };
}
