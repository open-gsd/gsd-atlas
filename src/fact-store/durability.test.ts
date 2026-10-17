/**
 * Durability and recovery of the Fact Store (STO-06, D-14, D-15, plan 02-12): the dirty sentinel, `quick_check`
 * on open, quarantine and rebuild, the schema-version policy, and two proofs against real damage: a writer
 * process killed with SIGKILL at several points, and database pages overwritten on disk.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lineReader, pollUntil, within } from '../../scripts/test-helpers/child-lines.ts';
import {
  IMPORTS_PER_FILE,
  REFS_PER_FILE,
  SYMBOLS_PER_FILE,
  generatedFacts,
  generatedHash,
  generatedPath,
} from '../../scripts/test-helpers/store-facts.ts';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { SchemaTooNew, UnknownWorktree } from './errors.ts';
import { resolveStoreLocation } from './location.ts';
import { DEFAULT_DIRTY_IDLE_MS, DEFAULT_LEASE_RETRY_MAX_MS, DEFAULT_LEASE_RETRY_MIN_MS, openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import {
  QUARANTINE_MARK,
  clearDirty,
  dirtyMarkerPath,
  isDirty,
  markDirty,
  pruneQuarantine,
  quarantine,
  recoveryCounters,
  resetRecoveryCounters,
} from './recovery.ts';
import { SCHEMA_VERSION, STORE_FILE_NAME } from './schema.ts';
import type { FactStore, Resolver, StoreDeps } from './types.ts';

const CHILD = fileURLToPath(new URL('../../scripts/test-helpers/store-writer-child.ts', import.meta.url));
const runner = createRealRunner({ decide: allowAll });

/** Test-only ceiling on how long a child may take to boot or to acknowledge a commit. */
const CHILD_CEILING_MS = 20_000;

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

// IN-08: a counter one test moved must not be seen by the next one.
afterEach(() => {
  resetRecoveryCounters();
});

interface Rig {
  readonly clock: FakeClock;
  readonly dir: string;
  readonly file: string;
  open(extra?: Partial<StoreOpenOptions>): Promise<FactStore>;
}

async function withRig(driver: DriverName, run: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const opened: FactStore[] = [];
  const rig: Rig = {
    clock,
    dir,
    file: path.join(dir, STORE_FILE_NAME),
    async open(extra = {}) {
      const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async () => true };
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

/** Commit generated files `0` to `count - 1` into worktree `main`. */
async function seed(store: FactStore, count: number): Promise<void> {
  const writer = store.writer();
  for (let index = 0; index < count; index += 1) {
    await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash: generatedHash(index), facts: generatedFacts(index) });
  }
  writer.release();
}

/** The names in `dir` that are moved-aside database files, without their `-wal` and `-shm` companions. */
function quarantined(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.includes(QUARANTINE_MARK) && !name.endsWith('-wal') && !name.endsWith('-shm'))
    .sort();
}

function overwrite(file: string, start: number, length: number): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(length, 0xff), 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
}

