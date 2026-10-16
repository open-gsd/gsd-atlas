/**
 * Path rules for names that arrive from outside the Indexer (watcher events, `fresh` arguments from agents).
 * A path is repo-relative, POSIX, free of NUL, and never climbs out of the worktree.
 */

/** True for a non-empty string that is not absolute, holds no NUL and has no `..` segment (either separator). */
export function isRepoRelative(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}
