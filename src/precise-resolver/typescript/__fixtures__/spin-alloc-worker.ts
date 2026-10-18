/**
 * TEST FIXTURE (plan 03-27): a process whose main thread never yields. It starts the RSS sampler the compiler worker uses,
 * then allocates in a synchronous loop that no timer or message can interrupt. Only a thread of its own can end it.
 *
 * `node spin-alloc-worker.ts <rssLimitMb> <sampleMs>`. It prints `spinning` on stdout once the sampler runs, so the test can
 * time the kill from that line. Nothing in the shipped package imports this file.
 */
import { startSampler } from '../sampler.ts';

const limitMb = Number(process.argv[2]);
const sampleMs = Number(process.argv[3]);
if (!Number.isInteger(limitMb) || !Number.isInteger(sampleMs)) {
  process.stderr.write('usage: spin-alloc-worker <rssLimitMb> <sampleMs>\n');
  process.exit(2);
}

startSampler({ rssLimitMb: limitMb, sampleMs });
process.stdout.write('spinning\n');

const kept: Buffer[] = [];
for (;;) {
  // Four megabytes of touched pages per turn; the loop ends only when the process does.
  kept.push(Buffer.alloc(4 * 1024 * 1024, 1));
}
