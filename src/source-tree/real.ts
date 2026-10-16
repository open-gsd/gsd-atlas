/**
 * The real Source Tree: git and the file system, reached only through the injected CommandRunner
 * (FND-06). No process module is imported here; every git command is built by `gitSpec`, which switches
 * off every repo-controlled execution path (filter drivers, fsmonitor, hooks).
 *
 * A snapshot costs four git starts however large the tree is: enumerate filter drivers, list tracked
 * files, list untracked-not-ignored files, and ONE batched `hash-object --stdin-paths` over all of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gitSpec, listFilterNames } from '../command-runner/index.ts';
import type { CommandRunner, CommandSpec, RunContext } from '../command-runner/index.ts';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES, SourceTreeError } from './types.ts';
import type { SnapshotResult, SourceTree, SourceTreeIdentity } from './types.ts';

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
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const decoder = new TextDecoder();

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Reasons a path cannot ride in the line-oriented `--stdin-paths` batch. Returns the reason, or null if it can. */
function unhashableReason(rel: string): string | null {
  if (rel === '') return 'empty path';
  if (rel.includes('\n') || rel.includes('\r')) return 'the name contains a line break, which would split the hash batch';
  // git reads a leading double quote as a C-style quoted path in --stdin-paths.
  if (rel.startsWith('"')) return 'the name starts with a double quote, which git would unquote';
  if (rel.includes('\0')) return 'the name contains NUL';
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return 'the path is absolute';
  if (rel.split('/').includes('..')) return 'the path leaves the worktree';
  return null;
}

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
    const tracked = await gitText(spec(['ls-files', '-z', '-s'], worktree, { maxStdoutBytes: BIG_OUTPUT_BYTES }), 'ls-files -s');
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
      spec(['ls-files', '-z', '--others', '--exclude-standard'], worktree, { maxStdoutBytes: BIG_OUTPUT_BYTES }),
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
    const ordered = [...candidates].sort(compareCodeUnits);
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

    // 5. One batched hash over everything that is left, one path per line, ids returned in input order.
    const files = new Map<string, string>();
    if (hashable.length > 0) {
      const out = await gitText(
        spec(['hash-object', '--stdin-paths'], worktree, {
          filterNames,
          stdin: hashable.join('\n') + '\n',
          maxStdoutBytes: BIG_OUTPUT_BYTES,
        }),
        'hash-object --stdin-paths',
      );
      const ids = out.split('\n');
      if (ids[ids.length - 1] === '') ids.pop();
      if (ids.length !== hashable.length || !ids.every((id) => OBJECT_ID.test(id))) {
        throw new SourceTreeError(
          SOURCE_TREE_CODES.hashOutputMismatch,
          `git hash-object returned ${ids.length} ids for ${hashable.length} paths`,
        );
      }
      hashable.forEach((rel, i) => files.set(rel, ids[i] as string));
    }
    return { files, diagnostics };
  }

  const notYet = (): never => {
    throw new SourceTreeError('not_implemented', 'not implemented yet');
  };

  return {
    snapshot,
    hasObject: (): Promise<boolean> => Promise.resolve(notYet()),
    read: (): Promise<Uint8Array | null> => Promise.resolve(notYet()),
    identity: (): Promise<SourceTreeIdentity> => Promise.resolve(notYet()),
  };
}
