/** Where a store lives (STO-07). */
export type StoreLocationKind = 'git-common' | 'cache' | 'override';

/** Why a store is in the cache directory instead of the git common directory. */
export type CacheReason =
  | 'not_a_git_repo'
  | 'not_writable'
  | 'synced_folder'
  | 'network_mount'
  | 'store_dir_is_symlink';

export interface StoreLocation {
  /** The store directory; it exists when `resolveStoreLocation` returns. */
  readonly dir: string;
  readonly kind: StoreLocationKind;
  /** Set when `kind` is `cache`: why the git common directory was not used. */
  readonly reason?: CacheReason;
}

export interface ResolveStoreLocationInput {
  /** From `SourceTree.identity()`. */
  readonly storeId: string;
  /** `git rev-parse --git-common-dir` (absolute, or relative to `repoDir`), or null outside a git repository. */
  readonly commonDir: string | null;
  /** The checkout the caller serves; a relative `commonDir` is taken from here. */
  readonly repoDir: string;
  /** The user's `store.dir` setting. It must come from user-level configuration, never from the repository. */
  readonly override?: string;
  /** The cache root (see `defaultCacheRoot`). */
  readonly cacheRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected `fs.statfs` (tests): the filesystem type number of a path. */
  readonly statfs?: (path: string) => { readonly type: number } | undefined;
}

/** PLACEHOLDER for the red commit of plan 02-12. */
export function resolveStoreLocation(input: ResolveStoreLocationInput): StoreLocation {
  return { dir: input.cacheRoot, kind: 'cache', reason: 'not_a_git_repo' };
}

/** PLACEHOLDER for the red commit of plan 02-12. */
export function isSyncedFolderPath(path: string, platform: NodeJS.Platform): boolean {
  void path;
  void platform;
  return false;
}

/** PLACEHOLDER for the red commit of plan 02-12. */
export function defaultCacheRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  void env;
  return home;
}
