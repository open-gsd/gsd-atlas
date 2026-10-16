/**
 * Child process of the durability tests (plan 02-12).
 *
 *   node store-writer-child.ts write <store dir> [node:sqlite|better-sqlite3]
 *     Opens the store with the writer lease and commits one generated file per loop iteration for as long as it
 *     lives, printing `committed N seq S` after each commit (N files so far, S the watermark). A test kills it
 *     with SIGKILL at a chosen moment. Prints `follower` and exits if another process holds the lease.
 *
 *   node store-writer-child.ts resolve <common dir> <repo dir> <cache root> <store id>
 *     Prints `ready`, waits for one line on stdin, resolves the store location and prints `<kind> <dir>`, so a
 *     test can race the parent's own resolution against it.
 *
 * Test support: it lives outside `src` so it is not built, and it is not named `*.test.ts`.
 */
import { openFactStore, resolveStoreLocation } from '../../src/fact-store/index.ts';
import type { Resolver } from '../../src/fact-store/index.ts';
import { systemClock } from '../../src/facts/index.ts';
import { generatedFacts, generatedHash, generatedPath } from './store-facts.ts';

const [mode, ...args] = process.argv.slice(2);

const noResolver: Resolver = async function* () {
  // this child has no precise resolver
};

async function write(dir: string, driver: string | undefined): Promise<void> {
  const store = await openFactStore(
    dir,
    { resolver: noResolver, clock: systemClock, gitHas: async () => true },
    { lease: 'acquire', repo: 'repo', version: 'child', driver: driver === 'better-sqlite3' ? 'better-sqlite3' : 'node:sqlite' },
  );
  if (!(await store.status()).writerLeaseHeld) {
    process.stdout.write('follower\n');
    await store.close();
    return;
  }
  const writer = store.writer();
  for (let index = 0; ; index += 1) {
    const result = await writer.commitFile({
      worktree: 'main',
      path: generatedPath(index),
      hash: generatedHash(index),
      facts: generatedFacts(index),
    });
    process.stdout.write(`committed ${index + 1} seq ${result.seq}\n`);
    // Let the line leave before the next commit, so a kill lands between acknowledgements as often as inside one.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function waitForLine(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk;
    if (buffered.includes('\n')) return;
  }
}

async function resolve(commonDir: string, repoDir: string, cacheRoot: string, storeId: string): Promise<void> {
  process.stdout.write('ready\n');
  await waitForLine();
  const location = resolveStoreLocation({ storeId, commonDir, repoDir, cacheRoot, env: {} });
  process.stdout.write(`${location.kind} ${location.dir}\n`);
}

if (mode === 'write' && args[0] !== undefined) {
  await write(args[0], args[1]);
} else if (mode === 'resolve' && args.length === 4) {
  await resolve(args[0] as string, args[1] as string, args[2] as string, args[3] as string);
} else {
  throw new Error('usage: store-writer-child.ts write <dir> [driver] | resolve <common> <repo> <cache> <id>');
}
