/**
 * File handling for `gsd-atlas init`: the only code that reads or writes a user's host configuration.
 * Every write is atomic (temp file in the same directory, then rename), keeps one never-overwritten
 * backup of the first original, writes through a symbolic link to its real target and preserves the
 * file's BOM, line endings and permission bits. Imports node: built-ins only (adapter rule).
 *
 * Lost updates (WR-12): other programs rewrite these files while init runs. The sha256 of the bytes
 * init read (or the fact that there was no file) travels from the read to the write; `writeUserFile`
 * re-reads the target and compares before the one-time backup and again after the temp file is written,
 * right before the rename, and throws `ConfigChangedError` (and writes nothing) on a difference. The
 * window that remains is the time between the last compare and the rename, microseconds, and it cannot
 * be closed: a rename is not conditional on the content it replaces.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Eol = '\n' | '\r\n';

/** A config file as read: BOM removed from `text`, the BOM and the dominant line ending remembered. */
export interface UserFile {
  readonly text: string;
  readonly bom: boolean;
  readonly eol: Eol;
  /** sha256 (hex) of the raw bytes as read, BOM included: what `writeUserFile` compares before it writes. */
  readonly digest: string;
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
  return { ok: true, file: { text, bom, eol: dominantEol(text), digest: digestOf(bytes) } };
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What init saw when it read: the digest of an existing file, or that there was no file. */
export type ExpectedState = { readonly digest: string } | { readonly absent: true };

/** The file was changed (or created, or removed) by someone else after init read it; nothing was written. */
export class ConfigChangedError extends Error {
  readonly code = 'config_changed_during_init';

  constructor(target: string) {
    super(`${target} changed while init was running`);
    this.name = 'ConfigChangedError';
  }
}

/** Re-read `target` and compare it with what init read; throws `ConfigChangedError` on any difference. */
async function assertUnchanged(target: string, expected: ExpectedState): Promise<void> {
  let current: string | null;
  try {
    current = digestOf(await readFile(target));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
    current = null;
  }
  const same = 'absent' in expected ? current === null : current === expected.digest;
  if (!same) {
    throw new ConfigChangedError(target);
  }
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
  /** What init read: the target must still be exactly that, before the backup and before the rename. */
  readonly expected: ExpectedState;
  /** TEST ONLY: runs after the temp file is written and before the second compare. */
  readonly afterTemp?: (file: string) => void | Promise<void>;
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
 * removed on any failure. The target is compared with `options.expected` before the backup and again
 * just before the rename; on a difference nothing is written, the temp file is removed and
 * `ConfigChangedError` is thrown. A difference at the first compare makes no backup; a difference at
 * the second leaves the backup the call made, which holds the file as init read it.
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

  await assertUnchanged(target, options.expected); // first compare: the backup below copies the bytes init rendered from

  let backupCreated = false;
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (exists) {
    try {
      await copyFile(target, backup, constants.COPYFILE_EXCL);
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
    await options.afterTemp?.(target);
    await assertUnchanged(target, options.expected); // second compare, immediately before the rename
    await rename(temp, target);
  } catch (error) {
    // A backup made earlier in this call stays: it is a copy of the file as init read it (the first compare
    // ran just before the copy), and removing it would race with a concurrent init that relies on it.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { path: target, backupCreated };
}