for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
  describe(`dirty sentinel (${driver})`, () => {
    it('the first write creates the sentinel, the approved idle time after the last write removes it, and a second write restarts the timer', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        assert.equal(isDirty(rig.dir), false, 'a store that has not written is clean');
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        assert.equal(isDirty(rig.dir), true);

        await rig.clock.advance(DEFAULT_DIRTY_IDLE_MS - 1);
        assert.equal(isDirty(rig.dir), true, 'still inside the quiet window');
        await writer.commitFile({ worktree: 'main', path: generatedPath(1), hash: generatedHash(1), facts: generatedFacts(1) });
        assert.equal(fs.readdirSync(rig.dir).filter((name) => name === 'dirty').length, 1, 'one sentinel, not two');
        await rig.clock.advance(DEFAULT_DIRTY_IDLE_MS - 1);
        assert.equal(isDirty(rig.dir), true, 'the second write restarted the window');
        await rig.clock.advance(1);
        assert.equal(isDirty(rig.dir), false, 'the window passed with no write');
        writer.release();
      });
    });

    it('release() removes the sentinel at once', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        assert.equal(isDirty(rig.dir), true);
        writer.release();
        assert.equal(isDirty(rig.dir), false);
      });
    });

    it('close() removes the sentinel at once, and cancels the timer', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.setOverlay('main', 'refs/heads/main', new Map());
        assert.equal(isDirty(rig.dir), true, 'every mutating writer call sets it');
        await store.close();
        assert.equal(isDirty(rig.dir), false);
        await rig.clock.advance(10 * DEFAULT_DIRTY_IDLE_MS); // a leftover timer would try to remove a file that is gone: it must not throw
      });
    });

    it('all five mutating writer calls set the sentinel', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const calls: Array<[string, () => Promise<unknown>]> = [
          ['commitFile', () => writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) })],
          ['link', () => writer.link('main', generatedPath(5), generatedHash(0))],
          ['setOverlay', () => writer.setOverlay('main', 'refs/heads/main', new Map([[generatedPath(0), generatedHash(0)]]))],
          ['markStale', () => writer.markStale({ module: 'typescript', grammarVersion: '0.0.0' })],
          ['dropOverlay', () => writer.dropOverlay('main')],
        ];
        for (const [name, call] of calls) {
          clearDirty(rig.dir);
          await call();
          assert.equal(isDirty(rig.dir), true, name);
        }
        writer.release();
      });
    });

    it('a store that only reads never creates the sentinel', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await seed(store, 2);
        assert.equal(isDirty(rig.dir), false, 'seed released its writer');
        await store.at('main').find('sym0');
        await store.status();
        await store.reconcile({ worktree: 'main', pathToHash: new Map() });
        assert.equal(isDirty(rig.dir), false);
      });
    });
  });

  describe(`quick_check on open (${driver})`, () => {
    it('a sentinel beside a healthy database triggers one quick_check, which passes: the sentinel goes and every fact is intact', async () => {
      await withRig(driver, async (rig) => {
        let store = await rig.open();
        await seed(store, 5);
        await store.close();
        markDirty(rig.dir);

        const before = recoveryCounters.quickChecks;
        store = await rig.open();
        assert.equal(recoveryCounters.quickChecks, before + 1);
        assert.equal(isDirty(rig.dir), false);
        assert.equal((await store.status()).rebuiltAfterCorruption, undefined);
        assert.deepStrictEqual(quarantined(rig.dir), []);
        const found = await store.at('main').find('sym0');
        assert.equal(found.data.length, 5);
        assert.equal(found.degraded?.includes('rebuilding') ?? false, false);
      });
    });

    it('[edge STO-06/idempotency] with no sentinel the open runs no check', async () => {
      await withRig(driver, async (rig) => {
        let store = await rig.open();
        await seed(store, 2);
        await store.close();
        const before = recoveryCounters.quickChecks;
        store = await rig.open();
        assert.equal(recoveryCounters.quickChecks, before);
        await store.close();
      });
    });

    it('corrupt: overwritten pages fail the check, the file is moved aside and rebuilt, and reads say rebuilding until a full overlay is written again', async () => {
      await withRig(driver, async (rig) => {
        let store = await rig.open();
        await seed(store, 30);
        await store.close();

        overwrite(rig.file, 4096, 4096);
        markDirty(rig.dir);
        // The fixture must really be damaged, or the test proves nothing.
        const damaged = await openDatabase(rig.file, { readOnly: true, driver });
        let verdict: unknown;
        try {
          verdict = damaged.pragma('quick_check');
        } catch {
          verdict = 'threw';
        } finally {
          damaged.close();
        }
        assert.notEqual(verdict, 'ok', 'the overwritten range must fail quick_check');

        await rig.clock.advance(5000);
        const checksBefore = recoveryCounters.quickChecks;
        store = await rig.open();
        assert.equal(recoveryCounters.quickChecks, checksBefore + 1);

        const status = await store.status();
        assert.ok(status.rebuiltAfterCorruption !== undefined, 'status reports the rebuild');
        const { movedTo, at } = status.rebuiltAfterCorruption;
        assert.match(path.basename(movedTo), /^facts\.db\.corrupt-/);
        assert.equal(fs.existsSync(movedTo), true, 'the damaged file is kept as evidence');
        assert.equal(at, 6000, 'the time comes from the Clock');
        assert.deepStrictEqual(status.worktrees, []);
        assert.equal(isDirty(rig.dir), false);
        await assert.rejects(store.at('main').find('sym0'), UnknownWorktree);

        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        const during = await store.at('main').find('sym0');
        assert.equal(during.degraded?.includes('rebuilding'), true, 'rebuilding until a full overlay has been written');
        await writer.setOverlay('main', 'refs/heads/main', new Map([[generatedPath(0), generatedHash(0)]]));
        const after = await store.at('main').find('sym0');
        assert.equal(after.data.length, 1);
        assert.equal(after.degraded?.includes('rebuilding') ?? false, false, 'the first completed setOverlay ends it');
        writer.release();
        await store.close();

        // Reopening a store that was just rebuilt: no sentinel, no check, no second quarantine file, the same data.
        const listing = quarantined(rig.dir);
        assert.equal(listing.length, 1);
        const checksNow = recoveryCounters.quickChecks;
        store = await rig.open();
        assert.equal(recoveryCounters.quickChecks, checksNow);
        assert.deepStrictEqual(quarantined(rig.dir), listing);
        const again = await store.at('main').find('sym0');
        assert.deepStrictEqual(again.data, after.data);
        assert.deepStrictEqual((await store.status()).rebuiltAfterCorruption, status.rebuiltAfterCorruption);
      });
    });

    it('not a database: random text in facts.db is moved aside and replaced even with no sentinel', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await store.close();
        const text = 'this is not a database, it is only text\n'.repeat(400);
        fs.writeFileSync(rig.file, text);
        const checksBefore = recoveryCounters.quickChecks;

        const rebuilt = await rig.open();
        const status = await rebuilt.status();
        assert.ok(status.rebuiltAfterCorruption !== undefined);
        assert.equal(fs.readFileSync(status.rebuiltAfterCorruption.movedTo, 'utf8'), text, 'the original bytes are kept');
        assert.equal(recoveryCounters.quickChecks, checksBefore, 'the open failed before any check could run');
        assert.deepStrictEqual(status.worktrees, []);
        assert.equal(status.schemaVersion, SCHEMA_VERSION);
      });
    });

    it('not a database: a tiny text file is handled the same way', async () => {
      await withRig(driver, async (rig) => {
        fs.mkdirSync(rig.dir, { recursive: true });
        fs.writeFileSync(rig.file, 'nope');
        const store = await rig.open();
        const status = await store.status();
        assert.equal(fs.readFileSync(status.rebuiltAfterCorruption?.movedTo ?? '', 'utf8'), 'nope');
      });
    });

    it('not a database: a valid SQLite file that is not a fact store is moved aside, never deleted', async () => {
      await withRig(driver, async (rig) => {
        fs.mkdirSync(rig.dir, { recursive: true });
        const foreign = await openDatabase(rig.file, { driver });
        foreign.exec('CREATE TABLE somebody_elses_data (x INTEGER); INSERT INTO somebody_elses_data VALUES (42)');
        foreign.close();
        const store = await rig.open();
        const moved = (await store.status()).rebuiltAfterCorruption?.movedTo ?? '';
        const kept = await openDatabase(moved, { readOnly: true, driver });
        try {
          assert.equal(kept.prepare('SELECT x FROM somebody_elses_data').get()?.x, 42);
        } finally {
          kept.close();
        }
      });
    });

    it('with three corruptions in a row only the two newest moved-aside files remain', async () => {
      await withRig(driver, async (rig) => {
        for (const round of [1, 2, 3]) {
          fs.mkdirSync(rig.dir, { recursive: true });
          fs.writeFileSync(rig.file, `garbage-${round} `.repeat(500));
          const store = await rig.open();
          await store.close();
        }
        const kept = quarantined(rig.dir);
        assert.equal(kept.length, 2, kept.join(', '));
        const starts = kept.map((name) => fs.readFileSync(path.join(rig.dir, name), 'utf8').slice(0, 9)).sort();
        assert.deepStrictEqual(starts, ['garbage-2', 'garbage-3']);
      });
    });
  });

  describe(`schema version policy (${driver})`, () => {
    it('SchemaTooNew: a store written with a newer schema version refuses to open, with a message that names the host version, and is left alone', async () => {
      await withRig(driver, async (rig) => {
        const first = await rig.open({ schemaVersion: SCHEMA_VERSION + 1 });
        await first.close();
        await assert.rejects(
          rig.open(),
          (error: unknown) =>
            error instanceof SchemaTooNew && error.hostVersion === '9.9.9' && /newer gsd-atlas.*9\.9\.9/.test(error.message),
        );
        assert.equal(fs.existsSync(rig.file), true);
        assert.deepStrictEqual(quarantined(rig.dir), [], 'a newer store is not damaged and is never moved aside');
      });
    });

    it('older schema: a store with an older version is deleted and recreated (no moved-aside copy), and answers rebuilding', async () => {
      await withRig(driver, async (rig) => {
        const first = await rig.open({ schemaVersion: 0 });
        await seed(first, 3);
        await first.close();

        const store = await rig.open();
        const status = await store.status();
        assert.equal(status.schemaVersion, SCHEMA_VERSION);
        assert.equal(status.rebuiltAfterCorruption, undefined, 'an old schema is not corruption');
        assert.deepStrictEqual(status.worktrees, [], 'the old data is gone');
        assert.deepStrictEqual(quarantined(rig.dir), [], 'the old file is not kept');
        assert.deepStrictEqual(
          fs.readdirSync(rig.dir).filter((name) => name.startsWith('facts.db') && !/-(wal|shm)$/.test(name)),
          ['facts.db'],
        );

        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        const during = await store.at('main').find('sym0');
        assert.equal(during.degraded?.includes('rebuilding'), true);
        await writer.setOverlay('main', 'refs/heads/main', new Map([[generatedPath(0), generatedHash(0)]]));
        assert.equal((await store.at('main').find('sym0')).degraded?.includes('rebuilding') ?? false, false);
        writer.release();
      });
    });
  });
}

