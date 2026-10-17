/**
 * WR-03 (plan 02-31): a takeover recovery or a `check` rebuild that fails while it replaces the database
 * connections never leaves the store half open. After the failure the store is usable (valid connections on a
 * file that opens, honest about being a follower or the leader) or closed (`StoreClosed`, lease released), and a
 * process that cannot write never reports leadership. Real SQLite in a temp directory, failures injected with the
 * TEST ONLY `beforeReplaceOpen` option, a fake clock for the takeover timer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pollUntil } from '../../scripts/test-helpers/child-lines.ts';
import { generatedFacts, generatedHash, generatedPath } from '../../scripts/test-helpers/store-facts.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { StoreClosed, UnknownWorktree } from './errors.ts';
import { DEFAULT_LEASE_RETRY_MAX_MS, DEFAULT_LEASE_RETRY_MIN_MS, openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import { QUARANTINE_MARK, markDirty } from './recovery.ts';
import { STORE_FILE_NAME } from './schema.ts';
import type { FactStore, Resolver, StoreDeps } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

const PAGE = 4096;

type Stage = 'replace' | 'restore';

/** A fake clock that counts the timers still waiting, so a test can see a re-armed (or leaked) retry timer. */
class CountingClock extends FakeClock {
  active = 0;

  override after(ms: number, fn: () => void): () => void {
    this.active += 1;
    let live = true;
    const settle = (): void => {
      if (live) {
        live = false;
        this.active -= 1;
      }
    };
    const cancel = super.after(ms, () => {
      settle();
      fn();
    });
    return () => {
      settle();
      cancel();
    };
  }
}

interface Rig {
  readonly dir: string;
  readonly file: string;
  /** The clock of every store opened without its own. */
  readonly clock: FakeClock;
  open(extra?: Partial<StoreOpenOptions>, clock?: FakeClock): Promise<FactStore>;
}

async function withRig(driver: DriverName, run: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const opened: FactStore[] = [];
  const rig: Rig = {
    dir,
    file: path.join(dir, STORE_FILE_NAME),
    clock,
    async open(extra = {}, own = clock) {
      const deps: StoreDeps = { resolver: noResolver, clock: own, gitHas: async () => true };
      const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9', ...extra });
      opened.push(store);
      return store;
    },
  };
  try {
    await run(rig);
  } finally {
    for (const store of opened) await store.close();
    tmp.cleanup();
  }
}

async function seed(store: FactStore, count: number): Promise<void> {
  const writer = store.writer();
  for (let index = 0; index < count; index += 1) {
    await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash: generatedHash(index), facts: generatedFacts(index) });
  }
  writer.release();
}

function overwrite(file: string, start: number, length: number): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(length, 0xff), 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
}

function quarantined(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.includes(QUARANTINE_MARK) && !name.endsWith('-wal') && !name.endsWith('-shm'))
    .sort();
}

const takeoverRange = {
  retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS,
  retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS,
  random: () => 0,
};

/** The hook of a test: stages that must fail are listed in `failing`; every call is recorded. */
function injector(failing: Set<Stage>): { readonly calls: Stage[]; readonly hook: (stage: Stage) => void } {
  const calls: Stage[] = [];
  return {
    calls,
    hook(stage) {
      calls.push(stage);
      if (failing.has(stage)) throw new Error(`injected failure at ${stage}`);
    },
  };
}

/**
 * A leader `A` that wrote 30 files and died with the sentinel set and every page after the first overwritten, and a
 * follower `B` (own counting clock) that was opened while `A` held the lease. Resolves with `B`.
 */
async function followerOfDeadLeader(
  rig: Rig,
  driver: DriverName,
  extra: Partial<StoreOpenOptions>,
  bClock: CountingClock,
): Promise<FactStore> {
  const leader = await rig.open({ lease: 'acquire' });
  await seed(leader, 30);
  const follower = await rig.open({ lease: 'acquire', takeover: takeoverRange, ...extra }, bClock);
  // With the follower's connections open the leader is not the last to close, so its facts would stay in the WAL.
  // Fold them into the main file first, so the damage below lands where the check will look.
  const folder = await openDatabase(rig.file, { driver });
  try {
    folder.pragma('wal_checkpoint', 'TRUNCATE');
  } finally {
    folder.close();
  }
  await leader.close();
  assert.ok(fs.statSync(rig.file).size > 2 * PAGE, 'the facts are in the main file');
  overwrite(rig.file, PAGE, fs.statSync(rig.file).size - PAGE);
  markDirty(rig.dir); // what a killed leader leaves behind
  return follower;
}

async function isClosed(store: FactStore): Promise<boolean> {
  try {
    await store.status();
    return false;
  } catch (error) {
    return error instanceof StoreClosed;
  }
}

