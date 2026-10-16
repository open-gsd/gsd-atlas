/**
 * Compaction, the integrity check, the combined `maintain` task and the refresh of stale files (STO-05, STO-10,
 * plan 02-18). Real SQLite in a temp directory, a fake clock and a fake `gitHas`, through the public FactStore
 * interface; the only internals used are the lifecycle test hooks and read-only connections that read counters.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FileFacts, Span } from '../facts/index.ts';
import { generatedFacts, generatedHash, generatedPath } from '../../scripts/test-helpers/store-facts.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { UnknownWorktree, WriterBusy } from './errors.ts';
import { lifecycleTestHooks } from './lifecycle.ts';
import { maintainStore } from './maintain.ts';
import type { MaintainTasks } from './maintain.ts';
import { openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import { QUARANTINE_MARK } from './recovery.ts';
import { STORE_FILE_NAME } from './schema.ts';
import type { CheckResult, FactStore, MaintenanceOptions, MaintenanceResult, Resolver, StoreDeps, Writer } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

const PAGE = 4096;

interface Rig {
  readonly clock: FakeClock;
  readonly dir: string;
  readonly file: string;
  open(extra?: Partial<StoreOpenOptions>): Promise<FactStore>;
  /** A pragma's first value, read through a second, read-only connection. */
  pragma(name: 'freelist_count' | 'page_count' | 'quick_check'): Promise<unknown>;
  /** The column `n` of the first row of `sql`, read through a second, read-only connection. */
  scalar(sql: string): Promise<unknown>;
}

async function withRig(driver: DriverName, run: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const file = path.join(dir, STORE_FILE_NAME);
  const opened: FactStore[] = [];
  const rig: Rig = {
    clock,
    dir,
    file,
    async open(extra = {}) {
      const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async () => true };
      const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9', ...extra });
      opened.push(store);
      return store;
    },
    async pragma(name) {
      const db = await openDatabase(file, { readOnly: true, driver });
      try {
        return db.pragma(name);
      } finally {
        db.close();
      }
    },
    async scalar(sql) {
      const db = await openDatabase(file, { readOnly: true, driver });
      try {
        return db.prepare(sql).get()?.n;
      } finally {
        db.close();
      }
    },
  };
  try {
    await run(rig);
  } finally {
    lifecycleTestHooks.onSlice = undefined;
    lifecycleTestHooks.onVacuum = undefined;
    lifecycleTestHooks.onTask = undefined;
    for (const store of opened) await store.close();
    tmp.cleanup();
  }
}

/** Commit generated files `0` to `count - 1` into worktree `main`. */
async function seed(writer: Writer, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash: generatedHash(index), facts: generatedFacts(index) });
  }
}

/** Recommit files `0` to `count - 1` under new hashes, which retires the versions `seed` wrote. */
async function reseed(writer: Writer, count: number, offset: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const hash = generatedHash(offset + index);
    await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash, facts: { ...generatedFacts(index), contentHash: hash } });
  }
}

function overwrite(file: string, start: number, length: number): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(length, 0xff), 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
}

const span = (line: number): Span => ({ startLine: line, startColumn: 0, endLine: line + 1, endColumn: 1 });

function named(filePath: string, hash: string, grammarVersion: string, names: readonly string[]): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion,
    symbols: names.map((name, index) => ({ name, kind: 'function', span: span(index * 2), exported: true })),
    refSites: [],
    imports: [],
    exports: [],
    parse: { errorBytes: 0, totalBytes: 100 },
  };
}

/** A store with `count` live files whose first versions were all collected, leaving free pages behind. */
async function withFreePages(rig: Rig, store: FactStore, count: number, replaced: number): Promise<void> {
  const writer = store.writer();
  await seed(writer, count);
  await reseed(writer, replaced, count);
  writer.release();
  const collected = await store.collect({ budgetMs: 60_000 });
  assert.equal(collected.processed, replaced);
  assert.equal(collected.complete, true);
}

