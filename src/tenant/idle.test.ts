/**
 * Idle maintenance (STO-10, plan 02-28): the maintainer on its own, then the Tenant's round (leader, follower,
 * yielding, a failing step, no timer left behind) and the index-health gauge it records.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { WriterBusy } from '../fact-store/index.ts';
import type { FactStore, MaintenanceResult } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor, JobClass } from '../governor/index.ts';
import type { IndexHealthEvent, MetricsReport } from '../metrics/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { DEFAULT_TENANT_TUNING } from './index.ts';
import { createIdleMaintainer } from './idle.ts';
import {
  buildOk,
  captureStore,
  countingClock,
  eventually,
  find,
  makeTenantWorld,
  recordingMetrics,
  scriptedIndexers,
  settle,
  within,
} from './harness.test.ts';
import type { TenantWorld } from './harness.test.ts';

const IDLE = DEFAULT_TENANT_TUNING.idleAfterMs;
const SLICE = DEFAULT_TENANT_TUNING.maintenanceSliceMs;

describe('createIdleMaintainer', () => {
  it('touch arms one timer; another touch re-arms it, so only one is ever active', async () => {
    const fake = new FakeClock(0);
    const clock = countingClock(fake);
    let rounds = 0;
    const idle = createIdleMaintainer({ clock, idleAfterMs: 100, run: () => Promise.resolve(void (rounds += 1)), onError() {} });
    idle.touch();
    assert.equal(clock.active(), 1);
    await fake.advance(60);
    idle.touch();
    assert.equal(clock.active(), 1, 'the first timer was cancelled');
    await fake.advance(60);
    assert.equal(rounds, 0, 'the re-armed timer is not due yet');
    await fake.advance(40);
    await settle();
    assert.equal(rounds, 1);
    assert.equal(clock.active(), 0);
    await idle.close();
  });

  it('does not re-arm itself after a round; only the next touch does', async () => {
    const fake = new FakeClock(0);
    const clock = countingClock(fake);
    let rounds = 0;
    const idle = createIdleMaintainer({ clock, idleAfterMs: 100, run: () => Promise.resolve(void (rounds += 1)), onError() {} });
    idle.touch();
    await fake.advance(100);
    await settle();
    assert.equal(rounds, 1);
    await fake.advance(10_000);
    await settle();
    assert.equal(rounds, 1, 'no second round without a request');
    idle.touch();
    await fake.advance(100);
    await settle();
    assert.equal(rounds, 2);
    await idle.close();
  });

  it('a touch during a round makes shouldYield true and arms the timer once the round returns', async () => {
    const fake = new FakeClock(0);
    const clock = countingClock(fake);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: boolean[] = [];
    const idle = createIdleMaintainer({
      clock,
      idleAfterMs: 100,
      run: async (shouldYield) => {
        seen.push(shouldYield());
        await gate;
        seen.push(shouldYield());
      },
      onError() {},
    });
    idle.touch();
    await fake.advance(100);
    await settle();
    assert.deepEqual(seen, [false]);
    assert.equal(clock.active(), 0, 'no timer runs during a round');
    idle.touch();
    release();
    await eventually(() => seen.length === 2, 'the round to return');
    assert.deepEqual(seen, [false, true]);
    await settle();
    assert.equal(clock.active(), 1, 'the request re-armed the timer');
    await idle.close();
    assert.equal(clock.active(), 0);
  });

  it('close cancels a pending timer and waits for a round in flight', async () => {
    const fake = new FakeClock(0);
    const clock = countingClock(fake);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let yielded = false;
    const idle = createIdleMaintainer({
      clock,
      idleAfterMs: 100,
      run: async (shouldYield) => {
        await gate;
        yielded = shouldYield();
      },
      onError() {},
    });
    idle.touch();
    await idle.close();
    assert.equal(clock.active(), 0, 'a pending timer is cancelled');

    const second = createIdleMaintainer({
      clock,
      idleAfterMs: 100,
      run: async (shouldYield) => {
        await gate;
        yielded = shouldYield();
      },
      onError() {},
    });
    second.touch();
    await fake.advance(100);
    await settle();
    let closed = false;
    const closing = second.close().then(() => {
      closed = true;
    });
    await settle();
    assert.equal(closed, false, 'close waits for the round in flight');
    release();
    await within(closing, 'close');
    assert.equal(yielded, true, 'the round was asked to yield');
    second.touch();
    assert.equal(clock.active(), 0, 'a closed maintainer arms nothing');
  });

  it('a run that rejects calls onError and later touches still work', async () => {
    const fake = new FakeClock(0);
    const errors: unknown[] = [];
    let calls = 0;
    const idle = createIdleMaintainer({
      clock: fake,
      idleAfterMs: 100,
      run: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      onError: (error) => errors.push(error),
    });
    idle.touch();
    await fake.advance(100);
    await settle();
    assert.equal(errors.length, 1);
    idle.touch();
    await fake.advance(100);
    await settle();
    assert.equal(calls, 2);
    await idle.close();
  });
});

/** A repository whose store already indexes its worktree: a first tenant built it and went away. */
async function indexedWorld(t: TestContext): Promise<TenantWorld> {
  const world = await makeTenantWorld(t);
  const first = await world.open();
  await buildOk(first, world.repo);
  await first.close();
  return world;
}

