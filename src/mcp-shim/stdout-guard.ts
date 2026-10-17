/**
 * The protocol channel (HST-01, research Pitfall 8). At import this captures the process's real stdout write
 * function and exposes it as `protocolStdout`, the only stream the MCP transport writes to. Task 2 of plan 02-23 adds
 * the redirect of every other write.
 */
import process from 'node:process';
import { Writable } from 'node:stream';

const realStdout = process.stdout;
const realWrite = realStdout.write.bind(realStdout);

/** A Writable over the captured real stdout write; backpressure travels through the write callback. */
export const protocolStdout: Writable = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    realWrite(chunk, callback);
  },
});