for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
  describe(`compact (${driver})`, () => {
    it('slice: free pages are returned in bounded slices, the WAL is truncated and the file shrinks', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await withFreePages(rig, store, 400, 400);
        const free = Number(await rig.pragma('freelist_count'));
        const pages = Number(await rig.pragma('page_count'));
        assert.ok(free > 64, `the setup must leave more free pages than one first slice (${free})`);
        assert.ok(free * 4 > pages, 'and a large part of the file');
        const sizeBefore = (await store.status()).sizeBytes;

        const slices: Array<{ pages: number; ms: number }> = [];
        lifecycleTestHooks.onSlice = (slice) => slices.push({ pages: slice.pages, ms: slice.ms });
        const result = await store.compact({ budgetMs: 60_000 });

        assert.equal(result.complete, true);
        assert.equal(result.processed, free, 'processed counts the pages returned to the file system');
        assert.ok(slices.length >= 1);
        for (const slice of slices) assert.ok(slice.ms < 200 * 5, `a slice took ${slice.ms} ms against the approved 200 ms`);
        assert.equal(Number(await rig.pragma('freelist_count')), 0);
        assert.ok((await store.status()).sizeBytes < sizeBefore, 'the file got smaller');
        const wal = `${rig.file}-wal`;
        assert.equal(fs.existsSync(wal) ? fs.statSync(wal).size : 0, 0, 'the WAL was checkpointed and truncated');
      });
    });

    it('slice: a budget of zero performs one slice, reports incomplete while pages remain, and later calls finish', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await withFreePages(rig, store, 400, 400);
        const free = Number(await rig.pragma('freelist_count'));
        assert.ok(free > 64);

        let slices = 0;
        lifecycleTestHooks.onSlice = () => {
          slices += 1;
        };
        const first = await store.compact({ budgetMs: 0 });
        assert.equal(slices, 1, 'exactly one slice');
        assert.equal(first.complete, false);
        assert.ok(first.processed > 0 && first.processed < free);
        // `optimize` may write planner statistics, which take a few of the free pages for themselves.
        const remaining = Number(await rig.pragma('freelist_count'));
        assert.ok(remaining > 0 && remaining <= free - first.processed && remaining >= free - first.processed - 8);

        let guard = 0;
        let total = first.processed;
        for (let result = first; !result.complete && guard < 1000; guard += 1) {
          result = await store.compact({ budgetMs: 0 });
          total += result.processed;
        }
        assert.ok(total <= free && total >= free - 8, `resumable: the calls together return the free pages (${total} of ${free})`);
        assert.equal(Number(await rig.pragma('freelist_count')), 0);
        const again = await store.compact({ budgetMs: 0 });
        assert.deepStrictEqual({ complete: again.complete, processed: again.processed }, { complete: true, processed: 0 }, 'idempotent');
      });
    });

    it('full vacuum: runs only on request and only when more than a quarter of the file is free', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await withFreePages(rig, store, 400, 400);
        const vacuums: number[] = [];
        lifecycleTestHooks.onVacuum = () => vacuums.push(1);

        // Without `full` the incremental slices do the work and VACUUM never runs.
        const free = Number(await rig.pragma('freelist_count'));
        const plain = await store.compact({ budgetMs: 60_000 });
        assert.equal(plain.processed, free);
        assert.equal(vacuums.length, 0, 'no full VACUUM without the request');

        // More than a quarter free and `full`: one VACUUM, and it leaves no free page.
        const writer = store.writer();
        await reseed(writer, 400, 2000);
        writer.release();
        await store.collect({ budgetMs: 60_000 });
        const heavyFree = Number(await rig.pragma('freelist_count'));
        const heavyPages = Number(await rig.pragma('page_count'));
        assert.ok(heavyFree * 4 > heavyPages, 'the setup must free more than a quarter of the file');
        const full = await store.compact({ budgetMs: 60_000, full: true });
        assert.equal(vacuums.length, 1);
        assert.equal(full.complete, true);
        assert.ok(full.processed >= heavyFree, 'processed counts the pages the file gave back, the free ones and the space packed out of used ones');
        assert.equal(Number(await rig.pragma('freelist_count')), 0);
      });
    });

    it('full vacuum: with a quarter or less of the file free the request does not run VACUUM', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await withFreePages(rig, store, 400, 20);
        const free = Number(await rig.pragma('freelist_count'));
        const pages = Number(await rig.pragma('page_count'));
        assert.ok(free > 0 && free * 4 <= pages, `the setup must free a little (${free} of ${pages})`);
        let vacuums = 0;
        lifecycleTestHooks.onVacuum = () => {
          vacuums += 1;
        };
        const result = await store.compact({ budgetMs: 60_000, full: true });
        assert.equal(vacuums, 0);
        assert.equal(result.processed, free, 'the pages still go, in slices');
      });
    });

    it('full vacuum: a file whose pages are mostly empty inside, with no free page, is vacuumed on request and never without it', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await seed(writer, 300);
        // Edit random files under new hashes (a seeded counter, so the run is the same every time). The live
        // versions stay scattered through every table, so collecting the old ones empties few pages and leaves
        // most of the others about half empty.
        const versions = new Array<number>(300).fill(0);
        let state = 7;
        for (let edit = 0; edit < 1500; edit += 1) {
          state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
          const index = state % 300;
          versions[index] = (versions[index] ?? 0) + 1;
          const hash = generatedHash(1000 + (versions[index] ?? 0) * 300 + index);
          await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash, facts: { ...generatedFacts(index), contentHash: hash } });
        }
        writer.release();
        const collected = await store.collect({ budgetMs: 60_000 });
        assert.equal(collected.processed, 1500);
        await store.compact({ budgetMs: 60_000 });
        assert.equal(Number(await rig.pragma('freelist_count')), 0, 'the setup leaves no free page');
        const pagesBefore = Number(await rig.pragma('page_count'));

        let vacuums = 0;
        lifecycleTestHooks.onVacuum = () => {
          vacuums += 1;
        };
        const plain = await store.compact({ budgetMs: 60_000 });
        assert.equal(vacuums, 0, 'never without the request');
        assert.equal(plain.processed, 0);
        assert.equal(Number(await rig.pragma('page_count')), pagesBefore);

        const full = await store.compact({ budgetMs: 60_000, full: true });
        assert.equal(vacuums, 1, 'a file over a third empty inside is vacuumed when asked');
        assert.equal(full.complete, true);
        assert.ok(full.processed > 0, 'processed counts the pages the vacuum gave back');
        const pagesAfter = Number(await rig.pragma('page_count'));
        assert.ok(pagesAfter < pagesBefore * 0.8, `the file shrank from ${pagesBefore} to ${pagesAfter} pages`);
        assert.equal((await store.at('main').find('sym0')).data.length, 300, 'every live file is still there');

        const again = await store.compact({ budgetMs: 60_000, full: true });
        assert.equal(vacuums, 1, 'idempotent: a packed file is not vacuumed again');
        assert.equal(again.processed, 0);
      });
    });

    it('compact on a store with nothing to free processes nothing, and a follower may not compact', async () => {
      await withRig(driver, async (rig) => {
        const leader = await rig.open({ lease: 'acquire' });
        const follower = await rig.open({ lease: 'acquire' });
        const result = await leader.compact({ budgetMs: 1000 });
        assert.deepStrictEqual({ complete: result.complete, processed: result.processed }, { complete: true, processed: 0 });
        await assert.rejects(follower.compact({ budgetMs: 1000 }), WriterBusy);
      });
    });
  });

  describe(`check (${driver})`, () => {
    it('a healthy store checks out with no problems', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await seed(writer, 5);
        writer.release();
        assert.deepStrictEqual(await store.check(), { ok: true, problems: [] });
        assert.equal((await store.status()).rebuiltAfterCorruption, undefined);
      });
    });

    it('check corrupt: overwritten pages fail the check, the files are moved aside, the store is recreated and reads say rebuilding', async () => {
      await withRig(driver, async (rig) => {
        let store = await rig.open();
        const writer = store.writer();
        await seed(writer, 120);
        writer.release();
        await store.close();

        // The root page of the reference table holds fact rows, not the schema, and neither the open nor `status`
        // reads it, so the store opens and only a check can find the damage.
        const root = Number(await rig.scalar("SELECT rootpage AS n FROM sqlite_master WHERE name = 'refs'"));
        assert.ok(root > 1);
        overwrite(rig.file, (root - 1) * PAGE, PAGE);

        const damaged = await openDatabase(rig.file, { readOnly: true, driver: driver });
        let verdict: unknown;
        try {
          verdict = damaged.pragma('quick_check');
        } catch {
          verdict = 'threw';
        } finally {
          damaged.close();
        }
        assert.notEqual(verdict, 'ok', 'the overwritten range must fail quick_check');

        store = await rig.open();
        assert.equal((await store.status()).rebuiltAfterCorruption, undefined, 'the open itself did not notice');

        await rig.clock.advance(5000);
        const result = await store.check();
        assert.equal(result.ok, false);
        assert.ok(result.problems.length >= 1);
        assert.ok(result.problems.every((line) => line.length > 0));

        const status = await store.status();
        assert.ok(status.rebuiltAfterCorruption !== undefined);
        assert.match(path.basename(status.rebuiltAfterCorruption.movedTo), /^facts\.db\.corrupt-/);
        assert.equal(fs.existsSync(status.rebuiltAfterCorruption.movedTo), true, 'the damaged file is kept as evidence');
        assert.ok(fs.readdirSync(rig.dir).some((name) => name.includes(QUARANTINE_MARK)));
        assert.deepStrictEqual(status.worktrees, []);
        await assert.rejects(store.at('main').find('sym0'), UnknownWorktree);

        const fresh = store.writer();
        await fresh.commitFile({ worktree: 'main', path: generatedPath(0), hash: generatedHash(0), facts: generatedFacts(0) });
        assert.equal((await store.at('main').find('sym0')).degraded?.includes('rebuilding'), true);
        await fresh.setOverlay('main', 'refs/heads/main', new Map([[generatedPath(0), generatedHash(0)]]));
        const after = await store.at('main').find('sym0');
        assert.equal(after.data.length, 1);
        assert.equal(after.degraded?.includes('rebuilding') ?? false, false);
        fresh.release();
        assert.deepStrictEqual(await store.check(), { ok: true, problems: [] }, 'the rebuilt store is healthy');
      });
    });

    it('a follower may not check', async () => {
      await withRig(driver, async (rig) => {
        await rig.open({ lease: 'acquire' });
        const follower = await rig.open({ lease: 'acquire' });
        await assert.rejects(follower.check(), WriterBusy);
      });
    });
  });

  describe(`maintain (${driver})`, () => {
    it('budget: a generous budget collects, compacts and checks in that order and reports complete', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open({ chunkSize: 50 });
        const writer = store.writer();
        await seed(writer, 120);
        await reseed(writer, 120, 120);
        writer.release();

        const order: string[] = [];
        lifecycleTestHooks.onTask = (name) => order.push(name);
        const result = await store.maintain(60_000);
        assert.deepStrictEqual(order, ['collect', 'compact', 'check']);
        assert.equal(result.complete, true);
        assert.ok(result.processed >= 120, 'at least the collected files are counted');
        assert.equal(Number(await rig.pragma('freelist_count')), 0, 'compact ran after collect freed the pages');
        assert.equal((await store.at('main').find('sym0')).data.length, 120);
      });
    });

    it('budget: a tiny budget does at least one chunk of collect, reports incomplete, and later calls finish', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open({ chunkSize: 50 });
        const writer = store.writer();
        await seed(writer, 120);
        await reseed(writer, 120, 120);
        writer.release();

        const first = await store.maintain(1);
        assert.equal(first.complete, false);
        assert.ok(first.processed >= 50, 'one chunk of collect at least');
        let calls = 0;
        let result = first;
        while (!result.complete && calls < 50) {
          result = await store.maintain(1);
          calls += 1;
        }
        assert.equal(result.complete, true);
        assert.equal(Number(await rig.pragma('freelist_count')), 0);
        const again = await store.maintain(1);
        assert.equal(again.complete, true);
        assert.equal(again.processed, 0, 'idempotent once everything is done');
      });
    });

    it('WriterBusy: maintain throws while an in-process writer is out or another process holds the lease, and frees the slot when it ends', async () => {
      await withRig(driver, async (rig) => {
        const leader = await rig.open({ lease: 'acquire' });
        const follower = await rig.open({ lease: 'acquire' });
        const writer = leader.writer();
        await assert.rejects(leader.maintain(1000), WriterBusy, 'the in-process slot is taken');
        writer.release();
        await assert.rejects(follower.maintain(1000), WriterBusy, 'another holder has the lease');

        const done = await leader.maintain(1000);
        assert.equal(done.complete, true);
        const again = leader.writer(); // maintain gave the slot back
        again.release();
      });
    });

    it('maintain gives the slot back when a task fails', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        lifecycleTestHooks.onTask = (name) => {
          if (name === 'compact') throw new Error('compact failed on purpose');
        };
        await assert.rejects(store.maintain(1000), /compact failed on purpose/);
        lifecycleTestHooks.onTask = undefined;
        store.writer().release();
      });
    });

    it('maintain rejects a budget that is not a finite number of milliseconds, zero or more', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await assert.rejects(store.maintain(-1), RangeError);
        await assert.rejects(store.maintain(Number.NaN), RangeError);
        await assert.rejects(store.maintain(Number.POSITIVE_INFINITY), RangeError);
      });
    });
  });

  describe(`refresh of stale files (${driver})`, () => {
    it('refresh: a stale file keeps serving, and committing the same hash with new facts replaces them and clears the flag', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const hash = generatedHash(7);
        await writer.commitFile({ worktree: 'main', path: 'a.ts', hash, facts: named('a.ts', hash, '0.23.2', ['oldName']) });
        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '9.9.9' }), 1);

        const stale = await store.at('main').find('oldName');
        assert.equal(stale.data.length, 1, 'the old facts keep serving');
        assert.equal(stale.degraded?.includes('stale'), true);
        assert.deepStrictEqual(stale.watermark.stalePaths, ['a.ts']);

        const refreshed = await writer.commitFile({ worktree: 'main', path: 'a.ts', hash, facts: named('a.ts', hash, '9.9.9', ['newName']) });
        assert.equal(refreshed.status, 'committed');
        const current = await store.at('main').find('newName');
        assert.equal(current.data.length, 1);
        assert.equal((await store.at('main').find('oldName')).data.length, 0, 'the old symbol is gone');
        assert.deepStrictEqual(current.watermark.stalePaths, []);
        assert.equal(current.degraded?.includes('stale') ?? false, false);

        const repeat = await writer.commitFile({ worktree: 'main', path: 'a.ts', hash, facts: named('a.ts', hash, '9.9.9', ['newName']) });
        assert.equal(repeat.status, 'unchanged');
        writer.release();
      });
    });
  });
}

