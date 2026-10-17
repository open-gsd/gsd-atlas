/**
 * Where a store lives (STO-07, sqlite-store ADR decision 3, research Pattern 4).
 *
 * By default the store is `<git common dir>/gsd-atlas`, so every worktree of a repository finds the same index
 * and nothing is ever committed. It moves to `<cache root>/gsd-atlas/<storeId>` (one decision, never a refusal)
 * when the common dir is missing, not writable, inside a synced folder (iCloud Drive, Dropbox, OneDrive, Google
 * Drive), on a network mount, or when `<common dir>/gsd-atlas` is itself a symbolic link. A `store.dir`
 * override wins over all of it.
 *
 * The override is a parameter (or the user's environment), never something read from the repository: nothing in
 * this module opens a file inside the working tree or the git directory, so a hostile repository cannot place
 * the store (threat T-02-36). The only filesystem calls are `lstat`, `statfs`, `access` and `mkdir`, and `mkdir`
 * runs only in `resolveStoreLocation`: `decideStoreLocation` and `findExistingStore` never touch the working tree or
 * the git directory except to look (plan 02-41, WR-01).
 */
import fs from 'node:fs';
import path from 'node:path';
import { STORE_FILE_NAME } from './schema.ts';

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
  /** The store directory; it exists when `resolveStoreLocation` returns (`decideStoreLocation` does not create it). */
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
  /** The user's environment; `GSD_ATLAS_STORE_DIR` is read as the override when `override` is not given. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected `fs.statfs` (tests): the filesystem type number of a path. */
  readonly statfs?: (path: string) => { readonly type: number } | undefined;
}

/** The folder the store takes inside the git common dir and inside the cache root. */
const STORE_DIR_NAME = 'gsd-atlas';

/** The environment variable that carries the user's `store.dir` override. */
const STORE_DIR_ENV = 'GSD_ATLAS_STORE_DIR';

/** `statfs` type numbers (Linux `f_type` magic values) of filesystems that live on another machine. */
const NETWORK_FILESYSTEM_TYPES: ReadonlyMap<number, string> = new Map([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0x65735546, 'FUSE'],
  [0x5346414f, 'AFS'],
]);

/** Path segments (lower case) that name a synced-folder root. */
const SYNCED_SEGMENTS: ReadonlySet<string> = new Set([
  'dropbox',
  'onedrive',
  'icloud drive',
  'mobile documents',
  'google drive',
  'googledrive',
]);

/** Segment prefixes (lower case) that name a synced-folder root, such as `OneDrive - Contoso`. */
const SYNCED_PREFIXES: readonly string[] = ['onedrive - '];

/**
 * True when `candidate` sits inside a folder that a sync client manages, or (on Windows) on a UNC share.
 * Pure: it looks at the text of the path only. macOS keeps File Provider folders (OneDrive, Google Drive,
 * Dropbox and others) under `Library/CloudStorage`, which counts as synced whatever the provider is called.
 */
export function isSyncedFolderPath(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32' && (candidate.startsWith('\\\\') || candidate.startsWith('//'))) return true;
  const segments = candidate.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return segments.some((segment, index) => {
    if (SYNCED_SEGMENTS.has(segment)) return true;
    if (SYNCED_PREFIXES.some((prefix) => segment.startsWith(prefix))) return true;
    return segment === 'cloudstorage' && segments[index - 1] === 'library';
  });
}

/** `XDG_CACHE_HOME` when it is an absolute path (as the XDG specification requires), otherwise `<home>/.cache`. */
export function defaultCacheRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env['XDG_CACHE_HOME'];
  return xdg !== undefined && xdg !== '' && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache');
}

function defaultStatfs(target: string): { readonly type: number } | undefined {
  return fs.statfsSync(target);
}

function onNetworkMount(target: string, statfs: (path: string) => { readonly type: number } | undefined): boolean {
  try {
    const type = statfs(target)?.type;
    return type !== undefined && NETWORK_FILESYSTEM_TYPES.has(type);
  } catch {
    return false; // the check could not run on this platform or path: skip it rather than refuse
  }
}

/** What is at `target`, without following a link at the final component. */
function entryState(target: string): 'absent' | 'directory' | 'symlink' | 'other' {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'absent';
  }
}

const located = (dir: string, kind: StoreLocationKind, reason?: CacheReason): StoreLocation =>
  reason === undefined ? { dir, kind } : { dir, kind, reason };

/**
 * Decide where the store of `input.storeId` lives, and create nothing (WR-01, plan 02-41): only `lstat`, `statfs`
 * and `access` run, so a request that merely asks where a store would be cannot leave a directory behind. Order:
 * override, no git, synced folder, network mount, symbolic link, not writable, else the git common dir.
 */
export function decideStoreLocation(input: ResolveStoreLocationInput): StoreLocation {
  const platform = input.platform ?? process.platform;

  const fromEnv = input.env?.[STORE_DIR_ENV];
  const override = input.override ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv);
  if (override !== undefined) {
    if (!path.isAbsolute(override)) {
      throw new Error(`store.dir must be an absolute path (got ${JSON.stringify(override)})`);
    }
    return located(path.join(override, input.storeId), 'override');
  }

  const cache = (reason: CacheReason): StoreLocation =>
    located(path.join(input.cacheRoot, STORE_DIR_NAME, input.storeId), 'cache', reason);

  if (input.commonDir === null) return cache('not_a_git_repo');
  const common = path.resolve(input.repoDir, input.commonDir);
  if (isSyncedFolderPath(common, platform)) return cache('synced_folder');
  if (onNetworkMount(common, input.statfs ?? defaultStatfs)) return cache('network_mount');

  const storeDir = path.join(common, STORE_DIR_NAME);
  const state = entryState(storeDir);
  if (state === 'symlink') return cache('store_dir_is_symlink');
  if (state === 'other') return cache('not_writable'); // something that is not a directory is in the way
  try {
    fs.accessSync(state === 'directory' ? storeDir : common, fs.constants.W_OK);
    return located(storeDir, 'git-common');
  } catch {
    return cache('not_writable');
  }
}

/**
 * Decide where the store of `input.storeId` lives, create that directory (mode 0700, recursive, idempotent) and
 * return it. The decision is `decideStoreLocation`'s.
 */
export function resolveStoreLocation(input: ResolveStoreLocationInput): StoreLocation {
  const location = decideStoreLocation(input);
  // Owner-only; recursive creation tolerates a concurrent creator.
  fs.mkdirSync(location.dir, { recursive: true, mode: 0o700 });
  return location;
}

/**
 * The location of the store of `input.storeId` when that store already holds a `facts.db` (a regular file), decided
 * by exactly the rules `resolveStoreLocation` uses, and `undefined` otherwise. It creates nothing and opens nothing:
 * a read request uses it to learn whether anything was ever built (WR-01), and a store that does not exist is not
 * created by asking.
 */
export function findExistingStore(input: ResolveStoreLocationInput): StoreLocation | undefined {
  const location = decideStoreLocation(input);
  try {
    return fs.lstatSync(path.join(location.dir, STORE_FILE_NAME)).isFile() ? location : undefined;
  } catch {
    return undefined;
  }
}
