import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import type { FakeClock } from '../test-kit/index.ts';
import type { Governor, GovernorResult, GovernorStatus, Job, JobClass, Lease, LeaseResult } from './types.ts';

/**
 * Behaviour every Governor must show, whatever its scheduling policy. Test code: it is imported
 * only by governor.test.ts (and any adapter added inside src/governor) and never re-exported
 * from index.ts.
 */
export function defineGovernorContract(label: string, make: () => Governor): void {
  describe(`Governor contract: ${label}`, () => {
    it('returns ok with the value and invokes the function exactly once', async () => {
      const governor = make();
      let calls = 0;
      const result = await governor.run({ tenant: 't', class: 'interactive', cost: 1 }, async () => {
        calls += 1;
        return 42;
      });
      assert.deepEqual(result, { kind: 'ok', value: 42 });
      assert.equal(calls, 1);
    });

    it('passes the function an AbortSignal that is not aborted for a job that completes', async () => {
      const governor = make();
      let seen: AbortSignal | undefined;
      await governor.run({ tenant: 't', class: 'indexing', cost: 1 }, async (signal) => {
        seen = signal;
      });
      assert.ok(seen instanceof AbortSignal);
      assert.equal(seen.aborted, false);
    });

    it('makes run reject with the same error when the function rejects, never busy', async () => {
      const governor = make();
      const boom = new Error('boom');
      await assert.rejects(
        governor.run({ tenant: 't', class: 'maintenance', cost: 1 }, async () => {
          throw boom;
        }),
        (error: unknown) => error === boom,
      );
      assert.equal(governor.status().running, 0);
    });

    it('grants a lease whose release is idempotent', async () => {
      const governor = make();
      const key = { tenant: 't', fileSetId: 'fs-1' };
      const result = await governor.lease(key, 100, () => {});
      assert.equal(result.kind, 'ok');
      if (result.kind !== 'ok') {
        return;
      }
      assert.deepEqual(result.lease.key, key);
      result.lease.release();
      const afterFirst = governor.status();
      result.lease.release();
      assert.deepEqual(governor.status(), afterFirst);
    });

    it('reports status as non-negative integers, idle and while work and a lease are held', async () => {
      const governor = make();
      assertCounters(governor.status());
      const granted = await governor.lease({ tenant: 't', fileSetId: 'fs-1' }, 64, () => {});
      assertCounters(governor.status());
      let during: GovernorStatus | undefined;
      await governor.run({ tenant: 't', class: 'fresh', cost: 1 }, async () => {
        during = governor.status();
      });
      assert.ok(during);
      assertCounters(during);
      assert.equal(during.running, 1);
      if (granted.kind === 'ok') {
        granted.lease.release();
      }
      assertCounters(governor.status());
    });

    it('rejects a negative or fractional byte estimate', async () => {
      const governor = make();
      const key = { tenant: 't', fileSetId: 'fs-1' };
      await assert.rejects(governor.lease(key, -1, () => {}), RangeError);
      await assert.rejects(governor.lease(key, 1.5, () => {}), RangeError);
    });
  });
}

