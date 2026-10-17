/**
 * Path rules for names that arrive from outside the Indexer (watcher events, `fresh` arguments from agents).
 * A path is repo-relative, POSIX, free of NUL, and never climbs out of the worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../facts/index.ts';

/** True for a non-empty string that is not absolute, holds no NUL and has no `..` segment (either separator). */
export function isRepoRelative(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}

/** The real path of a worktree root, or undefined when it cannot be resolved. Compare paths through this, never raw strings. */
export async function realRoot(worktree: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(worktree);
  } catch {
    return undefined;
  }
}

/**
 * True when `rel` (already checked with {@link isRepoRelative}) stays inside the worktree after symlinks are
 * resolved: the real path of the file if it exists, otherwise of its nearest existing parent directory. A file that
 * does not exist yet (a new file an agent just wrote and a watcher has not reported) is therefore fine, and a link
 * that points out of the worktree is not.
 */
export async function staysInside(rootReal: string, rel: string): Promise<boolean> {
  let probe = path.join(rootReal, rel);
  for (;;) {
    try {
      return isInside(rootReal, await fs.promises.realpath(probe));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      const parent = path.dirname(probe);
      if (parent === probe || parent.length < rootReal.length) return false;
      probe = parent;
    }
  }
}
