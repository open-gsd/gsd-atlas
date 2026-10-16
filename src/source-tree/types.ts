import type { Diagnostic } from '../facts/index.ts';

/** Diagnostic codes a snapshot reports for paths it could not hash. */
export const SOURCE_TREE_CODES = {
  /** The path cannot go through the line-oriented batch (newline, carriage return, leading double quote, unsafe segments). */
  unhashablePath: 'unhashable_path',
  /** Listed by git but absent from disk: deleted, or outside a sparse checkout. */
  missingOnDisk: 'missing_on_disk',
  /** A symbolic link; Source Tree never follows links out of the worktree. */
  symlinkSkipped: 'symlink_skipped',
  /** A submodule or nested repository (mode 160000 or a directory entry). */
  gitlinkSkipped: 'gitlink_skipped',
  /** `hash-object` did not return exactly one id per input path. */
  hashOutputMismatch: 'hash_output_mismatch',
  /** Source set (LNG-05): git marks the file `linguist-generated`. */
  generatedSkipped: 'generated_skipped',
  /** Source set (LNG-05): git marks the file `linguist-vendored`. */
  vendoredSkipped: 'vendored_skipped',
  /** Source set (LNG-05): a NUL byte in the first 8 KB. */
  binarySkipped: 'binary_skipped',
  /** Source set (LNG-05): the content is a Git LFS pointer, not the file. */
  lfsPointerSkipped: 'lfs_pointer_skipped',
  /** Source set (LNG-05): no loaded module claims the extension. Info, one aggregated count rather than one per file. */
  extensionNotClaimed: 'extension_not_claimed',
  /** Source set (LNG-05): the file is larger than the byte cap. */
  sourceTooLarge: 'source_too_large',
} as const;

/** Thrown for failures that make a result untrustworthy (a failed git command, a hash batch that does not line up). */
export class SourceTreeError extends Error {
  /** A stable machine-readable code: a {@link SOURCE_TREE_CODES} value, `git_failed` or `invalid_argument`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceTreeError';
    this.code = code;
  }
}

/** What a snapshot found. */
export interface SnapshotResult {
  /**
   * Repo-relative POSIX path to git blob id (lowercase hex: 40 characters in a SHA-1 repository, 64 in a
   * SHA-256 one; never assume 40). The id is of the working-tree content after git's own line-ending
   * conversion, so it equals the blob id git would store for that file.
   */
  readonly files: ReadonlyMap<string, string>;
  /** One entry per path that was skipped, with a {@link SOURCE_TREE_CODES} code and the path as subject. */
  readonly diagnostics: Diagnostic[];
}

/** What {@link SourceTree.hashPaths} found: the same shape as a snapshot, for only the paths asked for. */
export interface HashPathsResult {
  /** Repo-relative POSIX path to git blob id, for every requested path that could be hashed, sorted by path. */
  readonly files: ReadonlyMap<string, string>;
  /** One entry per requested path that was left out, with a {@link SOURCE_TREE_CODES} code and the path as subject. */
  readonly diagnostics: Diagnostic[];
}

/** What {@link SourceTree.sourceSet} keeps and why it drops the rest. */
export interface SourceSetOptions {
  /** Extensions a loaded module claims: lower-case, with the dot (`.ts`). Matched case-insensitively on the last path segment. */
  readonly extensions: readonly string[];
  /** Files larger than this many bytes are dropped with `source_too_large`. */
  readonly maxBytes: number;
}

export interface SourceSetResult {
  /** The surviving path to blob id entries (ids as given), sorted by path in code-unit order. */
  readonly files: ReadonlyMap<string, string>;
  /**
   * One diagnostic per dropped file (its path as subject, a {@link SOURCE_TREE_CODES} code), plus at most one
   * leading `extension_not_claimed` info with the count of paths no module claims. Sorted by path.
   */
  readonly skipped: readonly Diagnostic[];
}

/** Which repository this is, stable across clones' checkouts of the same history at the same git directory. */
export interface SourceTreeIdentity {
  /** The first root commit of HEAD's history, or null for a repository with no commits. */
  readonly rootCommit: string | null;
  /** 16 hex characters of sha256(rootCommit, newline, real path of the common git directory). */
  readonly storeId: string;
}

/**
 * The Source Tree seam: everything the rest of the system learns from git and the file system.
 *
 * `snapshot` takes the worktree directory to scan; the other methods act on the tenant's repository
 * (the `repoDir` the tree was created for), because one repository and all its linked worktrees share
 * one object database.
 *
 * Arguments that could be read as git options (a hash or commit starting with `-`) or that cannot be a
 * path (NUL) never reach git: `hasObject` answers false for a malformed id and `read` throws a
 * {@link SourceTreeError} with code `invalid_argument`.
 */
export interface SourceTree {
  /** Hashes the tracked and untracked-not-ignored files of `worktree` with one batched git call. */
  snapshot(worktree: string): Promise<SnapshotResult>;
  /**
   * Hashes only `paths` (repo-relative POSIX) of `worktree`: duplicates are hashed once, the clean filters and
   * line-ending rules git would apply are applied, and a path that is absent, a link, a directory or cannot ride
   * the line-oriented batch is left out with a coded diagnostic while the rest are still hashed. The real
   * implementation starts git twice however many paths there are (enumerate filter drivers, one batched hash)
   * and not at all when nothing can be hashed. It hashes what it is asked to: it does NOT consult ignore rules,
   * so a caller holding watcher paths must drop ignored ones first (T-02-14).
   */
  hashPaths(worktree: string, paths: readonly string[]): Promise<HashPathsResult>;
  /**
   * The files of `files` (a snapshot or hashPaths result, so never an ignored one) that are source (LNG-05): a
   * claimed extension, not `linguist-generated` or `linguist-vendored`, not binary, not a Git LFS pointer and
   * not over `options.maxBytes`. One batched `check-attr` run at most; no git at all when nothing is left to ask.
   */
  sourceSet(worktree: string, files: ReadonlyMap<string, string>, options: SourceSetOptions): Promise<SourceSetResult>;
  /** True when the object database holds the object. False for an unknown or malformed id. */
  hasObject(hash: string): Promise<boolean>;
  /** The bytes of `path` at `commit`, or null when the commit has no such blob. */
  read(commit: string, path: string): Promise<Uint8Array | null>;
  identity(): Promise<SourceTreeIdentity>;
}

/**
 * A repository as data, from which the fake derives and from which the contract suite realises a real
 * temporary repository. `committed` is the single commit's files, `working` overrides it in the working
 * tree (a string edits or adds a file, `null` deletes a tracked one) and `ignored` lists repo-relative
 * paths (a trailing `/` makes a directory) that untracked-file listing leaves out.
 */
export interface SourceTreeWorld {
  readonly committed: Readonly<Record<string, string>>;
  readonly working: Readonly<Record<string, string | null>>;
  readonly ignored: readonly string[];
  /**
   * `linguist-generated` / `linguist-vendored` per exact repo-relative path: `true` sets it, `false` sets it
   * explicitly off (`-linguist-generated`), absent leaves it unspecified. The real harness writes these to
   * `.git/info/attributes`, so they never appear in a snapshot.
   */
  readonly attributes?: Readonly<Record<string, { readonly generated?: boolean; readonly vendored?: boolean }>>;
}
