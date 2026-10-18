/**
 * The file-system calls the diagnostics module makes, in one place. Every read and write takes them as a parameter, so a
 * test can hand in a recording wrapper and prove which paths were touched (acceptance test 5: no repository file is
 * ever opened), and make one of them fail.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DiagnosticsFs = Pick<
  typeof fs,
  | 'mkdirSync'
  | 'openSync'
  | 'readSync'
  | 'writeFileSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'realpathSync'
  | 'readdirSync'
  | 'rmSync'
  | 'statSync'
>;

export type BoundedRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * Read `file` through a buffer of at most `maxBytes` plus one byte, so a huge file is never loaded whole. The reasons
 * are fixed words: they never quote the file.
 */
export function readBounded(io: DiagnosticsFs, file: string, maxBytes: number): BoundedRead {
  let fd: number;
  try {
    fd = io.openSync(file, 'r');
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'refused', why: 'it could not be opened' };
  }
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const read = io.readSync(fd, buffer, 0, buffer.length, 0);
    if (read > maxBytes) return { kind: 'refused', why: `it is larger than ${String(Math.floor(maxBytes / 1024))} KiB` };
    return { kind: 'ok', text: buffer.subarray(0, read).toString('utf8') };
  } catch {
    return { kind: 'refused', why: 'it could not be read' };
  } finally {
    io.closeSync(fd);
  }
}

export const sameRead = (a: BoundedRead, b: BoundedRead): boolean =>
  a.kind === b.kind && (a.kind !== 'ok' || (b.kind === 'ok' && a.text === b.text));

/** The file a link points at (a dotfile manager's), else the path itself. */
export function targetOf(link: string, io: DiagnosticsFs): string {
  try {
    return io.realpathSync(link);
  } catch {
    return link;
  }
}

export type WriteFailure = 'changed' | 'failed';

/**
 * Write `text` to `file` the safe way: a temporary file in the same folder (mode 0600, flushed), then a rename over the
 * target, so a crash or a failure leaves the old file whole. `unchanged` is called just before the rename and must say
 * whether the target still holds what the caller based its text on; if not, the other writer wins and nothing of ours
 * replaces it. The temporary file is removed on every failure.
 */
export function writeFileAtomic(
  io: DiagnosticsFs,
  file: string,
  text: string,
  unchanged: () => boolean,
): { readonly ok: true } | { readonly ok: false; readonly failure: WriteFailure } {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${path.basename(file)}.${String(process.pid)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = io.openSync(temporary, 'wx', 0o600);
    try {
      io.writeFileSync(fd, text);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    if (!unchanged()) return { ok: false, failure: 'changed' };
    io.renameSync(temporary, file);
    renamed = true;
    return { ok: true };
  } catch {
    return { ok: false, failure: 'failed' };
  } finally {
    if (!renamed) {
      try {
        io.unlinkSync(temporary);
      } catch {
        // Nothing to remove: it was never created, or it is already gone.
      }
    }
  }
}