describe('maintainStore splits one budget between the tasks', () => {
  function tasks(spent: { collect: number; compact: number }, seen: { collect?: number; compact?: number }, complete = true): MaintainTasks {
    const result = (processed: number, spentMs: number, done: boolean): MaintenanceResult => ({ complete: done, spentMs, processed });
    return {
      async collect(options: MaintenanceOptions) {
        seen.collect = options.budgetMs;
        return result(3, spent.collect, complete);
      },
      async compact(options: MaintenanceOptions) {
        seen.compact = options.budgetMs;
        return result(5, spent.compact, true);
      },
      async check(): Promise<CheckResult> {
        return { ok: true, problems: [] };
      },
    };
  }

  it('collect gets half, compact a third and what collect left unused, and the totals add up', async () => {
    const clock = new FakeClock(0);
    const seen: { collect?: number; compact?: number } = {};
    const result = await maintainStore(tasks({ collect: 40, compact: 10 }, seen), clock, 300);
    assert.equal(seen.collect, 150);
    assert.equal(seen.compact, 100 + (150 - 40));
    assert.deepStrictEqual(result, { complete: true, spentMs: 0, processed: 8 });
  });

  it('time collect overspent is not carried backwards, and an unfinished collect makes the run incomplete', async () => {
    const clock = new FakeClock(0);
    const seen: { collect?: number; compact?: number } = {};
    const result = await maintainStore(tasks({ collect: 400, compact: 0 }, seen, false), clock, 300);
    assert.equal(seen.compact, 100);
    assert.equal(result.complete, false);
  });

  it('a failed check counts its problems and still completes', async () => {
    const clock = new FakeClock(0);
    const failing: MaintainTasks = {
      ...tasks({ collect: 0, compact: 0 }, {}),
      async check() {
        return { ok: false, problems: ['row 3 missing from index', 'page 9 is not a btree page'] };
      },
    };
    const result = await maintainStore(failing, clock, 100);
    assert.equal(result.complete, true);
    assert.equal(result.processed, 3 + 5 + 2);
  });
});
