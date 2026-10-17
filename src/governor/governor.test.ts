import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import type { Clock } from '../facts/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { defineGovernorContract, defineGovernorSchedulingContract, deferred, job, mustLease } from './contract.ts';
import { DEFAULT_GOVERNOR_OPTIONS, createFakeGovernor, createGovernor, createNoopGovernor } from './index.ts';
import type { JobClass } from './index.ts';

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

describe('real Governor: per-class bounds', () => {
  it('answers busy with the class retry delay when only that class queue is full', async () => {
    const governor = createGovernor({
      clock: new FakeClock(),
      concurrency: 1,
      maxQueue: { interactive: 1, maintenance: 1 },
      busyRetryMs: { interactive: 111, maintenance: 777 },
    });
    const gate = deferred();
    const running = governor.run(job('indexing'), () => gate.promise);
    const queuedInteractive = governor.run(job('interactive'), async () => 'interactive');
    let ran = false;
    const rejected = await governor.run(job('interactive'), async () => {
      ran = true;
    });
    assert.deepEqual(rejected, { kind: 'busy', retry_after: 111 });
    assert.equal(ran, false);
    // Maintenance has its own queue, which still has room.
    const queuedMaintenance = governor.run(job('maintenance'), async () => 'maintenance');
    assert.equal(governor.status().queued, 2);
    assert.deepEqual(await governor.run(job('maintenance'), async () => {}), { kind: 'busy', retry_after: 777 });
    assert.equal(governor.status().queued, 2);
    gate.resolve();
    await running;
    assert.deepEqual(await queuedInteractive, { kind: 'ok', value: 'interactive' });
    assert.deepEqual(await queuedMaintenance, { kind: 'ok', value: 'maintenance' });
  });

  it('admits a job of another class while one class is at its bound', async () => {
    const governor = createGovernor({ clock: new FakeClock(), concurrency: 1, maxQueue: { fresh: 0 } });
    const gate = deferred();
    const running = governor.run(job('indexing'), () => gate.promise);
    assert.equal((await governor.run(job('fresh'), async () => {})).kind, 'busy');
    const other = governor.run(job('interactive'), async () => 'admitted');
    assert.equal(governor.status().queued, 1);
    gate.resolve();
    await running;
    assert.deepEqual(await other, { kind: 'ok', value: 'admitted' });
  });

  it('maxQueue 0 admits a job only when a slot is free', async () => {
    const governor = createGovernor({
      clock: new FakeClock(),
      concurrency: 1,
      maxQueue: { interactive: 0, fresh: 0, indexing: 0, maintenance: 0 },
    });
    assert.deepEqual(await governor.run(job('indexing'), async () => 'free slot'), { kind: 'ok', value: 'free slot' });
    const gate = deferred();
    const running = governor.run(job('indexing'), () => gate.promise);
    let ran = false;
    const result = await governor.run(job('indexing'), async () => {
      ran = true;
    });
    assert.equal(result.kind, 'busy');
    assert.equal(ran, false);
    assert.equal(governor.status().queued, 0);
    gate.resolve();
    await running;
    assert.deepEqual(await governor.run(job('indexing'), async () => 'again'), { kind: 'ok', value: 'again' });
  });

  it('gives every class in the default options a finite bound and a positive integer retry delay', () => {
    for (const cls of ['interactive', 'fresh', 'indexing', 'maintenance'] as const) {
      const bound = DEFAULT_GOVERNOR_OPTIONS.maxQueue[cls];
      const delay = DEFAULT_GOVERNOR_OPTIONS.busyRetryMs[cls];
      assert.ok(Number.isInteger(bound) && bound >= 0, `maxQueue.${cls} is not a finite non-negative integer`);
      assert.ok(Number.isInteger(delay) && delay >= 1, `busyRetryMs.${cls} is not a positive integer`);
    }
    assert.ok(Number.isInteger(DEFAULT_GOVERNOR_OPTIONS.concurrency) && DEFAULT_GOVERNOR_OPTIONS.concurrency >= 1);
  });

  it('saturates the default maintenance queue and answers busy with the default maintenance delay', async () => {
    const governor = createGovernor({ clock: new FakeClock() });
    const gate = deferred();
    const jobs = Array.from({ length: DEFAULT_GOVERNOR_OPTIONS.concurrency }, () =>
      governor.run(job('maintenance'), () => gate.promise),
    );
    const queued = Array.from({ length: DEFAULT_GOVERNOR_OPTIONS.maxQueue.maintenance }, () =>
      governor.run(job('maintenance'), async () => {}),
    );
    assert.equal(governor.status().queued, DEFAULT_GOVERNOR_OPTIONS.maxQueue.maintenance);
    assert.deepEqual(await governor.run(job('maintenance'), async () => {}), {
      kind: 'busy',
      retry_after: DEFAULT_GOVERNOR_OPTIONS.busyRetryMs.maintenance,
    });
    gate.resolve();
    await Promise.all([...jobs, ...queued]);
    assert.equal(governor.status().queued, 0);
  });

  it('runs 100 jobs at once under concurrency 4 in submission order within each class, never above the cap', async () => {
    const governor = createGovernor({
      clock: new FakeClock(),
      concurrency: 4,
      maxQueue: { interactive: 100, fresh: 100, indexing: 100, maintenance: 100 },
    });
    const classes: readonly JobClass[] = ['interactive', 'fresh', 'indexing', 'maintenance'];
    const started: Array<{ cls: JobClass; index: number }> = [];
    let peak = 0;
    const all = Array.from({ length: 100 }, (_, index) => {
      const cls = classes[index % classes.length] ?? 'indexing';
      return governor.run(job(cls), async () => {
        started.push({ cls, index });
        peak = Math.max(peak, governor.status().running);
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    });
    const results = await Promise.all(all);
    assert.ok(results.every((r) => r.kind === 'ok'));
    assert.equal(started.length, 100);
    assert.ok(peak <= 4, `running peaked at ${peak}`);
    for (const cls of classes) {
      const order = started.filter((s) => s.cls === cls).map((s) => s.index);
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${cls} jobs left submission order`);
    }
    assert.deepEqual(governor.status(), { queued: 0, running: 0, leases: 0, leasedBytes: 0 });
  });

  it('leaves no live timer once every job of a saturation run has settled', async () => {
    const inner = new FakeClock();
    const clock = new TimerCountingClock(inner);
    const governor = createGovernor({
      clock,
      concurrency: 2,
      maxQueue: { interactive: 3, fresh: 3, indexing: 3, maintenance: 3 },
    });
    const gate = deferred();
    const results = Array.from({ length: 30 }, (_, index) =>
      governor.run(job(index % 2 === 0 ? 'indexing' : 'maintenance', { timeoutMs: 1000 }), () => gate.promise),
    );
    const settledEarly = await Promise.all(results.slice(8));
    assert.ok(settledEarly.every((r) => r.kind === 'busy'));
    gate.resolve();
    const settled = await Promise.all(results);
    assert.ok(settled.some((r) => r.kind === 'ok'));
    assert.equal(clock.live, 0);
    assert.equal(governor.status().queued, 0);
    assert.equal(governor.status().running, 0);
  });
});

describe('real Governor: timeout contract (IN-11)', () => {
  it('timeout honours the signal: the signal is aborted, the slot is released once and the next job starts', async () => {
    const clock = new FakeClock();
    const governor = createGovernor({ clock, concurrency: 1 });
    let seen: AbortSignal | undefined;
    const hung = governor.run(job('indexing', { timeoutMs: 100 }), (signal) => {
      seen = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }).catch(() => undefined);
    });
    let nextStarted = false;
    const next = governor.run(job('indexing'), async () => {
      nextStarted = true;
      return 'next';
    });
    assert.equal(governor.status().running, 1);
    assert.equal(governor.status().queued, 1);
    assert.equal(nextStarted, false);

    await clock.advance(100);

    assert.deepEqual(await hung, { kind: 'timeout' });
    assert.equal(seen?.aborted, true);
    assert.deepEqual(await next, { kind: 'ok', value: 'next' });
    assert.deepEqual(governor.status(), { queued: 0, running: 0, leases: 0, leasedBytes: 0 });
  });

  it('timeout ignores the signal: the result is timeout and the slot is freed at once, so the function runs on outside the cap', async () => {
    const clock = new FakeClock();
    const governor = createGovernor({ clock, concurrency: 1 });
    const gate = deferred();
    let seen: AbortSignal | undefined;
    // The function never looks at its signal: it only settles when the test lets it.
    const orphan = governor.run(job('indexing', { timeoutMs: 100 }), async (signal) => {
      seen = signal;
      await gate.promise;
    });
    assert.equal(governor.status().running, 1);

    await clock.advance(100);

    assert.deepEqual(await orphan, { kind: 'timeout' });
    assert.equal(seen?.aborted, true, 'the signal was aborted even though the function ignores it');
    assert.equal(governor.status().running, 0, 'the slot is released while the function is still pending');

    // The freed slot is used by another job while the orphan still runs: that is the documented over-cap path.
    const gate2 = deferred();
    const second = governor.run(job('indexing'), () => gate2.promise);
    assert.equal(governor.status().running, 1);

    gate.resolve();
    await tick();
    assert.equal(governor.status().running, 1, 'the orphan settling releases nothing a second time');
    gate2.resolve();
    await second;
    assert.deepEqual(governor.status(), { queued: 0, running: 0, leases: 0, leasedBytes: 0 });
  });
});

describe('real Governor: option validation', () => {
  const rangeErrorNaming = (name: string) => (error: unknown) =>
    error instanceof RangeError && error.message.includes(name);

  it('throws RangeError naming maxQueue for a negative bound', () => {
    assert.throws(() => createGovernor({ clock: new FakeClock(), maxQueue: { indexing: -1 } }), rangeErrorNaming('maxQueue.indexing'));
  });

  it('throws RangeError naming maxQueue for a bound that is not an integer or is infinite', () => {
    assert.throws(() => createGovernor({ clock: new FakeClock(), maxQueue: { fresh: 1.5 } }), rangeErrorNaming('maxQueue.fresh'));
    assert.throws(() => createGovernor({ clock: new FakeClock(), maxQueue: { interactive: Infinity } }), rangeErrorNaming('maxQueue.interactive'));
    assert.throws(() => createGovernor({ clock: new FakeClock(), maxQueue: { maintenance: Number.NaN } }), rangeErrorNaming('maxQueue.maintenance'));
  });

  it('throws RangeError naming busyRetryMs for a delay that is not a positive integer', () => {
    assert.throws(() => createGovernor({ clock: new FakeClock(), busyRetryMs: { fresh: 1.5 } }), rangeErrorNaming('busyRetryMs.fresh'));
    assert.throws(() => createGovernor({ clock: new FakeClock(), busyRetryMs: { interactive: 0 } }), rangeErrorNaming('busyRetryMs.interactive'));
    assert.throws(() => createGovernor({ clock: new FakeClock(), busyRetryMs: { maintenance: -5 } }), rangeErrorNaming('busyRetryMs.maintenance'));
  });

  it('throws RangeError naming concurrency for a value below 1 or not an integer', () => {
    assert.throws(() => createGovernor({ clock: new FakeClock(), concurrency: 0 }), rangeErrorNaming('concurrency'));
    assert.throws(() => createGovernor({ clock: new FakeClock(), concurrency: 2.5 }), rangeErrorNaming('concurrency'));
  });

  it('throws RangeError naming memoryBudgetBytes for a negative budget', () => {
    assert.throws(() => createGovernor({ clock: new FakeClock(), memoryBudgetBytes: -1 }), rangeErrorNaming('memoryBudgetBytes'));
  });
});
