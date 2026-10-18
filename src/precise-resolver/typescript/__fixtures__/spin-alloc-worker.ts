/**
 * TEST FIXTURE (plan 03-27): a process whose main thread never yields. It starts the RSS sampler the compiler worker uses,
 * then allocates in a synchronous loop that no timer or message can interrupt. Only a thread of its own can end it.
 *
 * It runs as the exact compiler worker shape (Node, a heap flag, this file, `GSD_ATLAS_WORKER=1`), so a test starts it
 * through the CommandRunner. The limit and the period arrive on stdin as one line, `<rssLimitMb> <sampleMs>`. It prints
 * `spinning <pid>` on stdout once the sampler runs, so the test can time the kill from that line. Nothing in the shipped
 * package imports this file.
 */
import { startSampler } from '../sampler.ts';

process.stdin.setEncoding('utf8');
process.stdin.once('data', (chunk: string) => {
  const [limit, period] = chunk.trim().split(/\s+/).map(Number);
  if (limit === undefined || period === undefined || !Number.isInteger(limit) || !Number.isInteger(period)) {
    process.stderr.write('usage: send "<rssLimitMb> <sampleMs>" on stdin\n');
    process.exit(2);
  }
  startSampler({ rssLimitMb: limit, sampleMs: period });
  process.stdout.write(`spinning ${String(process.pid)}\n`);

  const kept: Buffer[] = [];
  for (;;) {
    // Four megabytes of touched pages per turn; the loop ends only when the process does.
    kept.push(Buffer.alloc(4 * 1024 * 1024, 1));
  }
});
