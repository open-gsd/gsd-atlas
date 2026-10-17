import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { IndexerError } from '../indexer/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { DEFAULT_TENANT_TUNING } from './index.ts';
import type { Tenant } from './index.ts';
import {
  buildOk,
  countingClock,
  eventually,
  find,
  makeTenantWorld,
  scriptedIndexers,
  settle,
  within,
} from './harness.test.ts';
import type { TenantWorld } from './harness.test.ts';

const DEADLINE = DEFAULT_TENANT_TUNING.startupReconcileDeadlineMs;

/** A repository whose store already indexes its worktree: a first tenant built it and went away. */
async function indexedWorld(t: TestContext): Promise<TenantWorld> {
  const world = await makeTenantWorld(t);
  const first = await world.open();
  await buildOk(first, world.repo);
  await first.close();
  return world;
}

const reconciling = (reply: { readonly degraded?: readonly string[] }): boolean => reply.degraded?.includes('reconciling') ?? false;

/** Wait until the scripted Indexer has been asked to start. */
const started = (scripted: ReturnType<typeof scriptedIndexers>) =>
  eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer to be started');

describe('start-up Reconcile deadline', () => {
  it('reconciling: the first request waits for the approved deadline, then is answered degraded; the code stays until start settles', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const fake = new FakeClock(1_000_000);
    const clock = countingClock(fake);
    const scripted = scriptedIndexers();
    const tenant = await open({ clock, indexerFactory: scripted.factory });
    assert.equal((await tenant.status()).startup, 'pending');
    await started(scripted);
    assert.deepEqual(scripted.made[0]?.starts[0], [repo.dir], 'start covers exactly the worktrees the store indexes');

    let settled = false;
    const first = tenant.handle(find('helper', repo.dir), repo.dir).then((reply) => {
      settled = true;
      return reply;
    });
    await settle();
    assert.equal(settled, false, 'the answer waits while start is pending and the deadline has not passed');
    assert.ok(clock.activeDelays().includes(DEADLINE), 'the wait is a Clock.after timer of the approved length');

    await fake.advance(DEADLINE);
    const answer = await within(first, 'the first answer');
    assert.equal(answer.ok, true, JSON.stringify(answer.diagnostics));
    assert.ok(reconciling(answer), 'the answer says the index is still catching up');

    // A second request while start is still pending does not wait again.
    const second = await within(tenant.handle(find('helper', repo.dir), repo.dir), 'the second answer');
    assert.ok(reconciling(second));
    assert.equal(clock.activeDelays().filter((ms) => ms === DEADLINE).length, 0);

    scripted.releaseStart();
    await eventually(async () => (await tenant.status()).startup === 'ready', 'start-up to be ready');
    const third = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(third.ok, true);
    assert.equal(reconciling(third), false, 'reconciling ends with the start-up');
  });

  it('start finishing first answers without reconciling and cancels the deadline timer', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const clock = countingClock(new FakeClock(1_000_000));
    const scripted = scriptedIndexers();
    const tenant = await open({ clock, indexerFactory: scripted.factory });
    await started(scripted);

    const pending = tenant.handle(find('helper', repo.dir), repo.dir);
    await settle();
    assert.ok(clock.activeDelays().includes(DEADLINE));
    scripted.releaseStart();
    const answer = await within(pending, 'the answer');
    assert.equal(answer.ok, true);
    assert.equal(reconciling(answer), false);
    assert.equal(clock.activeDelays().includes(DEADLINE), false, 'the cancelled timer leaves nothing pending');
  });

  it('a repository with no indexed worktree starts no Indexer, answers not_indexed at once and arms no deadline', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const clock = countingClock(new FakeClock(1_000_000));
    const scripted = scriptedIndexers();
    const tenant = await open({ clock, indexerFactory: scripted.factory });
    assert.equal((await tenant.status()).startup, 'none');
    const answer = await within(tenant.handle(find('helper', repo.dir), repo.dir), 'the answer');
    assert.deepEqual(
      answer.diagnostics.map((d) => d.code),
      ['not_indexed'],
    );
    assert.equal(scripted.made.length, 0, 'no Indexer was even created');
    assert.equal(clock.armed.includes(DEADLINE), false);
  });

  it('after a build the worktree is attached and later answers carry no reconciling', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const clock = countingClock(new FakeClock(1_000_000));
    const tenant = await open({ clock });
    assert.equal((await tenant.status()).startup, 'none');
    await buildOk(tenant, repo);
    const answer = await within(tenant.handle(find('helper', repo.dir), repo.dir), 'the answer');
    assert.equal(answer.ok, true, JSON.stringify(answer.diagnostics));
    assert.equal(reconciling(answer), false);
    assert.equal(clock.armed.includes(DEADLINE), false);
  });

  it('a start that rejects is swallowed with its code and reconciling does not stick', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const clock = countingClock(new FakeClock(1_000_000));
    const scripted = scriptedIndexers();
    const tenant = await open({ clock, indexerFactory: scripted.factory });
    await started(scripted);

    const pending = tenant.handle(find('helper', repo.dir), repo.dir);
    scripted.releaseStart(new IndexerError('lease_held', 'another holder has the writer'));
    const answer = await within(pending, 'the answer');
    assert.equal(answer.ok, true, 'the answer is served from the store');
    assert.equal(reconciling(answer), false);
    const status = await tenant.status();
    assert.equal(status.startup, 'ready');
    assert.equal(status.startError, 'lease_held');
  });

  it('close while the start-up is pending and an answer waits leaves no timer', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const clock = countingClock(new FakeClock(1_000_000));
    const scripted = scriptedIndexers();
    const tenant: Tenant = await open({ clock, indexerFactory: scripted.factory });
    await started(scripted);
    const pending = tenant.handle(find('helper', repo.dir), repo.dir);
    await settle();
    await within(tenant.close(), 'close');
    await within(pending, 'the waiting answer');
    assert.equal(clock.active(), 0, 'no deadline, metrics or idle timer survives close');
  });
});
