import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGovernor } from '../governor/index.ts';
import type { Job } from '../governor/index.ts';
import { DEFAULT_INDEXER_CONFIG, IndexerError, createIndexer, createManualEventSource } from './index.ts';
import type { IndexerDeps } from './index.ts';
import {
  SpyClock,
  THREE_FILES,
  blobId,
  countingEngine,
  eventually,
  makeWorld,
  newLog,
  recordingTree,
  spyGovernor,
} from './harness.test.ts';
import type { EngineLog, World } from './harness.test.ts';

const { debounceMs, idleReconcileIntervalMs } = DEFAULT_INDEXER_CONFIG;

/** The Governor classes of the jobs run since the list was last cleared, without repeats. */
const classesOf = (jobs: readonly Job[]): string[] => [...new Set(jobs.map((job) => job.class))].sort();

describe('Reconcile tracer: a missed event is repaired by comparing the working tree with the store', () => {
  it('missed event: an unreported edit, delete and add are repaired by reconcile and reported as changed 3', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);

    world.repo.write('a.toy', 'fn main {\n}\nfn edited {\n}\n');
    world.repo.remove('c.toy');
    world.repo.write('d.toy', 'fn added {\n}\n');
    assert.equal((await world.reader.find('edited')).data.length, 0, 'no event was delivered, so the store is behind');

    const outcome = await world.indexer.reconcile(world.dir);
    assert.equal(outcome.changed, 3);
    assert.equal(outcome.parsed, 2);
    assert.equal(outcome.removed, 1);
    assert.equal((await world.reader.find('edited')).data.length, 1);
    assert.equal((await world.reader.find('added')).data.length, 1);
    assert.equal((await world.reader.find('Widget')).data.length, 0);
    assert.equal((await world.reader.fileFacts('c.toy')).data, null);
    assert.equal((await world.reader.fileFacts('d.toy')).data?.contentHash, blobId('fn added {\n}\n'));
  });

  it('missed event: start on an empty store indexes every file and reports what it did in status', async (t) => {
    const sampled: boolean[] = [];
    const holder: { world?: World } = {};
    const jobs: Job[] = [];
    const world = await makeWorld(t, {
      files: THREE_FILES,
      governor: (clock) =>
        spyGovernor(createGovernor({ clock }), jobs, {
          onStart: () => {
            sampled.push(holder.world?.indexer.status().reconciling ?? false);
          },
        }),
    });
    holder.world = world;
    assert.equal(world.indexer.status().lastReconcile, null);
    assert.equal(world.indexer.status().reconciling, false);

    await world.indexer.start();

    assert.ok(sampled.length > 0);
    assert.ok(
      sampled.every((reconciling) => reconciling),
      'status().reconciling is true whenever one of its Governor jobs is running',
    );
    const status = world.indexer.status();
    assert.equal(status.reconciling, false);
    assert.equal(status.lastReconcile?.changed, 3, 'three files in the source set');
    assert.equal(status.lastReconcile?.at, 1000);
    assert.equal((await world.reader.find('helper')).data.length, 1);
    assert.equal((await world.reader.find('Widget')).data.length, 1);
    assert.deepEqual(classesOf(jobs), ['indexing'], 'the start-up Reconcile runs at the indexing priority');
  });

  it('missed event: start rejects with lease_held while another holder has the writer slot', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    const other = world.store.writer();
    await assert.rejects(world.indexer.start(), (error: unknown) => error instanceof IndexerError && error.code === 'lease_held');
    other.release();
    await world.indexer.start();
    assert.equal(world.indexer.status().lastReconcile?.changed, 3);
  });

  it('missed event: reconcile of a directory that is not a worktree of the repository rejects with unknown_worktree', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await assert.rejects(
      world.indexer.reconcile(`${world.dir}-nowhere`),
      (error: unknown) => error instanceof IndexerError && error.code === 'unknown_worktree',
    );
  });
});

