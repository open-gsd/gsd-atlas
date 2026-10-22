import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_CITATIONS_PER_FILE } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import { GRAMMAR_LIMITS } from '../grammar-engine/index.ts';
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
  shippedModules,
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

describe('Reconcile and builds report comments the bound skipped (plan 03-24, approved 2026-10-18)', () => {
  const over = (number: number): string => `// ${'x'.repeat(GRAMMAR_LIMITS.commentTextChars)} ADR-${String(number)}\nexport const v${String(number)} = 1;\n`;

  it('a build says in one counted note how many files hold an over-bound ADR comment, with no path and no text', async (t) => {
    const world = await makeWorld(t, {
      files: { 'src/a.ts': over(45), 'src/b.ts': over(46), 'src/c.ts': '// see ADR-7\nexport const c = 1;\n' },
      builtinDir: shippedModules,
    });
    const result = await world.indexer.build(world.dir);
    assert.deepEqual(result.failed, []);
    const notes = result.skipped.filter((d) => d.code === 'citation_comment_too_long');
    assert.equal(notes.length, 1, 'one aggregated note, not one per file');
    const [note] = notes;
    assert.ok(note);
    assert.equal(note.severity, 'info');
    assert.equal(note.subject, undefined, 'no path');
    assert.match(note.message, /^2 files /);
    assert.ok(!/src\/|\.ts|ADR-4|xxxx/.test(note.message), 'fixed text: no path, no repository text');
    assert.deepEqual(
      (await world.reader.fileFacts('src/c.ts')).data?.citations?.map((c) => c.number),
      [7],
      'the file within the bound still gets its citation',
    );
    assert.equal((await world.reader.fileFacts('src/a.ts')).data?.citations, undefined);
  });

  // -----------------------------------------------------------------------------------------
  // Plan 03-28 (amendment of 2026-10-18): the note is counted from the store, not from what one run parsed

  const NOTE = (count: number): string =>
    `${String(count)} ${count === 1 ? 'file has' : 'files have'} ADR mentions that are not indexed (a comment over the comment size bound, or more than ${String(MAX_CITATIONS_PER_FILE)} mentions in one file); citations from them are missing`;
  const gapNotes = <T extends { readonly code: string }>(skipped: readonly T[]): T[] => skipped.filter((d) => d.code === 'citation_comment_too_long');
  /** A file with 201 mentions, one more than the file cap. */
  const capped = `${Array.from({ length: MAX_CITATIONS_PER_FILE + 1 }, (_, i) => `// ADR-${String(i + 1)}`).join('\n')}\nexport const c = 1;\n`;

  it('note from the store: the build counts the files the store holds with a gap and says it in the fixed text', async (t) => {
    const world = await makeWorld(t, {
      files: { 'src/a.ts': over(45), 'src/b.ts': over(46), 'src/c.ts': '// see ADR-7\nexport const c = 1;\n' },
      builtinDir: shippedModules,
    });
    const result = await world.indexer.build(world.dir);
    const [note, ...rest] = gapNotes(result.skipped);
    assert.deepEqual(rest, [], 'one aggregated note');
    assert.equal(note?.message, NOTE(2));
    assert.equal((await world.reader.citationGaps()).data.files, 2, 'the note is the store count');
    assert.deepEqual((await world.reader.fileFacts('src/a.ts')).data?.citationGaps, { skippedComments: 1, capped: false });
  });

  it('build that parses nothing repeats the note: a second build of an unchanged tree, and one that only adds an unrelated file', async (t) => {
    const world = await makeWorld(t, {
      files: { 'src/a.ts': over(45), 'src/b.ts': over(46), 'src/c.ts': '// see ADR-7\nexport const c = 1;\n' },
      builtinDir: shippedModules,
    });
    const first = await world.indexer.build(world.dir);
    assert.equal(gapNotes(first.skipped).length, 1);

    const second = await world.indexer.build(world.dir);
    assert.equal(second.parsed, 0, 'nothing was parsed');
    assert.equal(second.linked, 3);
    assert.equal(gapNotes(second.skipped)[0]?.message, NOTE(2), 'the note is still there');

    world.repo.write('src/d.ts', 'export const d = 4;\n');
    const third = await world.indexer.build(world.dir);
    assert.equal(third.parsed, 1);
    assert.equal(gapNotes(third.skipped)[0]?.message, NOTE(2), 'an unrelated file does not make it go');
    const reconcile = await world.indexer.reconcile(world.dir);
    assert.equal(reconcile.parsed, 0);
    assert.equal((await world.reader.citationGaps()).data.files, 2);
  });

  it('capped file is counted: a file with more than 200 mentions is a gap, one with exactly 200 is not', async (t) => {
    const world = await makeWorld(t, {
      files: {
        'src/many.ts': capped,
        'src/exact.ts': `${Array.from({ length: MAX_CITATIONS_PER_FILE }, (_, i) => `// ADR-${String(i + 1)}`).join('\n')}\nexport const e = 1;\n`,
      },
      builtinDir: shippedModules,
    });
    const result = await world.indexer.build(world.dir);
    assert.equal(gapNotes(result.skipped)[0]?.message, NOTE(1));
    assert.deepEqual((await world.reader.fileFacts('src/many.ts')).data?.citationGaps, { skippedComments: 0, capped: true });
    assert.equal((await world.reader.fileFacts('src/many.ts')).data?.citations?.length, MAX_CITATIONS_PER_FILE);
    assert.equal('citationGaps' in ((await world.reader.fileFacts('src/exact.ts')).data ?? {}), false);
  });

  it('note disappears with the file: removing the gap file removes the note on the next build', async (t) => {
    const world = await makeWorld(t, {
      files: { 'src/a.ts': over(45), 'src/many.ts': capped, 'src/c.ts': '// see ADR-7\nexport const c = 1;\n' },
      builtinDir: shippedModules,
    });
    assert.equal(gapNotes((await world.indexer.build(world.dir)).skipped)[0]?.message, NOTE(2));
    world.repo.remove('src/a.ts');
    assert.equal(gapNotes((await world.indexer.build(world.dir)).skipped)[0]?.message, NOTE(1));
    world.repo.remove('src/many.ts');
    const last = await world.indexer.build(world.dir);
    assert.deepEqual(gapNotes(last.skipped), []);
    assert.equal((await world.reader.citationGaps()).data.files, 0);
  });

  it('note holds no path: no subject, no file name, no comment text and no number from a skipped comment', async (t) => {
    const world = await makeWorld(t, {
      files: { 'src/secret-name.ts': over(4567), 'src/many.ts': capped },
      builtinDir: shippedModules,
    });
    const notes = gapNotes((await world.indexer.build(world.dir)).skipped);
    assert.equal(notes.length, 1);
    const [note] = notes;
    assert.equal(note?.subject, undefined);
    assert.equal(note?.severity, 'info');
    assert.equal(note?.message, NOTE(2));
    assert.ok(!/secret|many|src|4567|xxxx/.test(note?.message ?? ''));
  });

  it('one file is named in the singular, and a build with nothing over the bound has no such note', async (t) => {
    const one = await makeWorld(t, { files: { 'src/a.ts': over(45) }, builtinDir: shippedModules });
    const single = (await one.indexer.build(one.dir)).skipped.filter((d) => d.code === 'citation_comment_too_long');
    assert.equal(single.length, 1);
    assert.match(single[0]?.message ?? '', /^1 file has /);

    const none = await makeWorld(t, { files: { 'src/c.ts': '// see ADR-7\nexport const c = 1;\n' }, builtinDir: shippedModules });
    assert.deepEqual(
      (await none.indexer.build(none.dir)).skipped.filter((d) => d.code === 'citation_comment_too_long'),
      [],
    );
  });
});

