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

/** A git object id: lowercase hex, 40 characters (SHA-1) or 64 (SHA-256). Never assume 40. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isObjectId = (value: string): boolean => OBJECT_ID.test(value);

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
