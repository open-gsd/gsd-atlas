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
}