describe('index exclusions (quick task 261021-re7, D-03): defaults and .atlasignore on Reconcile, ensureFresh and status', () => {
  const FILES = { ...THREE_FILES, '.atlasignore': 'b.toy\n' };
  const codes = (skipped: ReadonlyArray<{ code: string }>): string[] => skipped.map((d) => d.code).filter((c) => c.startsWith('index_excluded_by_') || c === 'atlasignore_unusable');

  it('a build indexes neither the files .atlasignore names nor an untracked file under a default, and reports both counts as pathless notes', async (t) => {
    const world = await makeWorld(t, { files: FILES });
    world.repo.write('node_modules/pkg/dep.toy', 'fn dependency {\n}\n');
    const result = await world.indexer.build(world.dir);

    assert.equal((await world.reader.find('helper')).data.length, 0, 'b.toy is named by .atlasignore');
    assert.equal((await world.reader.find('dependency')).data.length, 0, 'node_modules is a default');
    assert.equal((await world.reader.find('Widget')).data.length, 1, 'the rest is indexed');
    assert.equal((await world.reader.fileFacts('b.toy')).data, null);
    assert.equal((await world.reader.fileFacts('node_modules/pkg/dep.toy')).data, null);
    assert.deepEqual(codes(result.skipped), ['index_excluded_by_defaults', 'index_excluded_by_atlasignore']);
    for (const note of result.skipped.filter((d) => d.code.startsWith('index_excluded_by_'))) {
      assert.equal(note.subject, undefined);
      assert.equal(note.severity, 'info');
      assert.ok(!/toy|node_modules|pkg/.test(note.message), note.message);
    }
  });

  it('a start-up Reconcile records the counts in status().lastReconcile; a Reconcile before that records none', async (t) => {
    const world = await makeWorld(t, { files: FILES });
    world.repo.write('node_modules/pkg/dep.toy', 'fn dependency {\n}\n');
    assert.equal(world.indexer.status().lastReconcile, null);
    await world.indexer.start();
    assert.deepEqual(world.indexer.status().lastReconcile?.excluded, { byDefaults: 1, byAtlasignore: 1 });
  });

  it('adding a .atlasignore removes the facts of the files it names on the next Reconcile, and removing it brings them back', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);
    assert.equal((await world.reader.find('helper')).data.length, 1);

    world.repo.write('.atlasignore', 'b.toy\n');
    const hidden = await world.indexer.reconcile(world.dir);
    assert.equal(hidden.removed, 1);
    assert.equal((await world.reader.find('helper')).data.length, 0);
    assert.deepEqual(world.indexer.status().lastReconcile?.excluded, { byDefaults: 0, byAtlasignore: 1 });

    world.repo.remove('.atlasignore');
    const back = await world.indexer.reconcile(world.dir);
    assert.equal(back.changed, 1);
    assert.equal((await world.reader.find('helper')).data.length, 1);
    assert.deepEqual(world.indexer.status().lastReconcile?.excluded, { byDefaults: 0, byAtlasignore: 0 });
  });

  it('ensureFresh on an excluded path indexes nothing and the request is complete, not stale', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, { files: FILES, wrapTree: recordingTree(log) });
    await world.indexer.build(world.dir);
    world.repo.write('node_modules/pkg/dep.toy', 'fn dependency {\n}\n');
    world.repo.write('b.toy', 'fn helper_edited {\n}\n');

    const result = await world.indexer.ensureFresh(world.dir, ['node_modules/pkg/dep.toy', 'b.toy']);
    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.equal((await world.reader.find('dependency')).data.length, 0);
    assert.equal((await world.reader.find('helper_edited')).data.length, 0);
    assert.equal(log.hashPaths.flat().includes('b.toy'), false, 'an excluded path is never hashed');
    assert.equal(log.hashPaths.flat().includes('node_modules/pkg/dep.toy'), false);
  });

  it('a file event for an excluded path is dropped by the filter: nothing is hashed or indexed', async (t) => {
    const manual = createManualEventSource();
    const log = newLog();
    const world = await makeWorld(t, { files: FILES, source: manual.source, wrapTree: recordingTree(log) });
    await world.indexer.start();
    log.hashPaths.length = 0;
    world.repo.write('node_modules/pkg/dep.toy', 'fn dependency {\n}\n');
    world.repo.write('b.toy', 'fn helper_edited {\n}\n');
    world.repo.write('d.toy', 'fn kept_one {\n}\n');
    for (const rel of ['node_modules/pkg/dep.toy', 'b.toy', 'd.toy']) manual.emit(world.dir, rel);
    await world.clock.advance(debounceMs);
    await eventually(async () => (await world.reader.find('kept_one')).data.length === 1, 'the kept path to be indexed');
    assert.equal(log.hashPaths.flat().includes('b.toy'), false);
    assert.equal(log.hashPaths.flat().includes('node_modules/pkg/dep.toy'), false);
    assert.equal((await world.reader.find('dependency')).data.length, 0);
  });

  it('an unusable .atlasignore adds one warning to the notes and hides nothing', async (t) => {
    const world = await makeWorld(t, { files: { ...THREE_FILES, '.atlasignore': `b.toy\n${'#'.repeat(70000)}\n` } });
    const result = await world.indexer.build(world.dir);
    assert.deepEqual(codes(result.skipped), ['atlasignore_unusable']);
    assert.equal((await world.reader.find('helper')).data.length, 1);
  });
});
