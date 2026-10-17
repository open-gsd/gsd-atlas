import process from 'node:process';
import { Writable } from 'node:stream';

const realStdout = process.stdout;
const realWrite = realStdout.write.bind(realStdout);

export const protocolStdout: Writable = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    realWrite(chunk, callback);
  },
});

/** Skeleton for the RED commit: installs nothing. */
export function installStdoutGuard(): void {}
