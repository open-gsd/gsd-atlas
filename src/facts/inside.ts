/**
 * The one containment test (IN-03). Pure: it compares two absolute paths as written and touches no file system, so a
 * caller that cares about links resolves them first (`realpath`) and passes the results.
 */
import path from 'node:path';

/**
 * True when `candidate` is `root` or lies below it. Built on `relative`, so it is separator-aware: `/a/bc` is not
 * inside `/a/b`, trailing separators do not matter, and a directory called `..cache` is a child, not a parent.
 * `api` selects the path flavour (default: the running platform's), so the Windows rules (drive letters,
 * case-insensitive comparison) can be tested on every OS.
 */
export function isInside(root: string, candidate: string, api: typeof path = path): boolean {
  const rel = api.relative(root, candidate);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${api.sep}`)) return false;
  // `relative` returns an absolute path when no relative form exists: another drive on Windows.
  return !api.isAbsolute(rel);
}
