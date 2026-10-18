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
  /** History (STO-09): the commit, or an object it needs, is not in this repository (an unknown revision, a shallow clone). */
  commitNotFound: 'commit_not_found',
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

/** One worktree of a repository, as `git worktree list --porcelain -z` reports it. */
export interface WorktreeInfo {
  /** Canonical real path; a directory that no longer exists keeps the path git reports and is `prunable`. */
  readonly path: string;
  /** The checked-out commit, or null for a bare repository or a branch with no commits yet. */
  readonly head: string | null;
  /** The short branch name (`main`, not `refs/heads/main`), or null when detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** What {@link SourceTree.readText} found. A bad path is an answer, never a throw. */
export type ReadTextResult =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'not_file' }
  | { readonly kind: 'too_large' };

/** How a {@link SourceTree.listDirectory} request ended. A bad path is an answer, never a throw. */
export type DirectoryStatus = 'ok' | 'missing' | 'not_directory' | 'escape';

/** What {@link SourceTree.listDirectory} found. */
export interface DirectoryListing {
  readonly status: DirectoryStatus;
  /** The regular files directly inside the directory, sorted by code unit, at most the cap; empty unless `status` is `ok`. */
  readonly names: readonly string[];
  /** The directory's modification time in milliseconds (0 unless `status` is `ok`); it moves when an entry is added, removed or renamed. */
  readonly mtimeMs: number;
  /** True when the directory holds more names than the cap, or more entries than the bounded scan looks at. */
  readonly truncated: boolean;
  /** Set only when the caller's remembered `ifMtimeMs` still equals the directory's: `names` is then empty because nothing changed. */
  readonly unchanged?: true;
}

/** Options of {@link SourceTree.listDirectory}. */
export interface ListDirectoryOptions {
  /** The most names returned (default 5000, the approved `adr.listMaxEntries`). A whole number of at least 1. */
  readonly maxEntries?: number;
  /** The `mtimeMs` of an earlier listing the caller kept: when the directory still has it, the answer is `unchanged` and costs one stat. */
  readonly ifMtimeMs?: number;
}

/** The linguist attributes git reports for one path; `unset`, `unspecified` and `false` all mean off. */
export interface PathAttributes {
  readonly generated: boolean;
  readonly vendored: boolean;
}