describe('quarantine and pruneQuarantine', () => {
  function touch(dir: string, names: readonly string[]): void {
    for (const name of names) fs.writeFileSync(path.join(dir, name), name);
  }

  it('moves facts.db and its -wal and -shm files to a name with .corrupt- and the time, and drops the sentinel', () => {
    const tmp = makeTempDir();
    try {
      touch(tmp.path, ['facts.db', 'facts.db-wal', 'facts.db-shm', 'dirty', 'lease.db']);
      const { movedTo } = quarantine(tmp.path, new FakeClock(1234));
      assert.equal(path.dirname(movedTo), tmp.path);
      assert.match(path.basename(movedTo), /^facts\.db\.corrupt-0*1234$/);
      assert.equal(fs.readFileSync(movedTo, 'utf8'), 'facts.db');
      assert.equal(fs.readFileSync(`${movedTo}-wal`, 'utf8'), 'facts.db-wal');
      assert.equal(fs.readFileSync(`${movedTo}-shm`, 'utf8'), 'facts.db-shm');
      for (const gone of ['facts.db', 'facts.db-wal', 'facts.db-shm', 'dirty']) {
        assert.equal(fs.existsSync(path.join(tmp.path, gone)), false, gone);
      }
      assert.equal(fs.existsSync(path.join(tmp.path, 'lease.db')), true, 'other files are untouched');
      assert.equal(fs.existsSync(dirtyMarkerPath(tmp.path)), false);
    } finally {
      tmp.cleanup();
    }
  });

  it('never overwrites an earlier moved-aside file made at the same time', () => {
    const tmp = makeTempDir();
    try {
      const clock = new FakeClock(500);
      const moved: string[] = [];
      for (const round of [1, 2, 3]) {
        fs.writeFileSync(path.join(tmp.path, 'facts.db'), `round-${round}`);
        moved.push(quarantine(tmp.path, clock).movedTo);
      }
      assert.equal(new Set(moved).size, 3);
      assert.deepStrictEqual(moved.map((file) => fs.readFileSync(file, 'utf8')), ['round-1', 'round-2', 'round-3']);
    } finally {
      tmp.cleanup();
    }
  });

  it('pruneQuarantine keeps the newest groups with their companions and removes the rest', () => {
    const tmp = makeTempDir();
    try {
      const moved: string[] = [];
      for (const time of [1, 2, 3, 4]) {
        touch(tmp.path, ['facts.db', 'facts.db-wal']);
        moved.push(quarantine(tmp.path, new FakeClock(time)).movedTo);
      }
      touch(tmp.path, ['facts.db', 'lease.db']);
      pruneQuarantine(tmp.path, 2);
      assert.deepStrictEqual(
        moved.map((file) => fs.existsSync(file)),
        [false, false, true, true],
      );
      assert.deepStrictEqual(
        moved.map((file) => fs.existsSync(`${file}-wal`)),
        [false, false, true, true],
        'companions follow their main file',
      );
      assert.equal(fs.existsSync(path.join(tmp.path, 'facts.db')), true);
      assert.equal(fs.existsSync(path.join(tmp.path, 'lease.db')), true);
      pruneQuarantine(tmp.path, 2); // idempotent
      assert.equal(moved.filter((file) => fs.existsSync(file)).length, 2);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('sentinel and recovery with a writer lease', () => {
  it('a follower never touches the sentinel, runs no check and leaves it for the leader', async () => {
    await withRig('node:sqlite', async (rig) => {
      const leader = await rig.open({ lease: 'acquire' });
      const writer = leader.writer();
      await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
      assert.equal(isDirty(rig.dir), true);

      const before = recoveryCounters.quickChecks;
      const follower = await rig.open({ lease: 'acquire' });
      assert.equal(recoveryCounters.quickChecks, before, 'the follower did not check a database a live writer is using');
      assert.equal(isDirty(rig.dir), true);
      assert.deepStrictEqual(quarantined(rig.dir), []);
      await follower.close();
      assert.equal(isDirty(rig.dir), true, 'the follower did not create the sentinel, so it does not remove it');
      writer.release();
      assert.equal(isDirty(rig.dir), false);
    });
  });

  it('a follower that takes over after the leader died with the sentinel set runs the check and clears it', async () => {
    await withRig('node:sqlite', async (rig) => {
      const leader = await rig.open({ lease: 'acquire' });
      await seed(leader, 3);
      const changes: boolean[] = [];
      const follower = await rig.open({
        lease: 'acquire',
        takeover: { retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS, retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS, random: () => 0 },
        onLeaseChange: (held) => changes.push(held),
      });
      await leader.close();
      markDirty(rig.dir); // what a killed leader leaves behind

      const before = recoveryCounters.quickChecks;
      await rig.clock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
      await pollUntil(10_000, 'the takeover', () => changes.length > 0);
      assert.deepStrictEqual(changes, [true]);
      assert.equal(recoveryCounters.quickChecks, before + 1);
      assert.equal(isDirty(rig.dir), false);
      assert.equal((await follower.at('main').find('sym0')).data.length, 3);
    });
  });

  it('corrupt: a follower that takes over and finds the store damaged moves it aside and rebuilds it in place', async () => {
    await withRig('node:sqlite', async (rig) => {
      const leader = await rig.open({ lease: 'acquire' });
      await seed(leader, 30);
      const changes: boolean[] = [];
      const follower = await rig.open({
        lease: 'acquire',
        takeover: { retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS, retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS, random: () => 0 },
        onLeaseChange: (held) => changes.push(held),
      });
      // With the follower's connections open the leader is not the last to close, so its facts would stay in the
      // WAL. Fold them into the main file first, so the damage below lands where the check will look.
      const folder = await openDatabase(rig.file, { driver: 'node:sqlite' });
      try {
        folder.pragma('wal_checkpoint', 'TRUNCATE');
      } finally {
        folder.close();
      }
      await leader.close();
      assert.ok(fs.statSync(rig.file).size > 8192, 'the facts are in the main file');
      // The follower may hold a few pages in its cache, so damage everything after page 1.
      overwrite(rig.file, 4096, fs.statSync(rig.file).size - 4096);
      markDirty(rig.dir);

      await rig.clock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
      await pollUntil(10_000, 'the takeover and the rebuild', () => changes.length > 0);

      const status = await follower.status();
      assert.ok(status.rebuiltAfterCorruption !== undefined);
      assert.equal(quarantined(rig.dir).length, 1);
      assert.equal(isDirty(rig.dir), false);
      assert.equal(status.writerLeaseHeld, true);
      await assert.rejects(follower.at('main').find('sym0'), UnknownWorktree, 'the rebuilt store has no overlays yet');

      const writer = follower.writer();
      await writer.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
      const found = await follower.at('main').find('sym0');
      assert.equal(found.data.length, 1);
      assert.equal(found.degraded?.includes('follower') ?? false, false);
      assert.equal(found.degraded?.includes('rebuilding'), true);
      writer.release();
    });
  });
});

describe('killing a real writer process', () => {
  /** Start a writer child, wait for `acknowledge` commits (or 1 and then a random pause), SIGKILL it. */
  async function killWriter(dir: string, acknowledge: number | 'random'): Promise<{ acknowledged: number; lastSeq: number }> {
    const stream = runner.stream({ executable: process.execPath, args: [CHILD, 'write', dir] });
    const lines = lineReader(stream.stdout);
    let acknowledged = 0;
    let lastSeq = 0;
    try {
      const target = acknowledge === 'random' ? 1 : acknowledge;
      while (acknowledged < target) {
        const line = await within(CHILD_CEILING_MS, 'a commit acknowledgement', lines.next());
        const match = line === undefined ? null : /^committed (\d+) seq (\d+)$/.exec(line);
        if (match === null) throw new Error(`unexpected child output: ${String(line)}`);
        acknowledged = Number(match[1]);
        lastSeq = Number(match[2]);
      }
      if (acknowledge === 'random') {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.floor(Math.random() * 120));
        });
      }
    } finally {
      stream.kill();
      await stream.result;
    }
    return { acknowledged, lastSeq };
  }

  for (const acknowledge of [1, 4, 9, 'random'] as const) {
    it(`SIGKILL ${acknowledge === 'random' ? 'at a random time after the first commit' : `after ${acknowledge} acknowledged commit${acknowledge === 1 ? '' : 's'}`}: the reopened store passes quick_check, every file is all-or-none and the watermark never goes back`, async () => {
      const tmp = makeTempDir();
      const dir = path.join(realPath(tmp.path), 'store');
      let store: FactStore | undefined;
      try {
        const { acknowledged, lastSeq } = await killWriter(dir, acknowledge);
        assert.equal(isDirty(dir), true, 'a writer killed mid-batch leaves the sentinel behind');

        const checksBefore = recoveryCounters.quickChecks;
        store = await openFactStore(
          dir,
          { resolver: noResolver, clock: new FakeClock(1), gitHas: async () => true },
          { repo: 'repo', version: 'parent', lease: 'acquire' },
        );
        assert.equal((await store.status()).writerLeaseHeld, true, 'the operating system released the dead writer\'s lock');
        assert.equal(recoveryCounters.quickChecks, checksBefore + 1, 'the sentinel made the open check the store');
        assert.equal(isDirty(dir), false);
        assert.deepStrictEqual(quarantined(dir), [], 'a killed writer alone does not damage the file');

        const peek = await openDatabase(path.join(dir, STORE_FILE_NAME), { readOnly: true });
        try {
          assert.equal(peek.pragma('quick_check'), 'ok');
        } finally {
          peek.close();
        }

        let whole = 0;
        for (let index = 0; ; index += 1) {
          const facts = await store.at('main').fileFacts(generatedPath(index));
          if (facts.data === null) break;
          assert.equal(facts.data.symbols.length, SYMBOLS_PER_FILE, `file ${index} symbols`);
          assert.equal(facts.data.refSites.length, REFS_PER_FILE, `file ${index} references`);
          assert.equal(facts.data.imports.length, IMPORTS_PER_FILE, `file ${index} imports`);
          whole += 1;
        }
        assert.ok(whole >= acknowledged, `${whole} whole files, ${acknowledged} were acknowledged`);
        const watermark = (await store.at('main').find('sym0')).watermark;
        assert.ok(watermark.seq >= lastSeq, `watermark ${watermark.seq} is below the last acknowledged ${lastSeq}`);
      } finally {
        await store?.close();
        tmp.cleanup();
      }
    });
  }

  it('[edge STO-07/concurrency] a child process and the parent create the same store directory at the same moment', async () => {
    const tmp = makeTempDir();
    try {
      const root = realPath(tmp.path);
      for (let round = 0; round < 5; round += 1) {
        const repoDir = path.join(root, `repo-${round}`);
        const commonDir = path.join(repoDir, '.git');
        fs.mkdirSync(commonDir, { recursive: true });
        const cacheRoot = path.join(root, 'cache');
        let open: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const goLine = async function* (): AsyncGenerator<string> {
          await gate;
          yield 'go\n';
        };
        const stream = runner.stream({
          executable: process.execPath,
          args: [CHILD, 'resolve', commonDir, repoDir, cacheRoot, '8d9153397a368aae'],
          stdin: goLine(),
        });
        try {
          const lines = lineReader(stream.stdout);
          assert.equal(await within(CHILD_CEILING_MS, 'the child to be ready', lines.next()), 'ready');
          open();
          const mine = resolveStoreLocation({ storeId: '8d9153397a368aae', commonDir, repoDir, cacheRoot, env: {} });
          const theirs = await within(CHILD_CEILING_MS, 'the child to resolve', lines.next());
          assert.equal(theirs, `${mine.kind} ${mine.dir}`);
          assert.equal(fs.statSync(mine.dir).isDirectory(), true);
        } finally {
          stream.kill();
          await stream.result;
        }
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('test hygiene (IN-08)', () => {
  it('the recovery counter is zero when the last test of the file starts', () => {
    assert.equal(recoveryCounters.quickChecks, 0);
  });
});