function assertCounters(status: GovernorStatus): void {
  for (const value of [status.queued, status.running, status.leases, status.leasedBytes]) {
    assert.ok(Number.isInteger(value) && value >= 0, `status field ${String(value)} is not a non-negative integer`);
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const job = (cls: JobClass, extra: Partial<Job> = {}): Job => ({ tenant: 't', class: cls, cost: 1, ...extra });

export function mustLease(result: LeaseResult): Lease {
  assert.equal(result.kind, 'ok');
  assert.ok(result.kind === 'ok');
  return result.lease;
}

/** A Governor that also counts the errors its `onEvict` callbacks threw. */
export interface SchedulingGovernor extends Governor {
  /** Errors thrown by `onEvict` callbacks. They are caught and counted, never propagated. */
  readonly evictErrors: number;
}

/** Numbers the scheduling contract hands to `make`. The single bound and delay apply to every class. */
export interface SchedulingOptions {
  readonly concurrency: number;
  readonly maxQueue: number;
  readonly busyRetryMs: number;
  readonly memoryBudgetBytes: number;
}

export interface SchedulingHarness {
  readonly governor: SchedulingGovernor;
  readonly clock: FakeClock;
}

const SCHEDULING_DEFAULTS: SchedulingOptions = {
  concurrency: 1,
  maxQueue: 8,
  busyRetryMs: 250,
  memoryBudgetBytes: Infinity,
};

/**
 * Scheduling and lease behaviour shared by the fake and the real Governor: priority order, busy
 * with retry_after when the job's own class queue is full, per-job time limits, one slot for
 * `fresh` jobs of one request (D-17) and the file-set keyed lease pool with LRU eviction. The
 * noop Governor deliberately does not schedule, so it does not run this suite.
 */
export function defineGovernorSchedulingContract(
  label: string,
  make: (options: SchedulingOptions) => SchedulingHarness,
): void {
  const build = (overrides: Partial<SchedulingOptions> = {}): SchedulingHarness =>
    make({ ...SCHEDULING_DEFAULTS, ...overrides });

  describe(`${label} Governor: priority and admission`, () => {
    it('starts queued jobs interactive, fresh, indexing, maintenance, FIFO within a class', async () => {
      const { governor } = build();
      const gate = deferred();
      const started: string[] = [];
      const submit = (name: string, cls: JobClass): Promise<GovernorResult<void>> =>
        governor.run(job(cls), async () => {
          started.push(name);
        });
      const blocker = governor.run(job('maintenance'), () => gate.promise);
      const all = [
        submit('maintenance-1', 'maintenance'),
        submit('indexing-1', 'indexing'),
        submit('fresh-1', 'fresh'),
        submit('interactive-1', 'interactive'),
        submit('interactive-2', 'interactive'),
        submit('fresh-2', 'fresh'),
      ];
      assert.equal(governor.status().queued, 6);
      assert.equal(governor.status().running, 1);
      gate.resolve();
      await Promise.all([blocker, ...all]);
      assert.deepEqual(started, [
        'interactive-1',
        'interactive-2',
        'fresh-1',
        'fresh-2',
        'indexing-1',
        'maintenance-1',
      ]);
    });

    it('returns busy with retry_after when the queue is full, without running the function', async () => {
      const { governor } = build({ maxQueue: 2 });
      const gate = deferred();
      const first = governor.run(job('indexing'), () => gate.promise);
      const second = governor.run(job('indexing'), async () => 'second');
      const third = governor.run(job('indexing'), async () => 'third');
      let fourthRan = false;
      const fourth = await governor.run(job('indexing'), async () => {
        fourthRan = true;
      });
      assert.deepEqual(fourth, { kind: 'busy', retry_after: 250 });
      assert.equal(fourthRan, false);
      assert.equal(governor.status().queued, 2);
      gate.resolve();
      assert.deepEqual(await second, { kind: 'ok', value: 'second' });
      assert.deepEqual(await third, { kind: 'ok', value: 'third' });
      await first;
    });

    it('uses busyRetryMs as retry_after', async () => {
      const { governor } = build({ maxQueue: 0, busyRetryMs: 40 });
      const gate = deferred();
      const running = governor.run(job('indexing'), () => gate.promise);
      assert.deepEqual(await governor.run(job('indexing'), async () => {}), { kind: 'busy', retry_after: 40 });
      gate.resolve();
      await running;
    });

    it('runs up to the concurrency limit at once', async () => {
      const { governor } = build({ concurrency: 2 });
      const gate = deferred();
      const jobs = [1, 2, 3].map(() => governor.run(job('indexing'), () => gate.promise));
      assert.equal(governor.status().running, 2);
      assert.equal(governor.status().queued, 1);
      gate.resolve();
      await Promise.all(jobs);
      assert.equal(governor.status().running, 0);
    });

    it('frees the slot when a function rejects, so the next job runs', async () => {
      const { governor } = build();
      const failing = governor.run(job('indexing'), async () => {
        throw new Error('boom');
      });
      const next = governor.run(job('indexing'), async () => 'next');
      await assert.rejects(failing, /boom/);
      assert.deepEqual(await next, { kind: 'ok', value: 'next' });
    });

    it('treats a function that throws synchronously as a rejection and frees its slot', async () => {
      const { governor } = build();
      await assert.rejects(
        governor.run(job('indexing'), () => {
          throw new Error('sync boom');
        }),
        /sync boom/,
      );
      assert.equal(governor.status().running, 0);
      assert.deepEqual(await governor.run(job('indexing'), async () => 'after'), { kind: 'ok', value: 'after' });
    });

    it('rejects an unknown job class', async () => {
      const { governor } = build();
      await assert.rejects(governor.run({ tenant: 't', class: 'urgent' as JobClass, cost: 1 }, async () => {}), RangeError);
    });

    it('runs two jobs of one class in submission order, and a later higher-priority job overtakes only queued ones', async () => {
      const { governor } = build();
      const gate = deferred();
      const started: string[] = [];
      const record = (name: string) => async (): Promise<void> => {
        started.push(name);
      };
      const running = governor.run(job('maintenance'), () => gate.promise);
      const a = governor.run(job('indexing'), record('indexing-a'));
      const b = governor.run(job('indexing'), record('indexing-b'));
      const late = governor.run(job('interactive'), record('interactive-late'));
      assert.equal(governor.status().running, 1);
      gate.resolve();
      await Promise.all([running, a, b, late]);
      assert.deepEqual(started, ['interactive-late', 'indexing-a', 'indexing-b']);
    });
  });

  describe(`${label} Governor: time limits`, () => {
    it('resolves timeout once the fake clock reaches timeoutMs and aborts the signal', async () => {
      const { governor, clock } = build();
      let seen: AbortSignal | undefined;
      const hung = governor.run(job('interactive', { timeoutMs: 100 }), (signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      });
      await clock.advance(99);
      assert.equal(seen?.aborted, false);
      assert.equal(governor.status().running, 1);
      await clock.advance(1);
      assert.deepEqual(await hung, { kind: 'timeout' });
      assert.equal(seen?.aborted, true);
      assert.equal(governor.status().running, 0);
    });

    it('starts the limit when the job starts running, not when it is queued', async () => {
      const { governor, clock } = build();
      const gate = deferred();
      const blocker = governor.run(job('interactive'), () => gate.promise);
      const limited = governor.run(job('indexing', { timeoutMs: 100 }), async () => 'done');
      await clock.advance(500);
      gate.resolve();
      await blocker;
      assert.deepEqual(await limited, { kind: 'ok', value: 'done' });
    });

    it('frees the slot on timeout so the next queued job runs', async () => {
      const { governor, clock } = build();
      const hung = governor.run(job('indexing', { timeoutMs: 10 }), () => new Promise<never>(() => {}));
      const next = governor.run(job('indexing'), async () => 'next');
      await clock.advance(10);
      assert.deepEqual(await hung, { kind: 'timeout' });
      assert.deepEqual(await next, { kind: 'ok', value: 'next' });
    });

    it('ignores a function that settles after its job timed out', async () => {
      const { governor, clock } = build();
      const late = deferred();
      const result = governor.run(job('indexing', { timeoutMs: 5 }), () => late.promise);
      await clock.advance(5);
      assert.deepEqual(await result, { kind: 'timeout' });
      late.resolve();
      await tick();
      assert.equal(governor.status().running, 0);
    });
  });

  describe(`${label} Governor: one fresh slot per request (D-17)`, () => {
    it('runs fresh jobs that share a requestId concurrently under concurrency 1', async () => {
      const { governor } = build();
      const gate = deferred();
      const jobs = ['a', 'b'].map(() => governor.run(job('fresh', { requestId: 'req-1' }), () => gate.promise));
      assert.equal(governor.status().running, 2);
      assert.equal(governor.status().queued, 0);
      gate.resolve();
      await Promise.all(jobs);
    });

    it('runs fresh jobs with different requestIds one after the other', async () => {
      const { governor } = build();
      const gate = deferred();
      const first = governor.run(job('fresh', { requestId: 'req-1' }), () => gate.promise);
      const second = governor.run(job('fresh', { requestId: 'req-2' }), async () => 'second');
      assert.equal(governor.status().running, 1);
      assert.equal(governor.status().queued, 1);
      gate.resolve();
      await first;
      assert.deepEqual(await second, { kind: 'ok', value: 'second' });
    });

    it('lets a queued fresh job join its request as soon as a sibling is running', async () => {
      const { governor } = build();
      const gate = deferred();
      const blocker = governor.run(job('interactive'), () => gate.promise);
      const gateA = deferred();
      const a = governor.run(job('fresh', { requestId: 'req-1' }), () => gateA.promise);
      const b = governor.run(job('fresh', { requestId: 'req-1' }), async () => 'b');
      assert.equal(governor.status().queued, 2);
      gate.resolve();
      await blocker;
      assert.deepEqual(await b, { kind: 'ok', value: 'b' });
      gateA.resolve();
      await a;
    });

    it('does not share a slot between non-fresh jobs that carry the same requestId', async () => {
      const { governor } = build();
      const gate = deferred();
      const first = governor.run(job('indexing', { requestId: 'req-1' }), () => gate.promise);
      const second = governor.run(job('indexing', { requestId: 'req-1' }), async () => {});
      assert.equal(governor.status().running, 1);
      assert.equal(governor.status().queued, 1);
      gate.resolve();
      await Promise.all([first, second]);
    });

    it('does not share a slot between fresh jobs without a requestId', async () => {
      const { governor } = build();
      const gate = deferred();
      const first = governor.run(job('fresh'), () => gate.promise);
      const second = governor.run(job('fresh'), async () => {});
      assert.equal(governor.status().running, 1);
      gate.resolve();
      await Promise.all([first, second]);
    });
  });

  describe(`${label} Governor: leases keyed on the file set (D-17)`, () => {
    const withBudget = (memoryBudgetBytes = Infinity): SchedulingGovernor => build({ memoryBudgetBytes }).governor;

    it('charges once when two tenants lease the same fileSetId', async () => {
      const governor = withBudget();
      mustLease(await governor.lease({ tenant: 'a', fileSetId: 'fs' }, 100, () => {}));
      mustLease(await governor.lease({ tenant: 'b', fileSetId: 'fs' }, 100, () => {}));
      assert.equal(governor.status().leases, 1);
      assert.equal(governor.status().leasedBytes, 100);
    });

    it('charges twice for two fileSetIds from one tenant', async () => {
      const governor = withBudget();
      mustLease(await governor.lease({ tenant: 'a', fileSetId: 'one' }, 100, () => {}));
      mustLease(await governor.lease({ tenant: 'a', fileSetId: 'two' }, 100, () => {}));
      assert.equal(governor.status().leases, 2);
      assert.equal(governor.status().leasedBytes, 200);
    });

    it('keeps an entry charged but idle after the last release', async () => {
      const governor = withBudget();
      mustLease(await governor.lease({ tenant: 'a', fileSetId: 'fs' }, 100, () => {})).release();
      assert.equal(governor.status().leasedBytes, 100);
    });

    it('evicts least-recently-used idle entries first, once each, and refreshes recency on re-lease', async () => {
      const governor = withBudget(100);
      const evicted: string[] = [];
      const on = (id: string) => () => void evicted.push(id);
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'A' }, 40, on('A'))).release();
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'B' }, 40, on('B'))).release();
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'C' }, 40, on('C'))).release();
      assert.deepEqual(evicted, ['A']);
      // Re-leasing B makes C the least recently used.
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'B' }, 40, on('B'))).release();
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'D' }, 40, on('D'))).release();
      assert.deepEqual(evicted, ['A', 'C']);
      assert.equal(governor.status().leases, 2);
      assert.equal(governor.status().leasedBytes, 80);
    });

    it('never evicts an entry that still has a holder, and returns busy when nothing else can go', async () => {
      const governor = withBudget(100);
      let evicted = 0;
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'A' }, 60, () => void (evicted += 1)));
      const result = await governor.lease({ tenant: 't', fileSetId: 'B' }, 60, () => {});
      assert.deepEqual(result, { kind: 'busy', retry_after: 250 });
      assert.equal(evicted, 0);
      assert.equal(governor.status().leasedBytes, 60);
    });

    it('makes a shared entry evictable only after every tenant has released it', async () => {
      const governor = withBudget(100);
      let evicted = 0;
      const a = mustLease(await governor.lease({ tenant: 'a', fileSetId: 'fs' }, 80, () => void (evicted += 1)));
      const b = mustLease(await governor.lease({ tenant: 'b', fileSetId: 'fs' }, 80, () => void (evicted += 1)));
      a.release();
      assert.equal((await governor.lease({ tenant: 'c', fileSetId: 'other' }, 80, () => {})).kind, 'busy');
      b.release();
      assert.equal((await governor.lease({ tenant: 'c', fileSetId: 'other' }, 80, () => {})).kind, 'ok');
      assert.equal(evicted, 1);
    });

    it('does not evict when the request cannot fit even after evicting every idle entry', async () => {
      const governor = withBudget(100);
      let evicted = 0;
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'A' }, 30, () => void (evicted += 1))).release();
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'held' }, 50, () => {}));
      assert.equal((await governor.lease({ tenant: 't', fileSetId: 'big' }, 60, () => {})).kind, 'busy');
      assert.equal(evicted, 0);
      assert.equal(governor.status().leases, 2);
    });

    it('catches, counts and survives an onEvict that throws, and keeps evicting', async () => {
      const governor = withBudget(100);
      const evicted: string[] = [];
      mustLease(
        await governor.lease({ tenant: 't', fileSetId: 'A' }, 40, () => {
          evicted.push('A');
          throw new Error('callback failure');
        }),
      ).release();
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'B' }, 40, () => void evicted.push('B'))).release();
      mustLease(await governor.lease({ tenant: 't', fileSetId: 'C' }, 100, () => {}));
      assert.deepEqual(evicted, ['A', 'B']);
      assert.equal(governor.evictErrors, 1);
      assert.equal(governor.status().leases, 1);
      assert.equal(governor.status().leasedBytes, 100);
    });
  });
}