/** What {@link SourceTree.sourceSet} keeps and why it drops the rest. */
export interface SourceSetOptions {
  /** Extensions a loaded module claims: lower-case, with the dot (`.ts`). Matched case-insensitively on the last path segment. */
  readonly extensions: readonly string[];
  /** Files larger than this many bytes are dropped with `source_too_large`. */
  readonly maxBytes: number;
  /**
   * An answer of {@link SourceTree.pathAttributes} to use instead of asking git again. It is an optimisation and
   * nothing more: an entry is used as given (even an all-false one), and a path the files include that the map lacks
   * is still asked for, so a partial map changes the number of git runs, never the result.
   */
  readonly attributes?: ReadonlyMap<string, PathAttributes>;
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

/** One blob of a commit's tree, as `git ls-tree` reports it. */
export interface TreeEntry {
  /** Repo-relative POSIX path, verbatim. */
  readonly path: string;
  /** The git file mode as printed (`100644`, `100755`); links and submodules are never entries. */
  readonly mode: string;
  /** Always `blob` for an entry; other object types are skipped with a diagnostic. */
  readonly type: string;
  /** The blob id (40 hex characters in a SHA-1 repository, 64 in a SHA-256 one). */
  readonly oid: string;
}

/** What {@link SourceTree.listTree} found. */
export interface ListTreeResult {
  /** Every blob of the commit's tree (executables included), sorted by path in code-unit order. */
  readonly entries: readonly TreeEntry[];
  /** One entry per skipped path: `symlink_skipped` for a link, `gitlink_skipped` for a submodule. */
  readonly diagnostics: Diagnostic[];
}

/** What {@link SourceTree.readMany} found. */
export interface ReadManyResult {
  /** Every requested path (once) to its bytes, or null when the commit has no such blob or it could not be used. */
  readonly blobs: ReadonlyMap<string, Uint8Array | null>;
  /** `source_too_large` for a blob over the cap and `unhashable_path` for a name that cannot ride the batch. */
  readonly diagnostics: Diagnostic[];
}

/** Which repository this is, stable across clones' checkouts of the same history at the same git directory. */
export interface SourceTreeIdentity {
  /**
   * The smallest object id among the root commits reachable from HEAD (the same set of roots always gives the same
   * id, whatever order git prints them in), or null for a repository with no commits.
   */
  readonly rootCommit: string | null;
  /** 16 hex characters of sha256(rootCommit, newline, real path of the common git directory). */
  readonly storeId: string;
  /** The canonical real path of the repository's common git directory (shared by every linked worktree); the store lives under it. */
  readonly commonDir: string;
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
   * The subset of `paths` (repo-relative POSIX), by exact name, that git lists as tracked or as untracked and not
   * ignored: the one thing the Indexer needs to know before it hashes a watcher path (T-02-14). The real tree runs
   * ONE `git ls-files -z --cached --others --exclude-standard` with no pathspec and nothing on stdin, and filters
   * the listing in process by string equality, so no name a repository or a watcher supplied ever reaches git (a
   * name can never be read as an option, a pattern or a magic pathspec). It says nothing about whether the file
   * exists or what kind it is: a gitlink is named by the listing, and so is a nested repository (as `dir/`, which
   * no file is named), so the caller tests that the path is a regular file. At most one git run, none for an empty
   * list. A path that is not repo-relative (absolute, a `..` segment, NUL, empty) rejects with `invalid_argument`
   * before git starts. A failed listing rejects with `git_failed`.
   */
  unignoredPaths(worktree: string, paths: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * The `linguist-generated` and `linguist-vendored` attributes of `paths` from ONE `git check-attr` run, for the
   * paths `hashPaths` would hash: the same vetting by name and by lstat, so a missing path, a directory, a link or a
   * name that cannot ride the batch gets no entry and starts no git (none at all when nothing is left). Every path it
   * asked git about has an entry, an all-false one included. It lets a caller ask while the clean filters are being
   * enumerated and hand the answer to `sourceSet` (`SourceSetOptions.attributes`).
   */
  pathAttributes(worktree: string, paths: readonly string[]): Promise<ReadonlyMap<string, PathAttributes>>;
  /**
   * The files of `files` (a snapshot or hashPaths result, so never an ignored one) that are source (LNG-05): a
   * claimed extension, not `linguist-generated` or `linguist-vendored`, not binary, not a Git LFS pointer and
   * not over `options.maxBytes`. One batched `check-attr` run at most; no git at all when nothing is left to ask.
   */
  sourceSet(worktree: string, files: ReadonlyMap<string, string>, options: SourceSetOptions): Promise<SourceSetResult>;
  /**
   * Every worktree of the repository (the main one first), from one `git worktree list --porcelain -z` run.
   * Needs git 2.36 or newer for `-z`; an older git makes this throw `git_failed` naming that version.
   */
  worktrees(): Promise<readonly WorktreeInfo[]>;
  /**
   * The text of `path` inside `worktree`, only if it stays inside after realpath, is a regular non-link file and
   * is at most `options.maxBytes` (default 2 MiB). A leading BOM and CRLF are kept as they are. Never throws for
   * bad input or bad content: see {@link ReadTextResult}.
   */
  readText(worktree: string, path: string, options?: { readonly maxBytes?: number }): Promise<ReadTextResult>;
  /**
   * The names of the regular files directly inside `dir` (repo-relative, POSIX) of `worktree` (plan 03-28, D-20: the ADR
   * directory). The path is confined like {@link SourceTree.readText}'s: one that is absolute, drive-relative, empty, holds NUL or
   * a `..` segment, or whose real path (links followed) leaves the worktree, is `escape` and nothing is read. A link among the
   * entries is never followed and never listed; a name with a line break or NUL, or that starts with a dash, is left out. Only
   * names come back, never file content. The scan looks at a bounded number of entries and sets `truncated` when it stopped
   * early or the cap cut the sorted list. It starts no git process. Never throws for a bad path or an unreadable directory.
   */
  listDirectory(worktree: string, dir: string, options?: ListDirectoryOptions): Promise<DirectoryListing>;
  /** True when the object database holds the object. False for an unknown or malformed id. */
  hasObject(hash: string): Promise<boolean>;
  /**
   * The bytes of `path` at `commit`, or null when the commit has no such blob. A blob over `options.maxBytes`
   * (default 2 MiB) throws {@link SourceTreeError} with code `source_too_large`; the real tree stops git one byte
   * past the cap, so an oversize blob is never buffered whole.
   */
  read(commit: string, path: string, options?: { readonly maxBytes?: number }): Promise<Uint8Array | null>;
  identity(): Promise<SourceTreeIdentity>;
  /**
   * The full commit id `rev` names, or null when no commit does. A revision that git could read as an option
   * (leading dash), or that holds NUL or a line break, throws `invalid_argument` before git starts.
   */
  resolveCommit(rev: string): Promise<string | null>;
  /**
   * Every blob of `commit`'s tree from one `git ls-tree -r -z --full-tree` run: git objects only, never the
   * working tree. Links and submodules are left out with a diagnostic. An unknown commit throws
   * {@link SourceTreeError} with code `commit_not_found`.
   */
  listTree(commit: string): Promise<ListTreeResult>;
  /**
   * The bytes of `paths` at `commit`, parsed binary-safely. The real tree first runs `git cat-file --batch-check`
   * (sizes only), then `git cat-file --batch` for the blobs at or under the cap alone, with an output cap that
   * follows their sizes; no git at all for an empty list and only the size check when nothing is selected. A
   * missing path is null; a blob over `options.maxBlobBytes` (default 2 MiB) is null with `source_too_large`
   * and a path that cannot ride the line-oriented batch is null with `unhashable_path`.
   * An unknown commit throws `commit_not_found`.
   */
  readMany(commit: string, paths: readonly string[], options?: { readonly maxBlobBytes?: number }): Promise<ReadManyResult>;
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
  /**
   * What `worktrees()` returns from the fake. Absent: one main worktree on `main` at the fake's HEAD. The real
   * harness does not realise this field (the contract never sets it); linked worktrees are exercised against git
   * directly in the real-only tests.
   */
  readonly worktrees?: readonly WorktreeInfo[];
  /**
   * The history (oldest first): each element is the complete file map of one commit. Absent: one commit made of
   * `committed`. HEAD is the last element; when present, `committed` should equal it. `HEAD~N` addresses earlier ones.
   */
  readonly commits?: readonly Readonly<Record<string, string>>[];
  /**
   * File modes of entries in the LAST commit that are not plain files: `symlink` (the content is the link target),
   * `executable` (mode 100755) and `gitlink` (a submodule; the content is ignored). Realised in the real harness
   * through the index, so it needs no file-system privileges.
   */
  readonly modes?: Readonly<Record<string, 'symlink' | 'executable' | 'gitlink'>>;
}
