/**
 * The Tenant's idle loop keeps the store within the approved bound by itself (STO-05, D-16, plan 02-40): it asks the
 * Fact Store for the idle policy (`IDLE_MAINTENANCE`), the store vacuums only past the recorded thresholds, and a
 * healthy store is never vacuumed. Real store on a real temporary repository, a fake clock, the real Governor.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { generatedFacts, generatedHash, generatedPath } from '../../scripts/test-helpers/store-facts.ts';
import { WriterBusy, openFactStore } from '../fact-store/index.ts';
import type { CheckResult, FactStore, MaintenanceOptions, MaintenanceResult, Resolver, StoreMaintainOptions } from '../fact-store/index.ts';
// The VACUUM counter is a test hook of the store's lifecycle module, deliberately not part of the public Fact Store
// surface (plan 02-30). This one test-only import is the single exception to the D-12 deep-import rule.
// eslint-disable-next-line no-restricted-imports
import { lifecycleTestHooks, resetLifecycleTestHooks } from '../fact-store/lifecycle.ts';
import { FakeClock } from '../test-kit/index.ts';
import { DEFAULT_TENANT_TUNING } from './index.ts';
import { buildOk, captureStore, eventually, find, makeTenantWorld, recordingMetrics, settle, within } from './harness.test.ts';

const IDLE = DEFAULT_TENANT_TUNING.idleAfterMs;
const SLICE = DEFAULT_TENANT_TUNING.maintenanceSliceMs;

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

afterEach(() => {
  resetLifecycleTestHooks();
});

const done = (complete: boolean): MaintenanceResult => ({ complete, spentMs: 0, processed: 0 });

/** Count the full VACUUMs any store of this process runs. */
function countVacuums(): { count: number } {
  const seen = { count: 0 };
  lifecycleTestHooks.onVacuum = () => {
    seen.count += 1;
  };
  return seen;
}

/**
 * Write a store into `dir` the way plan 02-18's fixture does: `files` generated files in worktree `main`, then
 * `edits` seeded-random re-commits (each retires a version), then a collect. `edits` of 0 is a freshly built store.
 */
async function seedStore(dir: string, files: number, edits: number): Promise<void> {
  const clock = new FakeClock(1000);
  const store = await openFactStore(dir, { resolver: noResolver, clock, gitHas: async () => true }, { lease: 'acquire', version: '9.9.9' });
  try {
    const writer = store.writer();
    for (let index = 0; index < files; index += 1) {
      await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash: generatedHash(index), facts: generatedFacts(index) });
    }
    const versions = new Array<number>(files).fill(0);
    let state = 7;
    for (let edit = 0; edit < edits; edit += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const index = state % files;
      versions[index] = (versions[index] ?? 0) + 1;
      const hash = generatedHash(1000 + (versions[index] ?? 0) * files + index);
      await writer.commitFile({ worktree: 'main', path: generatedPath(index), hash, facts: { ...generatedFacts(index), contentHash: hash } });
    }
    writer.release();
    await store.maintain(60_000); // collect and compact, no request for a full compaction: the file stays fragmented
  } finally {
    await store.close();
  }
}

