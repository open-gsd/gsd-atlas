/**
 * The repo-level `.atlasignore` (quick task 261021-re7, D-02 and D-04). It is a file in git's ignore syntax that git itself
 * evaluates (`ls-files --exclude-per-directory=.atlasignore`), so it can only shrink the index. A repository supplies it,
 * so it is untrusted data (the trust-boundaries ADR and ADR 5 amendments of 2026-10-21): before git is told to read any such
 * file, every one the listings name is read through the confined reader, and a file that is not a regular file inside the
 * worktree, is too large, or is not valid text makes `.atlasignore` unusable for the whole worktree in that call. Git
 * cannot skip one file of a per-directory set, so the rule is all or nothing; nothing from a file ever reaches an argument.
 */
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { ATLASIGNORE_FILE, ATLASIGNORE_MAX_BYTES } from './default-excludes.ts';
import { readConfinedText } from './read-text.ts';
import { SOURCE_TREE_CODES } from './types.ts';
import type { ExclusionCounts } from './types.ts';

/** `none`: no listed `.atlasignore` to read. `usable`: every one passed. `unusable`: at least one did not. */
export type AtlasignoreVerdict = 'none' | 'usable' | 'unusable';

/** A path a listing named, with the git mode when the listing carries one (`ls-files -s`). */
export interface ListedPath {
  readonly path: string;
  readonly mode?: string;
}

/** True when `text` cannot be rules: it holds a NUL byte, or bytes that were not valid UTF-8 (decoded as U+FFFD). */
export function isMalformedRuleText(text: string): boolean {
  return text.includes('\0') || text.includes('�');
}

/** True when `rel` has `.atlasignore` as a leading directory, i.e. a directory with that name exists. */
export function hasAtlasignoreDirectory(rel: string): boolean {
  return rel.split('/').slice(0, -1).includes(ATLASIGNORE_FILE);
}

/** True when the last segment of `rel` is `.atlasignore`. */
export function isAtlasignorePath(rel: string): boolean {
  return rel === ATLASIGNORE_FILE || rel.endsWith(`/${ATLASIGNORE_FILE}`);
}

/**
 * Reads every listed `.atlasignore` of `worktree` and says whether git may be told to evaluate them. Never throws, never
 * echoes a path or any content. A listed file that is not on disk has nothing to read (git finds nothing either); a link
 * (on disk, or by mode in the index), a directory of that name, a file the confined reader refuses, text with a NUL byte
 * or invalid UTF-8, or more than 64 KiB in total make the verdict `unusable`.
 */
export async function vetAtlasignore(worktree: string, listed: readonly ListedPath[]): Promise<AtlasignoreVerdict> {
  const files = new Set<string>();
  for (const { path: rel, mode } of listed) {
    if (hasAtlasignoreDirectory(rel)) return 'unusable';
    if (!isAtlasignorePath(rel)) continue;
    if (mode === '120000' || mode === '160000') return 'unusable';
    files.add(rel);
  }
  let remaining = ATLASIGNORE_MAX_BYTES;
  let found = false;
  for (const rel of [...files].sort()) {
    const read = await readConfinedText(worktree, rel, remaining);
    if (read.kind === 'missing') continue;
    if (read.kind !== 'ok' || isMalformedRuleText(read.text)) return 'unusable';
    remaining -= Buffer.byteLength(read.text);
    found = true;
  }
  return found ? 'usable' : 'none';
}

const files = (n: number): string => `${String(n)} ${n === 1 ? 'file was' : 'files were'}`;

/**
 * The notes of a snapshot about the exclusions, in a fixed order: files left out by the built-in defaults, files left out
 * by `.atlasignore` (each only when above zero, as info) and one warning when a `.atlasignore` could not be used. Fixed
 * wording, counts only: no path, no pattern and no repository text ever appears in a note.
 */
export function exclusionNotes(excluded: ExclusionCounts, atlasignoreUnusable: boolean): Diagnostic[] {
  const notes: Diagnostic[] = [];
  if (excluded.byDefaults > 0) {
    notes.push(
      diagnostic(
        SOURCE_TREE_CODES.excludedByDefaults,
        'info',
        `${files(excluded.byDefaults)} left out of the index by the built-in tooling and build-output exclusions`,
      ),
    );
  }
  if (excluded.byAtlasignore > 0) {
    notes.push(diagnostic(SOURCE_TREE_CODES.excludedByAtlasignore, 'info', `${files(excluded.byAtlasignore)} left out of the index by ${ATLASIGNORE_FILE}`));
  }
  if (atlasignoreUnusable) {
    notes.push(
      diagnostic(
        SOURCE_TREE_CODES.atlasignoreUnusable,
        'warning',
        `a ${ATLASIGNORE_FILE} file was not used: it is larger than 64 KiB in total, is not valid text, or is not a regular file`,
      ),
    );
  }
  return notes;
}
