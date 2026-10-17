/**
 * The Source Tree fake: derived from the same data description the contract suite realises as a real
 * repository, so it cannot drift from git's behaviour without the shared contract failing. Production-safe:
 * it imports no test runner and no test-kit, and is exported from the index.
 *
 * Blob ids are real git ids (sha1 over `blob <length>\0` plus the bytes), so a snapshot from the fake
 * equals a snapshot of the realised repository. `ignored` entries are exact repo-relative paths, or
 * directory prefixes ending in `/`; like git's own ignore rules they apply to untracked files only.
 */
import { createHash } from 'node:crypto';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES, SourceTreeError } from './types.ts';
import { DEFAULT_READ_TEXT_BYTES } from './read-text.ts';
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
  SourceTreeWorld,
  TreeEntry,
  WorktreeInfo,
} from './types.ts';
import { assertReadArguments, assertRevision, batchPathReason, escapesWorktree, isObjectId, unhashableReason } from './validate.ts';

/** The one worktree the fake has when the world describes none, and the root of its fake git directory. */
const FAKE_WORKTREE = '/fake';

const encoder = new TextEncoder();

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function blobId(content: string): string {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** A stable stand-in for the one commit: sha1 over the sorted committed entries. */
function commitId(committed: Readonly<Record<string, string>>): string {
  const h = createHash('sha1').update('fake commit\n');
  for (const rel of Object.keys(committed).sort(compareCodeUnits)) h.update(`${rel}\0${blobId(committed[rel] ?? '')}\n`);
  return h.digest('hex');
}

export function createFakeSourceTree(world: Partial<SourceTreeWorld> = {}): SourceTree {
  const committed = world.committed ?? {};
  const working = world.working ?? {};
  const ignored = world.ignored ?? [];
  const attributes = world.attributes ?? {};
  const isIgnored = (rel: string): boolean => ignored.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));

  const committedPaths = Object.keys(committed);
  // The history, oldest first. A world with one commit keeps the id it always had; later commits chain onto their parent.
  const history = world.commits ?? [committed];
  const modes = world.modes ?? {};
  const hasCommits = Object.keys(history[0] ?? {}).length > 0 || history.length > 1;
  const commitIds: string[] = [];
  history.forEach((files, i) => {
    const own = commitId(files);
    const parent = commitIds[i - 1];
    commitIds.push(parent === undefined ? own : createHash('sha1').update(`${parent}\n${own}`).digest('hex'));
  });
  const rootCommit = hasCommits ? (commitIds[0] ?? null) : null;
  const allBlobs = new Set(history.flatMap((files) => Object.values(files).map((content) => blobId(content))));
  const committedBlobs = new Set([...committedPaths.map((rel) => blobId(committed[rel] ?? '')), ...allBlobs]);
  /** The index in `history` that `rev` names (`HEAD`, `HEAD~N` or a full commit id), or null. */
  const commitIndex = (rev: string): number | null => {
    if (!hasCommits) return null;
    const last = history.length - 1;
    if (rev === 'HEAD') return last;
    const back = /^HEAD~([0-9]+)$/.exec(rev);
    if (back !== null) {
      const at = last - Number(back[1]);
      return at >= 0 ? at : null;
    }
    const at = commitIds.indexOf(rev);
    return at === -1 ? null : at;
  };
  const isLast = (index: number): boolean => index === history.length - 1;
  const notFound = (commit: string): SourceTreeError =>
    new SourceTreeError(SOURCE_TREE_CODES.commitNotFound, `commit ${commit.slice(0, 64)} is not available in this repository`);
  const storeId = createHash('sha256').update(`${rootCommit ?? ''}\nfake`).digest('hex').slice(0, 16);

  /** The working-tree content of `rel`: a string, or null when the file is not on disk. */
  const onDisk = (rel: string): string | null => {
    const edit = Object.hasOwn(working, rel) ? working[rel] : undefined;
    const content = edit === undefined ? committed[rel] : edit;
    return content ?? null;
  };
  /** True when some file on disk lives below `rel/`, i.e. `rel` is a directory (the real tree sees it with lstat). */
  const isDirectory = (rel: string): boolean => {
    const prefix = `${rel}/`;
    return [...new Set([...committedPaths, ...Object.keys(working)])].some((p) => p.startsWith(prefix) && onDisk(p) !== null);
  };

  return {
    worktrees(): Promise<readonly WorktreeInfo[]> {
      return Promise.resolve(
        world.worktrees ?? [{ path: FAKE_WORKTREE, head: rootCommit, branch: 'main', detached: false, bare: false, locked: false, prunable: false }],
      );
    },

    readText(_worktree: string, relPath: string, options?: { readonly maxBytes?: number }): Promise<ReadTextResult> {
      if (escapesWorktree(relPath)) return Promise.resolve({ kind: 'escape' });
      const content = onDisk(relPath);
      if (content === null) return Promise.resolve({ kind: isDirectory(relPath) ? 'not_file' : 'missing' });
      if (Buffer.byteLength(content) > (options?.maxBytes ?? DEFAULT_READ_TEXT_BYTES)) return Promise.resolve({ kind: 'too_large' });
      return Promise.resolve({ kind: 'ok', text: content });
    },

    hashPaths(_worktree: string, paths: readonly string[]): Promise<HashPathsResult> {
      const diagnostics: Diagnostic[] = [];
      const files = new Map<string, string>();
      // Vets exactly as the real tree does, in the same order: name rules, then what is on disk. Like the real
      // tree it hashes what it is asked to, so an ignored file that exists is hashed too.
      for (const rel of [...new Set(paths)].sort(compareCodeUnits)) {
        const reason = unhashableReason(rel);
        if (reason !== null) {
          diagnostics.push(diagnostic(SOURCE_TREE_CODES.unhashablePath, 'warning', reason, rel));
          continue;
        }
        const content = onDisk(rel);
        if (content === null) {
          if (isDirectory(rel)) {
            diagnostics.push(diagnostic(SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a directory is not hashed as a file', rel));
          } else {
            diagnostics.push(diagnostic(SOURCE_TREE_CODES.missingOnDisk, 'info', 'git lists this path but it is not on disk (deleted or sparse)', rel));
          }
          continue;
        }
        files.set(rel, blobId(content));
      }
      return Promise.resolve({ files, diagnostics });
    },

    sourceSet(_worktree: string, files: ReadonlyMap<string, string>, options: SourceSetOptions): Promise<SourceSetResult> {
      return filterSourceSet({
        files,
        options,
        checkAttr: (paths) =>
          Promise.resolve(
            new Map(paths.map((rel): [string, PathAttributes] => [
              rel,
              { generated: attributes[rel]?.generated === true, vendored: attributes[rel]?.vendored === true },
            ])),
          ),
        peek: (rel): Promise<PeekResult> => {
          const content = onDisk(rel);
          if (content === null) return Promise.resolve({ kind: isDirectory(rel) ? 'dir' : 'missing' });
          const bytes = Buffer.from(content);
          return Promise.resolve({ kind: 'ok', size: bytes.length, head: bytes.subarray(0, SOURCE_PEEK_BYTES) });
        },
      });
    },

    snapshot(): Promise<SnapshotResult> {
      const diagnostics: Diagnostic[] = [];
      const paths = new Set([...committedPaths, ...Object.keys(working)]);
      const files = new Map<string, string>();
      for (const rel of [...paths].sort(compareCodeUnits)) {
        const tracked = Object.hasOwn(committed, rel);
        const edit = Object.hasOwn(working, rel) ? working[rel] : undefined;
        const content = edit === undefined ? committed[rel] : edit;
        if (content === null || content === undefined) {
          if (tracked) {
            diagnostics.push(diagnostic(SOURCE_TREE_CODES.missingOnDisk, 'info', 'git lists this path but it is not on disk (deleted or sparse)', rel));
          }
          continue;
        }
        if (!tracked && isIgnored(rel)) continue;
        files.set(rel, blobId(content));
      }
      return Promise.resolve({ files, diagnostics });
    },

    hasObject(hash: string): Promise<boolean> {
      return Promise.resolve(isObjectId(hash) && (committedBlobs.has(hash) || commitIds.includes(hash)));
    },

    // async so that invalid arguments reject, exactly as the real tree's read does.
    async read(commit: string, relPath: string): Promise<Uint8Array | null> {
      assertReadArguments(commit, relPath);
      const index = commitIndex(commit);
      const files = index === null ? undefined : history[index];
      if (files === undefined || !Object.hasOwn(files, relPath)) return null;
      return encoder.encode(files[relPath] ?? '');
    },

    async resolveCommit(rev: string): Promise<string | null> {
      assertRevision(rev);
      const index = commitIndex(rev);
      return index === null ? null : (commitIds[index] ?? null);
    },

    async listTree(commit: string): Promise<ListTreeResult> {
      assertReadArguments(commit, 'x');
      const index = commitIndex(commit);
      const files = index === null ? undefined : history[index];
      if (index === null || files === undefined) throw notFound(commit);
      const entries: TreeEntry[] = [];
      const diagnostics: Diagnostic[] = [];
      for (const rel of Object.keys(files).sort(compareCodeUnits)) {
        const mode = isLast(index) ? modes[rel] : undefined;
        if (mode === 'symlink') {
          diagnostics.push(diagnostic(SOURCE_TREE_CODES.symlinkSkipped, 'info', 'a symbolic link is never followed', rel));
        } else if (mode === 'gitlink') {
          diagnostics.push(diagnostic(SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a submodule entry is not read as a file', rel));
        } else {
          entries.push({ path: rel, mode: mode === 'executable' ? '100755' : '100644', type: 'blob', oid: blobId(files[rel] ?? '') });
        }
      }
      return { entries, diagnostics };
    },

    async readMany(commit: string, paths: readonly string[], options?: { readonly maxBlobBytes?: number }): Promise<ReadManyResult> {
      assertReadArguments(commit, 'x');
      const cap = options?.maxBlobBytes ?? DEFAULT_READ_TEXT_BYTES;
      const blobs = new Map<string, Uint8Array | null>();
      const diagnostics: Diagnostic[] = [];
      const asked: string[] = [];
      for (const rel of new Set(paths)) {
        const reason = batchPathReason(rel);
        if (reason === null) {
          asked.push(rel);
        } else {
          blobs.set(rel, null);
          diagnostics.push(diagnostic(SOURCE_TREE_CODES.unhashablePath, 'warning', reason, rel));
        }
      }
      if (asked.length === 0) return { blobs, diagnostics };
      const index = commitIndex(commit);
      const files = index === null ? undefined : history[index];
      if (index === null || files === undefined) throw notFound(commit);
      for (const rel of asked) {
        const mode = isLast(index) ? modes[rel] : undefined;
        if (!Object.hasOwn(files, rel) || mode === 'gitlink') {
          blobs.set(rel, null);
          continue;
        }
        const bytes = encoder.encode(files[rel] ?? '');
        if (bytes.length > cap) {
          blobs.set(rel, null);
          diagnostics.push(diagnostic(SOURCE_TREE_CODES.sourceTooLarge, 'info', `the blob is ${String(bytes.length)} bytes, over the ${String(cap)}-byte cap`, rel));
        } else {
          blobs.set(rel, bytes);
        }
      }
      return { blobs, diagnostics };
    },

    identity(): Promise<SourceTreeIdentity> {
      return Promise.resolve({ rootCommit, storeId, commonDir: `${FAKE_WORKTREE}/.git` });
    },
  };
}
