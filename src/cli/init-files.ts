/**
 * File handling for `gsd-atlas init`: the only code that reads or writes a user's host configuration.
 * Every write is atomic (temp file in the same directory, then rename), keeps one never-overwritten
 * backup of the first original, writes through a symbolic link to its real target and preserves the
 * file's BOM, line endings and permission bits. Imports node: built-ins only (adapter rule).
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Eol = '\n' | '\r\n';

/** A config file as read: BOM removed from `text`, the BOM and the dominant line ending remembered. */
export interface UserFile {
  readonly text: string;
  readonly bom: boolean;
  readonly eol: Eol;
}

export type ReadResult =
  | { readonly ok: true; readonly file: UserFile }
  | { readonly ok: false; readonly reason: string };

export type PathKind = 'file' | 'directory' | 'other' | 'missing';

/** Suffix of the one-time backup that sits beside the file that was changed. */
export const BACKUP_SUFFIX = '.gsd-atlas-backup';

const BOM_BYTES = [0xef, 0xbb, 0xbf];

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code);
}

/** What `p` is, following links. A missing path and a missing parent folder both read as `missing`. */
export async function detectHomeFile(p: string): Promise<PathKind> {
  try {
    const info = await stat(p);
    if (info.isFile()) {
      return 'file';
    }
    return info.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (hasCode(error, 'ENOENT', 'ENOTDIR')) {
      return 'missing';
    }
    throw error;
  }
}

function dominantEol(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = text.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > lf ? '\r\n' : '\n';
}

/** Read as strict UTF-8. A NUL byte (UTF-16 and binary files carry them) or invalid UTF-8 is refused. */
export async function readUserFile(p: string): Promise<ReadResult> {
  const bytes = await readFile(p);
  if (bytes.includes(0)) {
    return { ok: false, reason: 'the file contains a NUL byte, so it is not a text configuration file' };
  }
  const bom = BOM_BYTES.every((byte, index) => bytes[index] === byte);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bom ? BOM_BYTES.length : 0));
  } catch {
    return { ok: false, reason: 'the file is not valid UTF-8' };
  }
  return { ok: true, file: { text, bom, eol: dominantEol(text) } };
}

/** The real path to write: a symbolic link resolves to its target; a dangling link is an error. */
async function resolveTarget(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }
  let info;
  try {
    info = await lstat(p);
  } catch {
    return p; // nothing there at all: a new file at this path
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${p} is a symbolic link whose target does not exist`);
  }
  return p;
}

export interface WriteOptions {
  /** Write a UTF-8 BOM first. */
  readonly bom: boolean;
}

export interface WriteOutcome {
  /** The real file that was written (a link's target). */
  readonly path: string;
  readonly backupCreated: boolean;
}

/**
 * Replace the file at `p` with `nextText`. The first time an existing file changes, its bytes are
 * copied to `{file}.gsd-atlas-backup` (exclusive create, so a backup is never overwritten); the new
 * text goes to a temp file in the same directory and is renamed over the target. The temp file is
 * removed on any failure.
 */
export async function writeUserFile(p: string, nextText: string, options: WriteOptions): Promise<WriteOutcome> {
  const target = await resolveTarget(p);
  let mode = 0o600; // a new file may hold launch commands: keep it private
  let exists = false;
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`${target} is not a regular file`);
    }
    mode = info.mode & 0o777;
    exists = true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }

  let backupCreated = false;
  if (exists) {
    try {
      await copyFile(target, `${target}${BACKUP_SUFFIX}`, constants.COPYFILE_EXCL);
      backupCreated = true;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }

  const bytes = Buffer.concat([Buffer.from(options.bom ? BOM_BYTES : []), Buffer.from(nextText, 'utf8')]);
  const temp = path.join(path.dirname(target), `${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode });
    await chmod(temp, mode); // the umask may have narrowed the mode given to writeFile
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { path: target, backupCreated };
}
