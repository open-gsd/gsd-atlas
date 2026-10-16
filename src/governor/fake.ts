import type { Clock } from '../facts/index.ts';
import { JOB_CLASSES } from './types.ts';
import type { Governor, GovernorResult, GovernorStatus, Job, Lease, LeaseKey, LeaseResult } from './types.ts';
import { assertEstimatedBytes, assertJob } from './validate.ts';

export interface FakeGovernorOptions {
  /** Time source for per-job limits. Tests inject the test kit's FakeClock. */
  readonly clock: Clock;
  /** Scheduling slots. A group of `fresh` jobs sharing a requestId occupies one slot. Default 1. */
  readonly concurrency?: number;
  /** Jobs allowed to wait for a slot; a call that would exceed it resolves busy. Default 8. */
  readonly maxQueue?: number;
  /** Machine-wide budget for leases, in bytes. Default Infinity. */
  readonly memoryBudgetBytes?: number;
  /** `retry_after` reported with busy, in milliseconds. Default 250. */
  readonly busyRetryMs?: number;
}

/** The fake, with one extra read-only counter the contract does not need. */
export interface FakeGovernor extends Governor {
  /** Errors thrown by `onEvict` callbacks. They are caught and counted, never propagated. */
  readonly evictErrors: number;
}

interface Waiting {
  readonly job: Job;
  readonly seq: number;
  readonly slotKey: string;
  start(): void;
}

interface PoolEntry {
  bytes: number;
  holders: number;
  /** Order of the latest lease grant; the smallest value is the least recently used. */
  recency: number;
  onEvict: () => void;
}

const RANK: ReadonlyMap<string, number> = new Map(JOB_CLASSES.map((cls, rank) => [cls, rank]));

/**
 * A bounded, deterministic Governor for tests (D-10). One priority queue (class rank, then
 * arrival), a concurrency cap, a queue cap that yields busy, per-job limits driven by the injected
 * clock, and a file-set-keyed lease pool with LRU eviction. It implements no weighted round-robin,
 * per-tenant queues or real pools; those are Phase 4.
 *
 * A job's limit is raced with `clock.sleep`. The fake never cancels that sleep, so with a real
 * clock a finished job leaves a timer pending until its limit; tests use a fake clock.
 */