const settle = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

for (const driver of ['node:sqlite', 'better-sqlite3'] as const) {
  describe(`takeover recovery that fails (${driver})`, () => {
    it('replace fails: the follower stays a follower with working reads, the lease is free, and it did not report leadership', async () => {
      await withRig(driver, async (rig) => {
        const changes: boolean[] = [];
        const injected = injector(new Set<Stage>(['replace']));
        const bClock = new CountingClock(1000);
        const follower = await followerOfDeadLeader(
          rig,
          driver,
          { onLeaseChange: (held) => changes.push(held), beforeReplaceOpen: injected.hook },
          bClock,
        );

        await bClock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
        await pollUntil(10_000, 'the failed recovery and the re-armed takeover', () => injected.calls.length > 0 && bClock.active === 1);

        assert.deepStrictEqual(injected.calls, ['replace', 'restore'], 'the failed replacement was followed by the restore');
        assert.deepStrictEqual(changes, [], 'leadership was never reported');
        const status = await follower.status();
        assert.equal(status.writerLeaseHeld, false);
        assert.ok(status.rebuiltAfterCorruption !== undefined, 'the moved-aside note survived the failure');
        assert.equal(fs.existsSync(status.rebuiltAfterCorruption.movedTo), true);
        assert.equal(quarantined(rig.dir).length, 1);
        await assert.rejects(follower.at('main').find('sym0'), UnknownWorktree, 'reads work: the connections are valid');

        // The lease is free: another process takes it at once.
        const other = await rig.open({ lease: 'acquire' });
        assert.equal((await other.status()).writerLeaseHeld, true);
        await other.close();
      });
    });

    it('retry: the re-armed takeover succeeds and onLeaseChange(true) fires exactly once', async () => {
      await withRig(driver, async (rig) => {
        const changes: boolean[] = [];
        const failing = new Set<Stage>(['replace']);
        const injected = injector(failing);
        const bClock = new CountingClock(1000);
        const follower = await followerOfDeadLeader(
          rig,
          driver,
          { onLeaseChange: (held) => changes.push(held), beforeReplaceOpen: injected.hook },
          bClock,
        );
        await bClock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
        await pollUntil(10_000, 'the failed recovery and the re-armed takeover', () => injected.calls.length > 0 && bClock.active === 1);
        assert.deepStrictEqual(changes, []);

        failing.clear();
        await bClock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
        await pollUntil(10_000, 'the second takeover', () => changes.length > 0);
        await settle(100);
        assert.deepStrictEqual(changes, [true], 'exactly once');

        assert.equal((await follower.status()).writerLeaseHeld, true);
        assert.deepStrictEqual(await follower.check(), { ok: true, problems: [] });
        const writer = follower.writer();
        await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        const found = await follower.at('main').find('sym0');
        assert.equal(found.degraded?.includes('rebuilding'), true, 'the restored store carries the rebuilding note');
        assert.equal(found.degraded?.includes('follower') ?? false, false);
        writer.release();
      });
    });

    it('restore also fails: the store is closed, the lease is free and leadership was never reported', async () => {
      await withRig(driver, async (rig) => {
        const changes: boolean[] = [];
        const injected = injector(new Set<Stage>(['replace', 'restore']));
        const bClock = new CountingClock(1000);
        const follower = await followerOfDeadLeader(
          rig,
          driver,
          { onLeaseChange: (held) => changes.push(held), beforeReplaceOpen: injected.hook },
          bClock,
        );

        await bClock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
        await pollUntil(10_000, 'the store to close', () => isClosed(follower));

        assert.deepStrictEqual(injected.calls, ['replace', 'restore']);
        assert.deepStrictEqual(changes, [], 'leadership was never reported, so it is not given up either');
        assert.throws(() => follower.writer(), StoreClosed);
        await assert.rejects(follower.check(), StoreClosed);
        await assert.rejects(async () => follower.at('main').find('sym0'), StoreClosed);
        assert.equal(bClock.active, 0, 'a closed store does not retry');

        const other = await rig.open({ lease: 'acquire' });
        assert.equal((await other.status()).writerLeaseHeld, true, 'the lease is free');
      });
    });
  });
}

describe('takeover recovery and close', () => {
  it('close during recovery: no timer is re-armed, no leadership is reported and no connection is restored', async () => {
    await withRig('node:sqlite', async (rig) => {
      const changes: boolean[] = [];
      let entered = false;
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const bClock = new CountingClock(1000);
      const follower = await followerOfDeadLeader(
        rig,
        'node:sqlite',
        {
          onLeaseChange: (held) => changes.push(held),
          async beforeReplaceOpen() {
            entered = true;
            await gate;
          },
        },
        bClock,
      );

      await bClock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
      await pollUntil(10_000, 'the recovery to start', () => entered);
      await follower.close();
      open(); // the recovery goes on after the close
      await settle(150);

      assert.deepStrictEqual(changes.includes(true), false, 'a closed store reports no leadership');
      assert.equal(bClock.active, 0, 'a closed store does not re-arm the takeover');
      await assert.rejects(follower.status(), StoreClosed);
      const other = await rig.open({ lease: 'acquire' });
      assert.equal((await other.status()).writerLeaseHeld, true, 'the lease is free');
    });
  });
});

