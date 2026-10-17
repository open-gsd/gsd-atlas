import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { FakeClock } from '../test-kit/index.ts';
import { DEFAULT_TENANT_TUNING } from './index.ts';
import {
  buildOk,
  captureStore,
  countingClock,
  eventually,
  find,
  makeTenantWorld,
  scriptedIndexers,
  settle,
  within,
} from './harness.test.ts';
import type { TenantWorld } from './harness.test.ts';

const has = (reply: { readonly degraded?: readonly string[] }, code: string): boolean => reply.degraded?.includes(code) ?? false;

/** A repository whose store already indexes its worktree: a first tenant built it and went away. */
async function indexedWorld(t: TestContext): Promise<TenantWorld> {
  const world = await makeTenantWorld(t);
  const first = await world.open();
  await buildOk(first, world.repo);
  await first.close();
  return world;
}

describe('follower takeover (STO-08)', () => {
  it('takeover: a follower becomes the leader without a restart and starts indexing the worktrees the store indexes', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const leader = await open();
    await buildOk(leader, repo);

    const fake = new FakeClock(1_000_000);
    const clock = countingClock(fake);
    const capture = captureStore();
    const scripted = scriptedIndexers({ start: 'now' });
    const follower = await open({ clock, indexerFactory: scripted.factory, openStore: capture.open });

    assert.deepEqual(capture.takeover(), {
      retryMinMs: DEFAULT_TENANT_TUNING.takeoverRetryMinMs,
      retryMaxMs: DEFAULT_TENANT_TUNING.takeoverRetryMaxMs,
    });
    assert.equal(typeof capture.handler(), 'function', 'the Tenant listens for lease changes');
    assert.equal((await follower.status()).leader, false);
    const before = await follower.handle(find('helper', repo.dir), repo.dir);
    assert.ok(has(before, 'follower'));
    assert.equal(scripted.made.length, 0, 'a follower creates no Indexer');
    assert.deepEqual(
      (await follower.build(repo.dir)).diagnostics.map((d) => d.code),
      ['lease_held'],
    );

    await leader.close();
    await fake.advance(DEFAULT_TENANT_TUNING.takeoverRetryMaxMs);
    await eventually(async () => (await follower.status()).leader, 'the follower to take the lease');
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the new leader to start its Indexer');
    assert.deepEqual(scripted.made[0]?.starts[0], [repo.dir]);
    assert.equal(scripted.made.length, 1);

    const built = await follower.build(repo.dir);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.deepEqual(scripted.made[0]?.builds, [repo.dir]);
    const after = await follower.handle(find('helper', repo.dir), repo.dir);
    assert.equal(after.ok, true);
    assert.equal(has(after, 'follower'), false, 'the follower code is gone');
    const maintained = await follower.maintain('check', { worktree: repo.dir });
    assert.equal(maintained.ok, true, JSON.stringify(maintained.diagnostics));
  });

  it('takeover: the new leader serves an edit made afterwards once fresh paths are requested', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const leader = await open();
    await buildOk(leader, repo);
    const follower = await open({ tuning: { takeoverRetryMinMs: 20, takeoverRetryMaxMs: 40 } });
    assert.equal((await follower.status()).leader, false);

    await leader.close();
    await eventually(async () => (await follower.status()).leader, 'the follower to take the lease');
    await eventually(async () => (await follower.status()).indexer !== null, 'the new leader to create its Indexer');

    writeFileSync(path.join(repo.dir, 'b.toy'), 'fn helper_two {\n}\n');
    const found = await follower.handle(find('helper_two', repo.dir, { fresh: ['b.toy'] }), repo.dir);
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as { results: unknown[] }).results.length, 1);
    assert.equal(has(found, 'fresh_timeout'), false);
    assert.equal(has(found, 'follower'), false);
  });

  it('lease lost: the Indexer is stopped once and the Tenant behaves as a follower; regaining the lease starts it again', async (t) => {
    const { repo, open } = await indexedWorld(t);
    const capture = captureStore();
    const scripted = scriptedIndexers({ start: 'now' });
    const tenant = await open({ indexerFactory: scripted.factory, openStore: capture.open });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    const handler = capture.handler();
    assert.ok(handler);

    handler(false);
    await eventually(() => scripted.made[0]?.stops === 1, 'the Indexer to be stopped');
    await settle();
    assert.equal(scripted.made[0]?.stops, 1, 'stopped exactly once');
    assert.equal((await tenant.status()).leader, false);
    assert.deepEqual(
      (await tenant.build(repo.dir)).diagnostics.map((d) => d.code),
      ['lease_held'],
    );
    assert.deepEqual(
      (await tenant.maintain('check', { worktree: repo.dir })).diagnostics.map((d) => d.code),
      ['lease_held'],
    );

    handler(true);
    await eventually(() => scripted.made[1]?.starts.length === 1, 'the Indexer to start again');
    assert.deepEqual(scripted.made[1]?.starts[0], [repo.dir]);
    assert.equal((await tenant.status()).leader, true);
    const built = await tenant.build(repo.dir);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  });

  it('takeover twice in a row starts one Indexer: a lease gain while it runs does nothing', async (t) => {
    const { open } = await indexedWorld(t);
    const capture = captureStore();
    const scripted = scriptedIndexers({ start: 'now' });
    await open({ indexerFactory: scripted.factory, openStore: capture.open });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    capture.handler()?.(true);
    capture.handler()?.(true);
    await settle(20);
    assert.equal(scripted.made.length, 1);
    assert.equal(scripted.made[0]?.starts.length, 1);
  });

  it('close: a lease change delivered after close starts nothing and leaves no timer', async (t) => {
    const { open } = await indexedWorld(t);
    const clock = countingClock(new FakeClock(1_000_000));
    const capture = captureStore();
    const scripted = scriptedIndexers({ start: 'now' });
    const tenant = await open({ clock, indexerFactory: scripted.factory, openStore: capture.open });
    await eventually(() => scripted.made[0]?.starts.length === 1, 'the start-up Indexer');
    await tenant.close();

    capture.handler()?.(true);
    capture.handler()?.(false);
    await settle(20);
    assert.equal(scripted.made.length, 1, 'no Indexer was made after close');
    assert.equal(scripted.made[0]?.starts.length, 1);
    assert.equal(clock.active(), 0);
  });

  it('close: a lease change racing close neither starts an Indexer nor leaves a timer', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const leader = await open();
    await buildOk(leader, repo);
    const clock = countingClock(new FakeClock(1_000_000));
    const capture = captureStore();
    const scripted = scriptedIndexers({ start: 'now' });
    const follower = await open({ clock, indexerFactory: scripted.factory, openStore: capture.open });
    assert.equal(clock.active() > 0, true, 'the follower has its takeover retry armed');

    const closing = follower.close();
    capture.handler()?.(true);
    await within(closing, 'close');
    await settle(20);
    assert.equal(scripted.made.length, 0, 'nothing was started in a closed Tenant');
    assert.equal(clock.active(), 0, 'close cancelled the takeover retry and everything else');
  });
});
