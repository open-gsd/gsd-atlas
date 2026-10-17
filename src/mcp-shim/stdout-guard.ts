/**
 * The protocol channel (HST-01, research Pitfall 8, T-02-79). On stdio the MCP transport and the process's stdout are
 * the same pipe, so one stray write from any library corrupts or forges a protocol frame. This module is the first
 * code the MCP bin evaluates. At load it:
 *
 * 1. captures the process's real stdout write function and keeps it private, handing it only to `protocolStdout`,
 *    the one stream the transport writes to; and
 * 2. replaces `process.stdout.write` with a function that forwards to stderr, so a direct write
 *    from any library, and the global logging functions that print through it, land on stderr.
 *
 * Importing this module changes the process it is imported into. Unit tests must not import it in the test runner's
 * own process (its stdout carries the runner's report); scripts/test-helpers/stdout-noise-child.ts loads it in a
 * child instead.
 */
import process from 'node:process';
import { Writable } from 'node:stream';

type WriteFunction = typeof process.stdout.write;

/**
 * Where the real write is kept when a second copy of this module is loaded into one process (a duplicated install):
 * the second copy must find the original, not the redirect the first one installed.
 */
const REAL_WRITE = Symbol.for('gsd-atlas.mcp.real-stdout-write');
const registry = globalThis as unknown as { [REAL_WRITE]?: WriteFunction };

const realStdout = process.stdout;
const realWrite: WriteFunction = (registry[REAL_WRITE] ??= realStdout.write.bind(realStdout));

/** A Writable over the captured real stdout write; backpressure travels through the write callback. */
export const protocolStdout: Writable = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    realWrite(chunk, callback);
  },
});

type Done = (error?: Error | null) => void;

/** `stdout.write` with the arguments stdout.write accepts, answered by stderr. */
function toStderr(chunk: string | Uint8Array, encodingOrDone?: BufferEncoding | Done, done?: Done): boolean {
  return typeof encodingOrDone === 'function'
    ? process.stderr.write(chunk, encodingOrDone)
    : process.stderr.write(chunk, encodingOrDone, done);
}

let installed = false;

/** Redirect every write to `process.stdout` (and so the global logging functions) to stderr. Idempotent: it never nests. */
export function installStdoutGuard(): void {
  if (installed) return;
  installed = true;
  realStdout.write = toStderr as WriteFunction;
}

installStdoutGuard();
