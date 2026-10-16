import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { FakeClock } from '../test-kit/index.ts';
import { defineGovernorContract } from './contract.ts';
import { createFakeGovernor, createNoopGovernor } from './index.ts';
import type { GovernorResult, Job, JobClass, Lease, LeaseResult } from './index.ts';

defineGovernorContract('noop', () => createNoopGovernor());
defineGovernorContract('fake', () => createFakeGovernor({ clock: new FakeClock() }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const job = (cls: JobClass, extra: Partial<Job> = {}): Job => ({ tenant: 't', class: cls, cost: 1, ...extra });

function mustLease(result: LeaseResult): Lease {
  assert.equal(result.kind, 'ok');
  assert.ok(result.kind === 'ok');
  return result.lease;
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
    await tick();
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

describe('fake Governor: priority and admission', () => {
  it('starts queued jobs interactive, fresh, indexing, maintenance, FIFO within a class', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
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
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1, maxQueue: 2 });
    const gate = deferred();
    const first = governor.run(job('indexing'), () => gate.promise);
    const second = governor.run(job('indexing'), async () => 'second');
    const third = governor.run(job('indexing'), async () => 'third');
    let fourthRan = false;
    const fourth = await governor.run(job('interactive'), async () => {
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
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1, maxQueue: 0, busyRetryMs: 40 });
    const gate = deferred();
    const running = governor.run(job('indexing'), () => gate.promise);
    assert.deepEqual(await governor.run(job('indexing'), async () => {}), { kind: 'busy', retry_after: 40 });
    gate.resolve();
    await running;
  });

  it('runs up to the concurrency limit at once', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 2 });
    const gate = deferred();
    const jobs = [1, 2, 3].map(() => governor.run(job('indexing'), () => gate.promise));
    assert.equal(governor.status().running, 2);
    assert.equal(governor.status().queued, 1);
    gate.resolve();
    await Promise.all(jobs);
    assert.equal(governor.status().running, 0);
  });

  it('frees the slot when a function rejects, so the next job runs', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
    const failing = governor.run(job('indexing'), async () => {
      throw new Error('boom');
    });
    const next = governor.run(job('indexing'), async () => 'next');
    await assert.rejects(failing, /boom/);
    assert.deepEqual(await next, { kind: 'ok', value: 'next' });
  });

  it('treats a function that throws synchronously as a rejection', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock() });
    await assert.rejects(
      governor.run(job('indexing'), () => {
        throw new Error('sync boom');
      }),
      /sync boom/,
    );
    assert.equal(governor.status().running, 0);
  });

  it('rejects an unknown job class', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock() });
    await assert.rejects(governor.run({ tenant: 't', class: 'urgent' as JobClass, cost: 1 }, async () => {}), RangeError);
  });
});

describe('fake Governor: time limits', () => {
  it('resolves timeout once the fake clock reaches timeoutMs and aborts the signal', async () => {
    const clock = new FakeClock();
    const governor = createFakeGovernor({ clock, concurrency: 1 });
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
    const clock = new FakeClock();
    const governor = createFakeGovernor({ clock, concurrency: 1 });
    const gate = deferred();
    const blocker = governor.run(job('interactive'), () => gate.promise);
    const limited = governor.run(job('indexing', { timeoutMs: 100 }), async () => 'done');
    await clock.advance(500);
    gate.resolve();
    await blocker;
    assert.deepEqual(await limited, { kind: 'ok', value: 'done' });
  });

  it('frees the slot on timeout so the next queued job runs', async () => {
    const clock = new FakeClock();
    const governor = createFakeGovernor({ clock, concurrency: 1 });
    const hung = governor.run(job('indexing', { timeoutMs: 10 }), () => new Promise<never>(() => {}));
    const next = governor.run(job('indexing'), async () => 'next');
    await clock.advance(10);
    assert.deepEqual(await hung, { kind: 'timeout' });
    assert.deepEqual(await next, { kind: 'ok', value: 'next' });
  });

  it('ignores a function that settles after its job timed out', async () => {
    const clock = new FakeClock();
    const governor = createFakeGovernor({ clock });
    const late = deferred();
    const result = governor.run(job('indexing', { timeoutMs: 5 }), () => late.promise);
    await clock.advance(5);
    assert.deepEqual(await result, { kind: 'timeout' });
    late.resolve();
    await tick();
    assert.equal(governor.status().running, 0);
  });
});

