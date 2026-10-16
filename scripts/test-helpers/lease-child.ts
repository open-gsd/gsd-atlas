/**
 * Child process of the lease tests (plan 02-12). Usage: `node lease-child.ts <store dir> [race]`.
 *
 * Without `race`: takes the lease and prints `held` or `follower`. With `race`: prints `ready`, waits for one
 * line on stdin, takes the lease and prints `leader` or `follower`, so a test can release two children at the
 * same moment. Either way the child then stays alive (holding the lease) until it is killed.
 *
 * This file is test support: it lives outside `src` so it is not built, and it is not named `*.test.ts` so the
 * test runner does not pick it up.
 */
import { systemClock } from '../../src/facts/index.ts';
import { createLease } from '../../src/fact-store/lease.ts';

const dir = process.argv[2];
const race = process.argv[3] === 'race';
if (dir === undefined) throw new Error('usage: lease-child.ts <store dir> [race]');

async function waitForLine(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk;
    if (buffered.includes('\n')) return;
  }
}

if (race) {
  process.stdout.write('ready\n');
  await waitForLine();
}

const lease = createLease({ dir, clock: systemClock, version: 'child' });
const held = await lease.tryAcquire();
process.stdout.write(`${held ? (race ? 'leader' : 'held') : 'follower'}\n`);

// Stay alive while holding the lease; the parent ends this process with SIGKILL.
setInterval(() => {}, 1000);