export function createFakeGovernor(options: FakeGovernorOptions): FakeGovernor {
  const { clock } = options;
  const concurrency = options.concurrency ?? 1;
  const maxQueue = options.maxQueue ?? 8;
  const memoryBudgetBytes = options.memoryBudgetBytes ?? Infinity;
  const busyRetryMs = options.busyRetryMs ?? 250;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be an integer >= 1');
  }
  if (maxQueue !== Infinity && (!Number.isInteger(maxQueue) || maxQueue < 0)) {
    throw new RangeError('maxQueue must be an integer >= 0 or Infinity');
  }
  if (!(memoryBudgetBytes >= 0)) {
    throw new RangeError('memoryBudgetBytes must be >= 0');
  }

  let nextSeq = 0;
  let runningJobs = 0;
  const queue: Waiting[] = [];
  /** Slot key to number of running jobs holding it. Its size is the slots in use. */
  const slots = new Map<string, number>();

  const pool = new Map<string, PoolEntry>();
  let leasedBytes = 0;
  let recencyClock = 0;
  let evictErrors = 0;

  /** `fresh` jobs of one request share a slot (D-17); every other job has a slot of its own. */
  function slotKeyFor(job: Job, seq: number): string {
    return job.class === 'fresh' && job.requestId !== undefined ? `request:${job.requestId}` : `job:${seq}`;
  }

  function canStart(slotKey: string): boolean {
    return slots.has(slotKey) || slots.size < concurrency;
  }

  function begin<T>(
    waiting: Pick<Waiting, 'job' | 'slotKey'>,
    fn: (signal: AbortSignal) => Promise<T>,
    resolve: (result: GovernorResult<T>) => void,
    reject: (error: unknown) => void,
  ): void {
    const { job, slotKey } = waiting;
    slots.set(slotKey, (slots.get(slotKey) ?? 0) + 1);
    runningJobs += 1;
    const controller = new AbortController();
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      runningJobs -= 1;
      const holders = (slots.get(slotKey) ?? 1) - 1;
      if (holders === 0) {
        slots.delete(slotKey);
      } else {
        slots.set(slotKey, holders);
      }
      settle();
      pump();
    };

    let outcome: Promise<T>;
    try {
      outcome = Promise.resolve(fn(controller.signal));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (value) => finish(() => resolve({ kind: 'ok', value })),
      (error: unknown) => finish(() => reject(error)),
    );
    if (job.timeoutMs !== undefined) {
      void clock.sleep(job.timeoutMs).then(() => {
        if (settled) {
          return;
        }
        controller.abort();
        finish(() => resolve({ kind: 'timeout' }));
      });
    }
  }

  /** Start every queued job that can start, best priority first. */
  function pump(): void {
    for (;;) {
      let best: Waiting | undefined;
      for (const candidate of queue) {
        if (!canStart(candidate.slotKey)) {
          continue;
        }
        if (best === undefined || isBefore(candidate, best)) {
          best = candidate;
        }
      }
      if (best === undefined) {
        return;
      }
      queue.splice(queue.indexOf(best), 1);
      best.start();
    }
  }

  function isBefore(a: Waiting, b: Waiting): boolean {
    const rankA = RANK.get(a.job.class) ?? JOB_CLASSES.length;
    const rankB = RANK.get(b.job.class) ?? JOB_CLASSES.length;
    return rankA !== rankB ? rankA < rankB : a.seq < b.seq;
  }

  function evict(fileSetId: string): void {
    const entry = pool.get(fileSetId);
    if (entry === undefined) {
      return;
    }
    pool.delete(fileSetId);
    leasedBytes -= entry.bytes;
    try {
      entry.onEvict();
    } catch {
      evictErrors += 1;
    }
  }

  function makeLease(key: LeaseKey, entry: PoolEntry): Lease {
    let released = false;
    return {
      key,
      release() {
        if (released) {
          return;
        }
        released = true;
        entry.holders -= 1;
      },
    };
  }

  return {
    run<T>(job: Job, fn: (signal: AbortSignal) => Promise<T>): Promise<GovernorResult<T>> {
      try {
        assertJob(job);
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise<GovernorResult<T>>((resolve, reject) => {
        const seq = nextSeq++;
        const slotKey = slotKeyFor(job, seq);
        const waiting: Waiting = { job, seq, slotKey, start: () => begin(waiting, fn, resolve, reject) };
        if (canStart(slotKey)) {
          waiting.start();
        } else if (queue.length >= maxQueue) {
          resolve({ kind: 'busy', retry_after: busyRetryMs });
        } else {
          queue.push(waiting);
        }
      });
    },

    async lease(key: LeaseKey, estimatedBytes: number, onEvict: () => void): Promise<LeaseResult> {
      assertEstimatedBytes(estimatedBytes);
      const existing = pool.get(key.fileSetId);
      if (existing !== undefined) {
        // Shared entry: one charge, whoever asks (D-17). The latest callback wins.
        existing.holders += 1;
        existing.recency = recencyClock++;
        existing.onEvict = onEvict;
        return { kind: 'ok', lease: makeLease(key, existing) };
      }

      // Decide the victims before evicting anything, so a request that cannot fit evicts nothing.
      const victims: string[] = [];
      let projected = leasedBytes + estimatedBytes;
      if (projected > memoryBudgetBytes) {
        const idle = [...pool.entries()]
          .filter(([, entry]) => entry.holders === 0)
          .sort(([, a], [, b]) => a.recency - b.recency);
        for (const [fileSetId, entry] of idle) {
          if (projected <= memoryBudgetBytes) {
            break;
          }
          victims.push(fileSetId);
          projected -= entry.bytes;
        }
        if (projected > memoryBudgetBytes) {
          return { kind: 'busy', retry_after: busyRetryMs };
        }
      }
      for (const fileSetId of victims) {
        evict(fileSetId);
      }
      const entry: PoolEntry = { bytes: estimatedBytes, holders: 1, recency: recencyClock++, onEvict };
      pool.set(key.fileSetId, entry);
      leasedBytes += estimatedBytes;
      return { kind: 'ok', lease: makeLease(key, entry) };
    },

    status(): GovernorStatus {
      return { queued: queue.length, running: runningJobs, leases: pool.size, leasedBytes };
    },

    get evictErrors() {
      return evictErrors;
    },
  };
}
