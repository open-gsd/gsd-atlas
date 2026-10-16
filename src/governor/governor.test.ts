import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Clock } from '../facts/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { defineGovernorContract, defineGovernorSchedulingContract, deferred, job, mustLease } from './contract.ts';
import { createFakeGovernor, createGovernor, createNoopGovernor } from './index.ts';

defineGovernorContract('noop', () => createNoopGovernor());
defineGovernorContract('fake', () => createFakeGovernor({ clock: new FakeClock() }));
defineGovernorContract('real', () => createGovernor({ clock: new FakeClock() }));

defineGovernorSchedulingContract('fake', (options) => {
  const clock = new FakeClock();
  return { governor: createFakeGovernor({ clock, ...options }), clock };
});

defineGovernorSchedulingContract('real', ({ concurrency, maxQueue, busyRetryMs, memoryBudgetBytes }) => {
  const clock = new FakeClock();
  const governor = createGovernor({
    clock,
    concurrency,
    maxQueue: { interactive: maxQueue, fresh: maxQueue, indexing: maxQueue, maintenance: maxQueue },
    busyRetryMs: { interactive: busyRetryMs, fresh: busyRetryMs, indexing: busyRetryMs, maintenance: busyRetryMs },
    memoryBudgetBytes,
  });
  return { governor, clock };
});

/** Wraps a clock and counts the `after` timers that are still pending. */
class TimerCountingClock implements Clock {
  live = 0;
  readonly #inner: FakeClock;

  constructor(inner: FakeClock) {
    this.#inner = inner;
  }

  now(): number {
    return this.#inner.now();
  }

  sleep(ms: number): Promise<void> {
    return this.#inner.sleep(ms);
  }

  after(ms: number, fn: () => void): () => void {
    this.live += 1;
    let pending = true;
    const settle = (): boolean => {
      if (!pending) {
        return false;
      }
      pending = false;
      this.live -= 1;
      return true;
    };
    const cancel = this.#inner.after(ms, () => {
      if (settle()) {
        fn();
      }
    });
    return () => {
      if (settle()) {
        cancel();
      }
    };
  }
}

describe('noop Governor', () => {
  it('never returns busy and never aborts the signal', async () => {
    const governor = createNoopGovernor();
    const gate = deferred();
    const signals: AbortSignal[] = [];
    const pending = Array.from({ length: 20 }, () =>
      governor.run(job('maintenance'), async (signal) => {
        signals.push(signal);
        await gate.promise;
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(governor.status().running, 20);
    gate.resolve();
    const results = await Promise.all(pending);
    assert.ok(results.every((r) => r.kind === 'ok'));
    assert.ok(signals.every((s) => !s.aborted));
  });

  it('grants every lease and never evicts', async () => {
    const governor = createNoopGovernor();
    let evicted = 0;
    const a = mustLease(await governor.lease({ tenant: 'a', fileSetId: 'x' }, 10 ** 12, () => void (evicted += 1)));
    const b = mustLease(await governor.lease({ tenant: 'b', fileSetId: 'y' }, 10 ** 12, () => void (evicted += 1)));
    assert.equal(governor.status().leases, 2);
    a.release();
    b.release();
    assert.equal(governor.status().leases, 0);
    assert.equal(evicted, 0);
  });
});

describe('real Governor: job timers', () => {
  it('leaves no live timer after a job with a timeoutMs completes normally', async () => {
    const clock = new TimerCountingClock(new FakeClock());
    const governor = createGovernor({ clock });
    const result = await governor.run(job('interactive', { timeoutMs: 1000 }), async () => 'done');
    assert.deepEqual(result, { kind: 'ok', value: 'done' });
    assert.equal(clock.live, 0);
  });

  it('leaves no live timer after a job with a timeoutMs rejects', async () => {
    const clock = new TimerCountingClock(new FakeClock());
    const governor = createGovernor({ clock });
    await assert.rejects(
      governor.run(job('interactive', { timeoutMs: 1000 }), async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(clock.live, 0);
  });

  it('leaves no live timer after a job times out', async () => {
    const inner = new FakeClock();
    const clock = new TimerCountingClock(inner);
    const governor = createGovernor({ clock });
    const hung = governor.run(job('interactive', { timeoutMs: 10 }), () => new Promise<never>(() => {}));
    assert.equal(clock.live, 1);
    await inner.advance(10);
    assert.deepEqual(await hung, { kind: 'timeout' });
    assert.equal(clock.live, 0);
  });

  it('arms a timer only for a job that has a timeoutMs, and only once it starts running', async () => {
    const inner = new FakeClock();
    const clock = new TimerCountingClock(inner);
    const governor = createGovernor({ clock, concurrency: 1 });
    const gate = deferred();
    const blocker = governor.run(job('interactive'), () => gate.promise);
    const queued = governor.run(job('indexing', { timeoutMs: 50 }), async () => 'queued');
    assert.equal(clock.live, 0);
    gate.resolve();
    await blocker;
    assert.deepEqual(await queued, { kind: 'ok', value: 'queued' });
    assert.equal(clock.live, 0);
  });
});