describe('Reconcile triggers: watcher problems, the idle timer and idempotence', () => {
  for (const problem of ['overflow', 'error'] as const) {
    it(`${problem}: a watcher ${problem} starts a Reconcile at the indexing priority even if no file event arrived`, async (t) => {
      const manual = createManualEventSource();
      const jobs: Job[] = [];
      const world = await makeWorld(t, {
        files: THREE_FILES,
        source: manual.source,
        governor: (clock) => spyGovernor(createGovernor({ clock }), jobs),
      });
      await world.indexer.start();
      jobs.length = 0;

      world.repo.write('b.toy', `fn helper {\n}\nfn after_${problem} {\n}\n`);
      manual.emitProblem(world.dir, problem);
      await eventually(async () => (await world.reader.find(`after_${problem}`)).data.length === 1, 'the Reconcile to repair the edit');

      assert.deepEqual(classesOf(jobs), ['indexing']);
      assert.deepEqual(world.indexer.status().watchProblems, [{ worktree: world.dir, kind: problem, count: 1 }]);
    });
  }

  it('idle timer: the approved interval starts a Reconcile at the maintenance priority, re-arms, and stop cancels it', async (t) => {
    const manual = createManualEventSource();
    const clock = new SpyClock(1000);
    const jobs: Job[] = [];
    const world = await makeWorld(t, {
      files: THREE_FILES,
      source: manual.source,
      clock,
      governor: (c) => spyGovernor(createGovernor({ clock: c }), jobs),
    });
    await world.indexer.start();
    assert.equal(clock.liveWith(idleReconcileIntervalMs), 1, 'one idle timer is armed through Clock.after');
    jobs.length = 0;

    world.repo.write('a.toy', 'fn main {\n}\nfn idle_one {\n}\n');
    await clock.advance(idleReconcileIntervalMs - 1);
    assert.equal(jobs.length, 0, 'nothing runs before the interval has passed');
    await clock.advance(1);
    await eventually(async () => (await world.reader.find('idle_one')).data.length === 1, 'the idle Reconcile to repair the edit');
    assert.deepEqual(classesOf(jobs), ['maintenance']);
    assert.equal(clock.liveWith(idleReconcileIntervalMs), 1, 'the timer is re-armed');

    jobs.length = 0;
    world.repo.write('a.toy', 'fn main {\n}\nfn idle_two {\n}\n');
    await clock.advance(idleReconcileIntervalMs);
    await eventually(async () => (await world.reader.find('idle_two')).data.length === 1, 'the second idle Reconcile');
    assert.deepEqual(classesOf(jobs), ['maintenance']);

    await world.indexer.stop();
    assert.equal(clock.liveWith(idleReconcileIntervalMs), 0, 'stop cancels the idle timer');
  });

  it('idle timer: an interval of 0 switches the periodic Reconcile off', async (t) => {
    const clock = new SpyClock(1000);
    const world = await makeWorld(t, { files: THREE_FILES, clock, config: { idleReconcileIntervalMs: 0 } });
    await world.indexer.start();
    assert.equal(clock.liveWith(0), 0);
    assert.equal(clock.liveWith(idleReconcileIntervalMs), 0);
  });

  it('idle timer: an interval that is not a finite number of at least 0 is refused when the Indexer is made', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createIndexer({ config: { idleReconcileIntervalMs: value } } as unknown as IndexerDeps),
        (error: unknown) => error instanceof RangeError && /idleReconcileIntervalMs/.test(error.message),
      );
    }
  });

  it('idempotent: a second Reconcile of an unchanged tree changes nothing, parses nothing and keeps the watermark', async (t) => {
    const log = newLog();
    const engine: EngineLog = { sources: [] };
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log), engine: countingEngine(engine) });
    await world.indexer.build(world.dir);
    const before = (await world.reader.find('helper')).watermark.seq;
    log.hashPaths.length = 0;
    engine.sources.length = 0;

    const first = await world.indexer.reconcile(world.dir);
    const second = await world.indexer.reconcile(world.dir);

    assert.equal(first.changed, 0);
    assert.equal(second.changed, 0);
    assert.equal(second.parsed, 0);
    assert.equal(second.removed, 0);
    assert.deepEqual(engine.sources, []);
    assert.deepEqual(log.hashPaths, [], 'nothing differs, so no path is hashed again');
    assert.equal((await world.reader.find('helper')).watermark.seq, before);
  });

  it('shared run: two requests for one worktree at the same time share one Reconcile', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log) });
    await world.indexer.build(world.dir);
    world.repo.write('b.toy', 'fn helper {\n}\nfn shared_one {\n}\n');
    log.snapshots = 0;

    const [first, second] = await Promise.all([world.indexer.reconcile(world.dir), world.indexer.reconcile(world.dir)]);

    assert.equal(log.snapshots, 1, 'one snapshot, one run');
    assert.deepEqual(second, first);
    assert.equal(first.changed, 1);
    assert.equal((await world.reader.find('shared_one')).data.length, 1);
  });
});

describe('Reconcile and events: an event that lands while Reconcile is running', () => {
  it('during reconcile: a file event that arrives mid-run is not lost and the final facts equal the working tree', async (t) => {
    const manual = createManualEventSource();
    const clock = new SpyClock(1000);
    const engine: EngineLog = { sources: [] };
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source, clock, engine: countingEngine(engine) });
    await world.indexer.start();

    // The Reconcile parses a.toy; its parse is held open while a save of b.toy arrives and is indexed.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    engine.onRun = async (source) => {
      if (source.includes('HOLD_ME')) {
        held = true;
        await gate;
      }
    };
    world.repo.write('a.toy', 'fn main {\n}\nfn by_reconcile {\n}\n# HOLD_ME\n');
    const running = world.indexer.reconcile(world.dir);
    await eventually(async () => held, 'the Reconcile to reach the held parse');
    assert.equal(world.indexer.status().reconciling, true);

    const during = 'fn helper {\n}\nfn during_run {\n}\n';
    world.repo.write('b.toy', during);
    manual.emit(world.dir, 'b.toy');
    await clock.advance(debounceMs);
    await eventually(async () => (await world.reader.find('during_run')).data.length === 1, 'the event to be indexed');

    release();
    const outcome = await running;
    assert.equal(outcome.changed, 1, 'the snapshot was taken before the save of b.toy');
    assert.equal((await world.reader.find('by_reconcile')).data.length, 1);
    assert.equal((await world.reader.find('during_run')).data.length, 1, 'the Reconcile did not overwrite the newer facts');
    assert.equal((await world.reader.fileFacts('b.toy')).data?.contentHash, blobId(during));

    // And a Reconcile that starts afterwards agrees with the tree: nothing is left to repair.
    const after = await world.indexer.reconcile(world.dir);
    assert.equal(after.changed, 0);
  });
});
