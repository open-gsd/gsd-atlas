// A stand-in for the compiler worker, used only by command-runner tests (plan 03-19).
//
// Reads newline-delimited text on stdin, writes each line upper-cased, and exits 0 when stdin ends.
// Dependency free and plain JavaScript run by Node itself: no shim, no shell.
//
// Optional modes, switched on by environment variables (the test shapes list them):
//   ECHO_PRINT_PID=1     first output line is `PID <pid>`
//   ECHO_PRINT_ENV=1     next output line is `ENV <JSON array of the environment key names, sorted>`
//   ECHO_BURST_MB=<n>    writes n MiB of `b` bytes (no newline) before it starts echoing
//   ECHO_STDERR_MB=<n>   writes n MiB of `e` bytes to stderr before it starts echoing
import { createInterface } from 'node:readline';

const MIB = 1024 * 1024;

function write(stream, data) {
  return new Promise((resolve) => {
    // A parent that went away or killed us mid-write is not an error worth reporting.
    if (stream.write(data, () => resolve())) resolve();
  });
}

async function burst(stream, megabytes, fill) {
  const block = Buffer.alloc(MIB, fill);
  for (let i = 0; i < megabytes; i += 1) await write(stream, block);
}

process.stdout.on('error', () => process.exit(0));
process.stderr.on('error', () => {});

if (process.env.ECHO_PRINT_PID === '1') await write(process.stdout, `PID ${String(process.pid)}\n`);
if (process.env.ECHO_PRINT_ENV === '1') {
  await write(process.stdout, `ENV ${JSON.stringify(Object.keys(process.env).sort())}\n`);
}
const stderrMb = Number(process.env.ECHO_STDERR_MB ?? '0');
if (stderrMb > 0) await burst(process.stderr, stderrMb, 'e');
const burstMb = Number(process.env.ECHO_BURST_MB ?? '0');
if (burstMb > 0) await burst(process.stdout, burstMb, 'b');

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  process.stdout.write(`${line.toUpperCase()}\n`);
});
// When stdin ends the interface closes, nothing keeps the event loop alive, and the process exits 0 by itself
// once stdout has drained (no process.exit, which could cut a pending write short).
