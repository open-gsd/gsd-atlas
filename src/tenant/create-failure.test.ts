/**
 * A Tenant that fails to be built releases what it opened (IN-10, T-02-123), and a store that closed itself
 * becomes a `store_unavailable` envelope instead of an `internal_error` out of the Host (plan 02-40).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StoreClosed, openFactStore } from '../fact-store/index.ts';
import type { FactStore, Resolver } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { createNoopMetrics } from '../metrics/index.ts';
import type { Metrics } from '../metrics/index.ts';
import { captureStore, find, makeTenantWorld } from './harness.test.ts';

const noResolver: Resolver = async function* () {
  // resolves nothing
};

const codeOf = (envelope: Envelope): string | undefined => envelope.diagnostics?.[0]?.code;

describe('createTenant failure', () => {
  it('store closed when status throws', async (t) => {
    const world = await makeTenantWorld(t);
    let closes = 0;
    let metricsCloses = 0;
    let statusCalls = 0;
    const metrics: Metrics = {
      ...createNoopMetrics('counting'),
      close() {
        metricsCloses += 1;
        return Promise.resolve();
      },
    };
    const capture = captureStore((store): FactStore => ({
      ...store,
      status() {
        statusCalls += 1;
        return Promise.reject(new Error('first status failed'));
      },
      close() {
        closes += 1;
        return store.close();
      },
    }));
    await assert.rejects(world.open({ openStore: capture.open, metrics }), /first status failed/, 'the original error is rethrown');
    assert.equal(statusCalls, 1);
    assert.equal(closes, 1, 'the store was closed exactly once');
    assert.equal(metricsCloses, 1, 'and so was the Metrics instance');

    // The lease is free: a second store on the directory becomes the leader.
    const second = await openFactStore(world.storeDir, { resolver: noResolver, clock: systemClock, gitHas: async () => true }, { lease: 'acquire' });
    try {
      assert.equal((await second.status()).writerLeaseHeld, true, 'nothing strands the writer lease');
    } finally {
      await second.close();
    }
  });

  it('closes the store when a step in the middle of construction throws', async (t) => {
    const world = await makeTenantWorld(t);
    let closes = 0;
    let metricsCloses = 0;
    const metrics: Metrics = {
      ...createNoopMetrics('counting'),
      close() {
        metricsCloses += 1;
        return Promise.resolve();
      },
    };
    const capture = captureStore((store): FactStore => ({
      ...store,
      close() {
        closes += 1;
        return store.close();
      },
    }));
    // Spreading these settings (to build the follower overlay) throws, after the store and the Metrics were opened.
    const indexer = {};
    Object.defineProperty(indexer, 'maxRaceRetries', {
      enumerable: true,
      get() {
        throw new Error('settings failed');
      },
    });
    await assert.rejects(world.open({ openStore: capture.open, metrics, indexer }), /settings failed/);
    assert.equal(closes, 1);
    assert.equal(metricsCloses, 1);
    const second = await openFactStore(world.storeDir, { resolver: noResolver, clock: systemClock, gitHas: async () => true }, { lease: 'acquire' });
    try {
      assert.equal((await second.status()).writerLeaseHeld, true);
    } finally {
      await second.close();
    }
  });

  it('store unavailable', async (t) => {
    const world = await makeTenantWorld(t);
    let broken = false;
    const gone = (): never => {
      throw new StoreClosed();
    };
    const capture = captureStore((store): FactStore => ({
      ...store,
      at: (worktree) => (broken ? gone() : store.at(worktree)),
      status: () => (broken ? Promise.reject(new StoreClosed()) : store.status()),
      collect: (options) => (broken ? Promise.reject(new StoreClosed()) : store.collect(options)),
      compact: (options) => (broken ? Promise.reject(new StoreClosed()) : store.compact(options)),
      check: () => (broken ? Promise.reject(new StoreClosed()) : store.check()),
    }));
    const tenant = await world.open({ openStore: capture.open, metrics: false });
    broken = true;

    const handled = await tenant.handle(find('helper', world.repo.dir), world.repo.dir);
    assert.equal(codeOf(handled), 'store_unavailable', 'handle');
    assert.equal(codeOf(await tenant.build(world.repo.dir)), 'store_unavailable', 'build');
    assert.equal(codeOf(await tenant.maintain('collect', { worktree: world.repo.dir })), 'store_unavailable', 'maintain');
    assert.equal(codeOf(await tenant.statusEnvelope(60_000)), 'store_unavailable', 'statusEnvelope');
    for (const reply of [handled, await tenant.build(world.repo.dir)]) {
      assert.notEqual(codeOf(reply), 'internal_error');
    }
    broken = false;
  });
});
