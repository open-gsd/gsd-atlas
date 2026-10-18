/**
 * Confined directory listing (plan 03-28, D-20, T-03-281): the Tenant lists the ADR directories the module manifests and the
 * repository's own config name, and those names are repository data, so the path is treated as hostile exactly as in
 * `read-text.ts`. A path that is not a plain repo-relative one, or whose real path (every link followed) leaves the worktree,
 * is answered `escape` and never opened. Only names of regular files come back; no file is opened or read.
 *
 * The scan is bounded (T-03-284): it looks at no more than a few times the cap of entries, sorts what it kept by code unit and
 * says `truncated` when it stopped early or the cap cut the list. A caller that remembers the directory's modification time can
 * pass it back and get `unchanged` for the price of one stat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../facts/index.ts';
import { SourceTreeError } from './types.ts';
import type { DirectoryListing, DirectoryStatus, ListDirectoryOptions } from './types.ts';
import { escapesWorktree } from './validate.ts';

/** The most names a listing returns when the caller names no cap: `adr.listMaxEntries`, 03-CONSTANTS.md (Approved). */
export const DEFAULT_LIST_MAX_ENTRIES = 5000;

/**
 * How many directory entries one scan looks at, as a multiple of the cap. Not a timeout, a queue bound or a gate threshold, so it
 * has no row in the constants file: it only bounds the memory a hostile directory of millions of entries can cost.
 */
const SCAN_FACTOR = 4;

/** How many entries of an unknown type are lstat-ed at once. */
const LSTAT_BATCH = 64;

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The cap a call asked for, or the default; anything but a whole number of at least 1 is refused before anything is read. */
export function resolveMaxEntries(options: ListDirectoryOptions | undefined): number {
  const cap = options?.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new SourceTreeError('invalid_argument', `maxEntries must be a whole number of at least 1, got ${String(cap)}`);
  }
  return cap;
}

/** A name worth listing: not empty, no line break or NUL (it could split a line a caller prints) and no leading dash (option-like). */
export const isListableName = (name: string): boolean => name !== '' && !/[\0\r\n]/.test(name) && !name.startsWith('-');

/** `dir` without trailing separators, or null when nothing is left (the root is not a directory a caller may name). */
export function trimDirectory(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed === '' ? null : trimmed;
}

const answer = (status: DirectoryStatus): DirectoryListing => ({ status, names: [], mtimeMs: 0, truncated: false });

const isAbsent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export async function listConfinedDirectory(worktree: string, dir: string, options?: ListDirectoryOptions): Promise<DirectoryListing> {
  const cap = resolveMaxEntries(options);
  if (escapesWorktree(dir)) return answer('escape');
  const rel = trimDirectory(dir);
  if (rel === null) return answer('escape');
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(worktree);
  } catch {
    return answer('missing');
  }
  const joined = path.join(rootReal, rel);
  if (!isInside(rootReal, joined)) return answer('escape');

  let real: string;
  try {
    real = fs.realpathSync.native(joined);
  } catch (error) {
    return answer(isAbsent(error) ? 'missing' : 'not_directory');
  }
  // Links are followed only to a place inside the worktree: a link that leaves it is refused, whatever it points at.
  if (!isInside(rootReal, real)) return answer('escape');

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch (error) {
    return answer(isAbsent(error) ? 'missing' : 'not_directory');
  }
  if (!stat.isDirectory()) return answer('not_directory');
  if (options?.ifMtimeMs !== undefined && options.ifMtimeMs === stat.mtimeMs) {
    return { status: 'ok', names: [], mtimeMs: stat.mtimeMs, truncated: false, unchanged: true };
  }

  const names: string[] = [];
  const unknown: string[] = [];
  let scanned = 0;
  let stoppedEarly = false;
  let handle: fs.Dir;
  try {
    handle = await fs.promises.opendir(real);
  } catch {
    return answer('missing');
  }
  try {
    for await (const entry of handle) {
      if (scanned >= cap * SCAN_FACTOR) {
        stoppedEarly = true;
        break;
      }
      scanned += 1;
      if (!isListableName(entry.name)) continue;
      if (entry.isFile()) names.push(entry.name);
      // A file system that does not report the type of an entry: ask, and keep only what is a regular file and not a link.
      else if (!entry.isDirectory() && !entry.isSymbolicLink() && !entry.isFIFO() && !entry.isSocket() && !entry.isBlockDevice() && !entry.isCharacterDevice()) {
        unknown.push(entry.name);
      }
    }
  } catch {
    return answer('missing');
  } finally {
    await handle.close().catch(() => {});
  }
  for (let at = 0; at < unknown.length; at += LSTAT_BATCH) {
    const slice = unknown.slice(at, at + LSTAT_BATCH);
    const regular = await Promise.all(
      slice.map(async (name) => {
        try {
          return (await fs.promises.lstat(path.join(real, name))).isFile();
        } catch {
          return false;
        }
      }),
    );
    slice.forEach((name, i) => {
      if (regular[i] === true) names.push(name);
    });
  }

  names.sort(compareCodeUnits);
  return { status: 'ok', names: names.slice(0, cap), mtimeMs: stat.mtimeMs, truncated: stoppedEarly || names.length > cap };
}