describe('fake Governor: one fresh slot per request (D-17)', () => {
  it('runs fresh jobs that share a requestId concurrently under concurrency 1', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
    const gate = deferred();
    const jobs = ['a', 'b'].map(() => governor.run(job('fresh', { requestId: 'req-1' }), () => gate.promise));
    assert.equal(governor.status().running, 2);
    assert.equal(governor.status().queued, 0);
    gate.resolve();
    await Promise.all(jobs);
  });

  it('runs fresh jobs with different requestIds one after the other', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
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
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
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
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
    const gate = deferred();
    const first = governor.run(job('indexing', { requestId: 'req-1' }), () => gate.promise);
    const second = governor.run(job('indexing', { requestId: 'req-1' }), async () => {});
    assert.equal(governor.status().running, 1);
    assert.equal(governor.status().queued, 1);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it('does not share a slot between fresh jobs without a requestId', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), concurrency: 1 });
    const gate = deferred();
    const first = governor.run(job('fresh'), () => gate.promise);
    const second = governor.run(job('fresh'), async () => {});
    assert.equal(governor.status().running, 1);
    gate.resolve();
    await Promise.all([first, second]);
  });
});

describe('fake Governor: leases keyed on the file set (D-17)', () => {
  const fake = (memoryBudgetBytes = Infinity) =>
    createFakeGovernor({ clock: new FakeClock(), memoryBudgetBytes });

  it('charges once when two tenants lease the same fileSetId', async () => {
    const governor = fake();
    mustLease(await governor.lease({ tenant: 'a', fileSetId: 'fs' }, 100, () => {}));
    mustLease(await governor.lease({ tenant: 'b', fileSetId: 'fs' }, 100, () => {}));
    assert.equal(governor.status().leases, 1);
    assert.equal(governor.status().leasedBytes, 100);
  });

  it('charges twice for two fileSetIds from one tenant', async () => {
    const governor = fake();
    mustLease(await governor.lease({ tenant: 'a', fileSetId: 'one' }, 100, () => {}));
    mustLease(await governor.lease({ tenant: 'a', fileSetId: 'two' }, 100, () => {}));
    assert.equal(governor.status().leases, 2);
    assert.equal(governor.status().leasedBytes, 200);
  });

  it('keeps an entry charged but idle after the last release', async () => {
    const governor = fake();
    mustLease(await governor.lease({ tenant: 'a', fileSetId: 'fs' }, 100, () => {})).release();
    assert.equal(governor.status().leasedBytes, 100);
  });

  it('evicts least-recently-used idle entries first, once each, and refreshes recency on re-lease', async () => {
    const governor = fake(100);
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
    const governor = fake(100);
    let evicted = 0;
    mustLease(await governor.lease({ tenant: 't', fileSetId: 'A' }, 60, () => void (evicted += 1)));
    const result = await governor.lease({ tenant: 't', fileSetId: 'B' }, 60, () => {});
    assert.deepEqual(result, { kind: 'busy', retry_after: 250 });
    assert.equal(evicted, 0);
    assert.equal(governor.status().leasedBytes, 60);
  });

  it('makes a shared entry evictable only after every tenant has released it', async () => {
    const governor = fake(100);
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
    const governor = fake(100);
    let evicted = 0;
    mustLease(await governor.lease({ tenant: 't', fileSetId: 'A' }, 30, () => void (evicted += 1))).release();
    mustLease(await governor.lease({ tenant: 't', fileSetId: 'held' }, 50, () => {}));
    assert.equal((await governor.lease({ tenant: 't', fileSetId: 'big' }, 60, () => {})).kind, 'busy');
    assert.equal(evicted, 0);
    assert.equal(governor.status().leases, 2);
  });

  it('catches, counts and survives an onEvict that throws, and keeps evicting', async () => {
    const governor = createFakeGovernor({ clock: new FakeClock(), memoryBudgetBytes: 100 });
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
