/**
 * The holder of the writer lease in the store status (WR-02 input, plan 02-30). A leader reports itself, a follower
 * reports what `lease.json` says about the leader, and a store with no lease reports nothing. Real `lease.db` in a
 * short temp directory and a fake clock; both stores are closed before the directory is removed (Windows keeps open
 * files locked).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { resetLifecycleTestHooks } from './lifecycle.ts';
import { openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import type { FactStore, Resolver, StoreDeps } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

afterEach(() => {
  resetLifecycleTestHooks();
});

async function withStores(
  driver: DriverName,
  run: (open: (extra: Partial<StoreOpenOptions>) => Promise<FactStore>, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const opened: FactStore[] = [];
  const open = async (extra: Partial<StoreOpenOptions>): Promise<FactStore> => {
    const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async () => true };
    const store = await openFactStore(dir, deps, { driver, repo: 'repo', ...extra });
    opened.push(store);
    return store;
  };
  try {
    await run(open, clock);
  } finally {
    for (const store of opened) await store.close();
    tmp.cleanup();
  }
}

for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
  describe(`lease holder in the status (${driver})`, () => {
    it('leader: reports this process with the time it took the lease and its own version', async () => {
      await withStores(driver, async (open) => {
        const leader = await open({ lease: 'acquire', version: '9.9.9' });
        const status = await leader.status();
        assert.equal(status.writerLeaseHeld, true);
        assert.deepStrictEqual(status.leaseHolder, { pid: process.pid, startedAt: 1000, version: '9.9.9' });
      });
    });

    it('follower: reports the leader from lease.json, and nothing once the leader has gone', async () => {
      await withStores(driver, async (open) => {
        const leader = await open({ lease: 'acquire', version: '9.9.9' });
        const follower = await open({ lease: 'acquire', version: '8.8.8' });
        const status = await follower.status();
        assert.equal(status.writerLeaseHeld, false);
        assert.deepStrictEqual(status.leaseHolder, { pid: process.pid, startedAt: 1000, version: '9.9.9' }, "the leader's version, not the follower's");

        await leader.close();
        assert.equal((await follower.status()).leaseHolder, undefined, 'no lease.json, no holder to name');
      });
    });

    it('no lease: a store opened without a lease has no leaseHolder field and keeps its other status fields', async () => {
      await withStores(driver, async (open) => {
        const store = await open({ version: '9.9.9' });
        const status = await store.status();
        assert.equal('leaseHolder' in status, false);
        assert.deepStrictEqual(
          { schemaVersion: status.schemaVersion, worktrees: status.worktrees, writerLeaseHeld: status.writerLeaseHeld },
          { schemaVersion: 2, worktrees: [], writerLeaseHeld: false },
        );
      });
    });
  });
}
