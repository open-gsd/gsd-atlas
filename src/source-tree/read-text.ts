/**
 * Confined text reads (T-02-11): Query reads matched line text through here, and the path it asks for comes
 * from repository-derived data, so it is treated as hostile. A path that is not repo-relative, that leaves the
 * worktree through `..`, or that reaches outside through a symlinked directory is answered `escape` and never
 * opened; a final-component link or anything that is not a regular file is `not_file`. Bad input is an answer,
 * not an exception.
 *
 * Containment compares real paths, never the raw strings, with a trailing separator so `/work/repo-evil` is
 * not "inside" `/work/repo`. The open adds O_NOFOLLOW where the platform has it, so a file swapped for a link
 * after the checks is still never followed. A parent directory swapped for a link between the realpath and the
 * open is a race this module narrows but cannot close; the reader's answer is text for one query, not a store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../facts/index.ts';
import type { ReadTextResult } from './types.ts';
import { escapesWorktree } from './validate.ts';

/** The cap when the caller names none: 2 MiB, far above any source file the source set keeps. */
export const DEFAULT_READ_TEXT_BYTES = 2 * 1024 * 1024;

const O_NOFOLLOW: number = (fs.constants as Partial<Record<string, number>>)['O_NOFOLLOW'] ?? 0;
// A BOM is data the caller decides about (Query strips it for display), so it is kept in the text.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

const isAbsent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export async function readConfinedText(worktree: string, relPath: string, maxBytes: number): Promise<ReadTextResult> {
  if (escapesWorktree(relPath)) return { kind: 'escape' };
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(worktree);
  } catch {
    return { kind: 'missing' };
  }
  const joined = path.join(rootReal, relPath);
  if (!isInside(rootReal, joined)) return { kind: 'escape' };

  try {
    const st = await fs.promises.lstat(joined);
    if (!st.isFile()) return { kind: 'not_file' };
  } catch (error) {
    return { kind: isAbsent(error) ? 'missing' : 'not_file' };
  }

  let real: string;
  try {
    real = fs.realpathSync.native(joined);
  } catch (error) {
    return { kind: isAbsent(error) ? 'missing' : 'not_file' };
  }
  if (!isInside(rootReal, real)) return { kind: 'escape' };

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    return { kind: isAbsent(error) ? 'missing' : 'not_file' };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { kind: 'not_file' };
    if (st.size > maxBytes) return { kind: 'too_large' };
    // One byte of slack detects a file that grew between fstat and read.
    const buffer = Buffer.alloc(st.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > st.size) return { kind: 'too_large' };
    return { kind: 'ok', text: decoder.decode(buffer.subarray(0, bytesRead)) };
  } catch {
    return { kind: 'not_file' };
  } finally {
    await handle.close();
  }
}