/**
 * A store directory whose `refs` root page is overwritten: the store still opens (neither the open nor `status`
 * reads that page), and only a `check` can find the damage.
 */
async function damagedStoreDir(rig: Rig, driver: DriverName): Promise<void> {
  const first = await rig.open({ lease: 'acquire' });
  await seed(first, 30);
  await first.close(); // the last connection folds the log into the main file
  const probe = await openDatabase(rig.file, { readOnly: true, driver });
  let root: number;
  try {
    root = Number(probe.prepare("SELECT rootpage AS n FROM sqlite_master WHERE name = 'refs'").get()?.n);
  } finally {
    probe.close();
  }
  assert.ok(root > 1);
  overwrite(rig.file, (root - 1) * PAGE, PAGE);
}

for (const driver of ['node:sqlite', 'better-sqlite3'] as const) {
  describe(`check whose rebuild fails (${driver})`, () => {
    it('check rebuild fails: the problems end with a rebuild failed line, and the restored store is usable', async () => {
      await withRig(driver, async (rig) => {
        await damagedStoreDir(rig, driver);
        const failing = new Set<Stage>(['replace']);
        const injected = injector(failing);
        const changes: boolean[] = [];
        const store = await rig.open({
          lease: 'acquire',
          beforeReplaceOpen: injected.hook,
          onLeaseChange: (held) => changes.push(held),
        });

        const result = await store.check(); // resolves: it does not reject out of the maintenance request
        assert.equal(result.ok, false);
        assert.ok(result.problems.length >= 2, 'the quick_check lines and the rebuild line');
        const last = result.problems[result.problems.length - 1] ?? '';
        assert.match(last, /^rebuild failed:/);
        assert.match(last, /injected failure at replace/);
        assert.deepStrictEqual(injected.calls, ['replace', 'restore']);

        // The store is usable: valid connections, still the leader, the moved-aside file kept.
        const status = await store.status();
        assert.equal(status.writerLeaseHeld, true);
        assert.ok(status.rebuiltAfterCorruption !== undefined);
        assert.equal(fs.existsSync(status.rebuiltAfterCorruption.movedTo), true);
        assert.equal(quarantined(rig.dir).length, 1);
        assert.deepStrictEqual(changes, []);
        await assert.rejects(store.at('main').find('sym0'), UnknownWorktree);

        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        const found = await store.at('main').find('sym0');
        assert.equal(found.degraded?.includes('rebuilding'), true, 'the restored store carries the rebuilding note');
        writer.release();
        assert.deepStrictEqual(await store.check(), { ok: true, problems: [] }, 'a later check on the restored store is ok');
      });
    });

    it('check rebuild and restore fail: check still resolves, the store is closed and the lease is free', async () => {
      await withRig(driver, async (rig) => {
        await damagedStoreDir(rig, driver);
        const injected = injector(new Set<Stage>(['replace', 'restore']));
        const changes: boolean[] = [];
        const store = await rig.open({
          lease: 'acquire',
          beforeReplaceOpen: injected.hook,
          onLeaseChange: (held) => changes.push(held),
        });

        const result = await store.check();
        assert.equal(result.ok, false);
        assert.match(result.problems[result.problems.length - 1] ?? '', /^rebuild failed:/);
        assert.deepStrictEqual(injected.calls, ['replace', 'restore']);

        await assert.rejects(store.status(), StoreClosed);
        assert.throws(() => store.writer(), StoreClosed);
        await assert.rejects(store.check(), StoreClosed);
        assert.deepStrictEqual(changes, [false], 'the leader that had reported leadership gives it up');

        const other = await rig.open({ lease: 'acquire' });
        assert.equal((await other.status()).writerLeaseHeld, true, 'the lease is free');
      });
    });
  });
}

describe('check on a healthy store', () => {
  it('is unchanged: ok, no problems, and the rebuild hook is never reached', async () => {
    await withRig('node:sqlite', async (rig) => {
      const injected = injector(new Set<Stage>(['replace', 'restore']));
      const store = await rig.open({ lease: 'acquire', beforeReplaceOpen: injected.hook });
      await seed(store, 3);
      assert.deepStrictEqual(await store.check(), { ok: true, problems: [] });
      assert.deepStrictEqual(injected.calls, []);
    });
  });
});