/** The real Governor with a record of the class of every job it was given. */
function spyGovernor(): { readonly governor: Governor; readonly classes: JobClass[] } {
  const inner = createGovernor({ clock: systemClock });
  const classes: JobClass[] = [];
  const governor: Governor = {
    ...inner,
    run(job, fn) {
      classes.push(job.class);
      return inner.run(job, fn);
    },
  };
  return { governor, classes };
}

const done = (complete: boolean): MaintenanceResult => ({ complete, spentMs: 0, processed: 0 });

describe('Tenant idle round', () => {
  it('leader round: store.maintain in slices until complete, then refresh, rollup and the gauge, all at the maintenance class', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const clock = countingClock(fake);
    const scripted = scriptedIndexers({ start: 'now' });
    const rec = recordingMetrics();
    const spy = spyGovernor();
    const budgets: number[] = [];
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain(budgetMs) {
        budgets.push(budgetMs);
        scripted.log.push('maintain');
        return Promise.resolve(done(budgets.length >= 3));
      },
    }));
    const tenant = await open({ clock, indexerFactory: scripted.factory, openStore: capture.open, metrics: rec.metrics, governor: spy.governor });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    assert.equal((await tenant.handle(find('helper', repo.dir), repo.dir)).ok, true);
    assert.ok(clock.activeDelays().includes(IDLE), 'a request arms the idle timer');

    spy.classes.length = 0;
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');

    assert.deepEqual(budgets, [SLICE, SLICE, SLICE], 'store.maintain runs in slices of the approved length until it completes');
    assert.deepEqual(scripted.log, ['start', 'maintain', 'maintain', 'maintain', `refresh:${repo.dir}`]);
    assert.ok(rec.calls.includes('rollup'));
    const gauge = rec.events.at(-1);
    assert.equal(gauge?.kind, 'index_health', 'the gauge is the last thing the round records');
    assert.ok(spy.classes.length >= 4, 'every step went through the Governor');
    assert.ok(spy.classes.every((each) => each === 'maintenance'), `only maintenance jobs: ${spy.classes.join(',')}`);
    const status = await tenant.status();
    assert.equal(status.idle.lastRoundAt, fake.now());
  });

  it('follower round: no store.maintain and no Indexer.refresh, but the rollup and the gauge still happen', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const leader = await open();
    await buildOk(leader, repo);
    const fake = new FakeClock(1_000_000);
    const clock = countingClock(fake);
    const scripted = scriptedIndexers({ start: 'now' });
    const rec = recordingMetrics();
    let maintains = 0;
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain() {
        maintains += 1;
        return Promise.resolve(done(true));
      },
    }));
    const follower = await open({
      clock,
      indexerFactory: scripted.factory,
      openStore: capture.open,
      metrics: rec.metrics,
      tuning: { idleAfterMs: 5000 },
    });
    assert.equal((await follower.status()).leader, false);
    await follower.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(5000);
    await eventually(async () => (await follower.status()).idle.rounds === 1, 'the idle round to finish');

    assert.equal(maintains, 0);
    assert.equal(scripted.made.length, 0, 'a follower has no Indexer to refresh');
    assert.ok(rec.calls.includes('rollup'));
    assert.equal(rec.events.at(-1)?.kind, 'index_health');
  });

  it('yield: a request during store.maintain stops the round after the slice; the next quiet period runs it again from the start', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const clock = countingClock(fake);
    const scripted = scriptedIndexers({ start: 'now' });
    const rec = recordingMetrics();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const capture = captureStore((store): FactStore => ({
      ...store,
      async maintain() {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
          return done(false);
        }
        return done(true);
      },
    }));
    const tenant = await open({ clock, indexerFactory: scripted.factory, openStore: capture.open, metrics: rec.metrics });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    await tenant.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(IDLE);
    await within(inside, 'store.maintain to be entered');

    const during = await within(tenant.handle(find('helper', repo.dir), repo.dir), 'a request during the round');
    assert.equal(during.ok, true);
    release();
    await eventually(() => clock.activeDelays().includes(IDLE), 'the request to re-arm the idle timer');

    assert.equal(calls, 1, 'the round stopped after the slice it was in');
    assert.deepEqual(scripted.made[0]?.refreshes, [], 'no refresh after a yield');
    assert.equal(rec.calls.includes('rollup'), false, 'no rollup after a yield');
    assert.equal(rec.events.some((event) => event.kind === 'index_health'), false, 'no gauge after a yield');
    assert.equal((await tenant.status()).idle.rounds, 0, 'a round that yielded is not a finished round');

    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the second round to finish');
    assert.equal(calls, 2, 'the round starts again from the first step');
    assert.deepEqual(scripted.made[0]?.refreshes, [repo.dir]);
    assert.ok(rec.calls.includes('rollup'));
    assert.equal(rec.events.at(-1)?.kind, 'index_health');
  });

  it('failing step: a store.maintain that throws is swallowed and the rollup and the gauge still run', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const scripted = scriptedIndexers({ start: 'now' });
    const rec = recordingMetrics();
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain: () => Promise.reject(new Error('maintain failed')),
    }));
    const tenant = await open({ clock: fake, indexerFactory: scripted.factory, openStore: capture.open, metrics: rec.metrics });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    await tenant.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');

    assert.deepEqual(scripted.made[0]?.refreshes, [repo.dir], 'the next step still ran');
    assert.ok(rec.calls.includes('rollup'));
    assert.equal(rec.events.at(-1)?.kind, 'index_health');
    assert.equal((await tenant.status()).idle.failedSteps, 1);
  });

  it('a store.maintain that finds the writer slot taken falls back to collect and compact slices, and that is not a failure', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const scripted = scriptedIndexers({ start: 'now' });
    const rec = recordingMetrics();
    const seen: string[] = [];
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain: () => Promise.reject(new WriterBusy()),
      async collect(options) {
        seen.push('collect');
        return store.collect(options);
      },
      async compact(options) {
        seen.push('compact');
        return store.compact(options);
      },
    }));
    const tenant = await open({ clock: fake, indexerFactory: scripted.factory, openStore: capture.open, metrics: rec.metrics });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    await tenant.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');
    assert.deepEqual(seen.slice(0, 2), ['collect', 'compact']);
    assert.equal((await tenant.status()).idle.failedSteps, 0);
    assert.deepEqual(scripted.made[0]?.refreshes, [repo.dir]);
  });

  it('no timer: nothing is armed after a round without a request, and close leaves none', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const clock = countingClock(fake);
    const scripted = scriptedIndexers({ start: 'now' });
    const rec = recordingMetrics();
    const tenant = await open({ clock, indexerFactory: scripted.factory, metrics: rec.metrics });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    assert.equal(clock.active(), 0, 'nothing is armed before the first request');
    await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(clock.active(), 1);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');
    await settle();
    // The store's own dirty-sentinel timer may still be pending after upkeep wrote (it goes at close); the idle timer is not.
    assert.equal(clock.activeDelays().includes(IDLE), false, 'the round does not re-arm itself');
    await fake.advance(10 * IDLE);
    await settle();
    assert.equal((await tenant.status()).idle.rounds, 1);

    await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(clock.activeDelays().filter((ms) => ms === IDLE).length, 1);
    await tenant.close();
    assert.equal(clock.active(), 0, 'close cancels the idle timer');
  });

  it('two rounds back to back leave the stored facts unchanged and fail nothing', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const tenant = await open({ clock: fake });
    await eventually(async () => (await tenant.status()).startup === 'ready', 'the start-up Reconcile');
    await tenant.handle(find('helper', repo.dir), repo.dir);
    const before = (await tenant.status()).store.worktrees;

    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the first round');
    const afterOne = (await tenant.status()).store.worktrees;
    await tenant.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 2, 'the second round');
    const afterTwo = (await tenant.status()).store.worktrees;

    assert.deepEqual(afterOne, before);
    assert.deepEqual(afterTwo, before);
    assert.equal((await tenant.status()).idle.failedSteps, 0);
    const answer = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(answer.ok, true);
    assert.equal((answer.data as { results: unknown[] }).results.length, 1);
  });
});

