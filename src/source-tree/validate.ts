import path from 'node:path';
import { SourceTreeError } from './types.ts';

/**
 * Reasons a path cannot ride in the line-oriented `--stdin-paths` batch (or leaves the worktree). Returns the
 * reason, or null if it can. The real tree and the fake both vet with this, so the codes agree (02-05).
 */
export function unhashableReason(rel: string): string | null {
  if (rel === '') return 'empty path';
  if (rel.includes('\n') || rel.includes('\r')) return 'the name contains a line break, which would split the hash batch';
  // git reads a leading double quote as a C-style quoted path in --stdin-paths.
  if (rel.startsWith('"')) return 'the name starts with a double quote, which git would unquote';
  if (rel.includes('\0')) return 'the name contains NUL';
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return 'the path is absolute';
  if (rel.split('/').includes('..')) return 'the path leaves the worktree';
  return null;
}

/**
 * True for a path that is not a plain repo-relative one: empty, NUL, absolute (either flavour), drive-relative
 * (`C:x`) or with a `..` segment split on either separator. `readText` answers `escape` for it without touching
 * the file system (T-02-11); the real tree and the fake share it.
 */
export function escapesWorktree(rel: string): boolean {
  if (rel === '' || rel.includes('\0')) return true;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return true;
  return rel.split(/[\\/]/).includes('..');
}

/** A git object id: lowercase hex, 40 characters (SHA-1) or 64 (SHA-256). Never assume 40. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isObjectId = (value: string): boolean => OBJECT_ID.test(value);

/** The longest revision string `resolveCommit` hands to git. */
const MAX_REVISION_CHARS = 512;

/**
 * Rejects a revision git could read as an option (a leading dash), one that is empty or too long, and one with
 * NUL or a line break (T-02-88). Run before git starts, by the real tree and the fake alike.
 */
export function assertRevision(rev: string): void {
  if (rev === '' || rev.length >= MAX_REVISION_CHARS || rev.startsWith('-') || /[\0\r\n]/.test(rev)) {
    throw new SourceTreeError('invalid_argument', 'a revision must be non-empty, under 512 characters, not option-like, and hold no NUL or line break');
  }
}

/**
 * Why `rel` cannot be asked of `cat-file --batch` as `COMMIT:PATH` on one line, or null. The batch is line
 * oriented, so a line break or NUL would split or corrupt it; `./` and `../` would be read relative to the
 * directory git runs in; an absolute path is not a tree path.
 */
export function batchPathReason(rel: string): string | null {
  if (rel === '') return 'empty path';
  if (rel.includes('\n') || rel.includes('\r')) return 'the name contains a line break, which would split the object batch';
  if (rel.includes('\0')) return 'the name contains NUL';
  if (rel.startsWith('./') || rel.startsWith('../') || rel === '.' || rel === '..') return 'the path is relative to the working directory, not the tree';
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return 'the path is absolute';
  return null;
}

/**
 * Rejects a `read` argument that git could read as an option, a revision range or a different path
 * (T-01-34). Both the real tree and the fake run it, so the contract holds for both.
 */
export function assertReadArguments(commit: string, relPath: string): void {
  if (commit === '' || commit.startsWith('-') || /[\s\0:]/.test(commit)) {
    throw new SourceTreeError('invalid_argument', 'commit must be a revision name or id that is not option-like and has no whitespace, NUL or colon');
  }
  if (relPath === '' || relPath.includes('\0') || relPath.includes('\n') || relPath.includes('\r')) {
    throw new SourceTreeError('invalid_argument', 'path must be non-empty and contain no NUL or line break');
  }
}