describe('Tenant idle loop asks for the idle policy (STO-05)', () => {
  it('calls maintain with the idle policy', async (t) => {
    const world = await makeTenantWorld(t);
    await seedStore(world.storeDir, 20, 0);
    const fake = new FakeClock(1_000_000);
    const rec = recordingMetrics();
    const calls: Array<{ budgetMs: number; options: StoreMaintainOptions | undefined }> = [];
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain(budgetMs, options) {
        calls.push({ budgetMs, options });
        return Promise.resolve(done(true));
      },
    }));
    const tenant = await world.open({ clock: fake, openStore: capture.open, metrics: rec.metrics });
    await tenant.handle(find('sym0', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.budgetMs, SLICE);
    assert.deepEqual(calls[0]?.options, { full: true });
  });

  it('writer busy fallback', async (t) => {
    const world = await makeTenantWorld(t);
    await seedStore(world.storeDir, 20, 0);
    const fake = new FakeClock(1_000_000);
    const rec = recordingMetrics();
    const log: string[] = [];
    const compacts: MaintenanceOptions[] = [];
    let collects = 0;
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain: () => Promise.reject(new WriterBusy()),
      collect() {
        collects += 1;
        log.push(collects === 1 ? 'collect:incomplete' : 'collect:complete');
        return Promise.resolve(done(collects > 1));
      },
      compact(options) {
        compacts.push(options);
        log.push(options.full === true ? 'compact:full' : 'compact');
        return Promise.resolve(done(true));
      },
      check(): Promise<CheckResult> {
        log.push('check');
        return Promise.resolve({ ok: true, problems: [] });
      },
    }));
    const tenant = await world.open({ clock: fake, openStore: capture.open, metrics: rec.metrics });
    await tenant.handle(find('sym0', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');
    assert.deepEqual(log, ['collect:incomplete', 'compact', 'collect:complete', 'compact:full', 'check']);
    assert.deepEqual(compacts, [{ budgetMs: SLICE }, { budgetMs: SLICE, full: true }]);
    assert.equal((await tenant.status()).idle.failedSteps, 0, 'a busy writer slot is not a failure');
  });

  it('vacuums a fragmented store once', async (t) => {
    const world = await makeTenantWorld(t);
    await seedStore(world.storeDir, 300, 1500);
    const vacuums = countVacuums();
    const fake = new FakeClock(1_000_000);
    const rec = recordingMetrics();
    const tenant = await world.open({ clock: fake, metrics: rec.metrics });
    const before = (await tenant.status()).store.sizeBytes;
    await tenant.handle(find('sym0', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');
    assert.equal(vacuums.count, 1, 'exactly one VACUUM');
    const after = (await tenant.status()).store.sizeBytes;
    assert.ok(after < before, `the file got smaller (${String(before)} to ${String(after)} bytes)`);

    await tenant.handle(find('sym0', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 2, 'the second idle round to finish');
    assert.equal(vacuums.count, 1, 'a second quiet period does not vacuum again');
  });

  it('healthy store is left alone', async (t) => {
    const world = await makeTenantWorld(t);
    await seedStore(world.storeDir, 300, 0);
    const vacuums = countVacuums();
    const fake = new FakeClock(1_000_000);
    const rec = recordingMetrics();
    const tenant = await world.open({ clock: fake, metrics: rec.metrics });
    await tenant.handle(find('sym0', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the idle round to finish');
    assert.equal(vacuums.count, 0);
  });

  it('maintain request: compact vacuums only when full is asked for', async (t) => {
    const world = await makeTenantWorld(t);
    await seedStore(world.storeDir, 300, 1500);
    const vacuums = countVacuums();
    const tenant = await world.open({ clock: new FakeClock(1_000_000), metrics: false });
    const plain = await tenant.maintain('compact', { worktree: world.repo.dir });
    assert.equal(plain.ok, true);
    assert.equal(vacuums.count, 0, 'the maintain request path is unchanged: no full without the option');
    const full = await tenant.maintain('compact', { worktree: world.repo.dir, full: true });
    assert.equal(full.ok, true);
    assert.equal(vacuums.count, 1, 'and one VACUUM with it');
  });

  it('follower', async (t) => {
    const world = await makeTenantWorld(t);
    const leader = await world.open({ metrics: false });
    await buildOk(leader, world.repo);
    const vacuums = countVacuums();
    const fake = new FakeClock(1_000_000);
    const rec = recordingMetrics();
    const steps: string[] = [];
    const capture = captureStore((store): FactStore => ({
      ...store,
      maintain() {
        steps.push('maintain');
        return Promise.resolve(done(true));
      },
      collect(options) {
        steps.push('collect');
        return store.collect(options);
      },
      compact(options) {
        steps.push('compact');
        return store.compact(options);
      },
    }));
    const follower = await world.open({ clock: fake, openStore: capture.open, metrics: rec.metrics });
    assert.equal((await follower.status()).leader, false);
    await follower.handle(find('helper', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await eventually(async () => (await follower.status()).idle.rounds === 1, 'the idle round to finish');
    assert.deepEqual(steps, [], 'a follower runs no store maintenance');
    assert.equal(vacuums.count, 0, 'and never vacuums');
  });

  it('yield', async (t) => {
    const world = await makeTenantWorld(t);
    await seedStore(world.storeDir, 300, 1500);
    const vacuums = countVacuums();
    const fake = new FakeClock(1_000_000);
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
      async maintain(budgetMs, options) {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
          return done(false); // a slice that did not finish: the round would go on, but a request has arrived
        }
        return store.maintain(budgetMs, options);
      },
    }));
    const tenant = await world.open({ clock: fake, openStore: capture.open, metrics: rec.metrics });
    await tenant.handle(find('sym0', world.repo.dir), world.repo.dir);
    await fake.advance(IDLE);
    await within(inside, 'store.maintain to be entered');

    await within(tenant.handle(find('sym0', world.repo.dir), world.repo.dir), 'a request during the round');
    release();
    await settle(20);
    assert.equal((await tenant.status()).idle.rounds, 0, 'a round that yielded is not a finished round');
    assert.equal(calls, 1, 'no slice started after the request');
    assert.equal(vacuums.count, 0, 'and no VACUUM ran while a request was being answered');

    await fake.advance(IDLE);
    await eventually(async () => (await tenant.status()).idle.rounds === 1, 'the next quiet period to finish a round');
    assert.equal(vacuums.count, 1, 'the next quiet period vacuums, the store being still due');
  });
});