describe('index-health gauge', () => {
  it('gauge: reports the file, error and stale counts and the store size, read back through the Metrics report', async (t) => {
    const { repo, open } = await indexedWorld(t);
    // The first tenant recorded a gauge at real time; this clock starts there so the newest gauge is the one under test.
    const fake = new FakeClock(Date.now());
    const scripted = scriptedIndexers({ start: 'now' });
    const capture = captureStore();
    const tenant = await open({ clock: fake, indexerFactory: scripted.factory, openStore: capture.open });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    scripted.made[0]?.failed.push({ worktree: repo.dir, path: 'a.toy', code: 'parse_timeout' });

    const health = async (): Promise<MetricsReport['indexHealth']> => {
      const reply = await tenant.statusEnvelope(3_600_000);
      return (reply.data as { report: MetricsReport }).report.indexHealth;
    };

    await tenant.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the first round');
    const first = await health();
    assert.equal(first?.files, 3);
    assert.equal(first?.errorFiles, 1);
    assert.equal(first?.staleFiles, 0);
    assert.ok((first?.sizeBytes ?? 0) > 0);

    // A second overlay with one path whose facts do not exist yet: one more file, and it is stale.
    const store = capture.store();
    assert.ok(store);
    const writer = store.writer();
    await writer.setOverlay('/elsewhere/wt', 'refs/heads/x', new Map([['p.toy', 'f'.repeat(40)]]));
    writer.release();
    await tenant.handle(find('helper', repo.dir), repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 2, 'the second round');
    const second = await health();
    assert.equal(second?.files, 4);
    assert.equal(second?.errorFiles, 1);
    assert.equal(second?.staleFiles, 1);
  });

  it('a successful build records the gauge once', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const rec = recordingMetrics();
    const tenant = await open({ metrics: rec.metrics });
    await buildOk(tenant, repo);
    const gauges = rec.events.filter((event): event is IndexHealthEvent => event.kind === 'index_health');
    assert.equal(gauges.length, 1);
    assert.equal(gauges[0]?.files, 3);
    assert.equal(gauges[0]?.errorFiles, 0);
    assert.ok((gauges[0]?.sizeBytes ?? 0) > 0);
  });
});
