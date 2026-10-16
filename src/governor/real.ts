import type { Clock } from '../facts/index.ts';
import { DEFAULT_GOVERNOR_OPTIONS } from './defaults.ts';
import { JOB_CLASSES } from './types.ts';
import type { Governor, GovernorResult, GovernorStatus, Job, JobClass, Lease, LeaseKey, LeaseResult } from './types.ts';
import { assertEstimatedBytes, assertJob } from './validate.ts';

export interface GovernorOptions {
  /** Time source for per-job limits. Production passes `systemClock`; tests the test kit's FakeClock. */
  readonly clock: Clock;
  /** Running jobs at once. A group of `fresh` jobs sharing a requestId occupies one slot. */
  readonly concurrency?: number;
  /** Per-class bound on jobs waiting for a slot; a job of a full class resolves busy. */
  readonly maxQueue?: Partial<Record<JobClass, number>>;
  /** Per-class `retry_after` reported with busy, in milliseconds. */
  readonly busyRetryMs?: Partial<Record<JobClass, number>>;
  /** Machine-wide budget for leases, in bytes. Default Infinity. */
  readonly memoryBudgetBytes?: number;
}

/** The real Governor, with one read-only counter the interface does not need. */
export interface RealGovernor extends Governor {
  /** Errors thrown by `onEvict` callbacks. They are caught and counted, never propagated. */
  readonly evictErrors: number;
}

interface Waiting {
  readonly job: Job;
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

/** Merge the caller's per-class overrides over the defaults. */
function resolveClassValues(
  overrides: Partial<Record<JobClass, number>> | undefined,
  defaults: Readonly<Record<JobClass, number>>,
): Record<JobClass, number> {
  return {
    interactive: overrides?.interactive ?? defaults.interactive,
    fresh: overrides?.fresh ?? defaults.fresh,
    indexing: overrides?.indexing ?? defaults.indexing,
    maintenance: overrides?.maintenance ?? defaults.maintenance,
  };
}

/**
 * The production Governor (HST-03). Four priority classes (`interactive`, `fresh`, `indexing`,
 * `maintenance`, first come first served inside a class) share a concurrency cap. Each class has
 * its own bounded queue; a job that finds its class queue full resolves `busy` with that class's
 * `retry_after` and its function never runs. A job's time limit is armed with `Clock.after` when
 * the job starts and cancelled the moment the job settles, so a finished job leaves no timer
 * behind. Fairness across tenants and the machine memory budget default are Phase 4 (HRD-05); the
 * `tenant` field is carried but not used for scheduling.
 */
export function createGovernor(options: GovernorOptions): RealGovernor {
  const { clock } = options;
  const concurrency = options.concurrency ?? DEFAULT_GOVERNOR_OPTIONS.concurrency;
  const memoryBudgetBytes = options.memoryBudgetBytes ?? Infinity;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be an integer >= 1');
  }
  if (!(memoryBudgetBytes >= 0)) {
    throw new RangeError('memoryBudgetBytes must be >= 0');
  }
  const maxQueue = resolveClassValues(options.maxQueue, DEFAULT_GOVERNOR_OPTIONS.maxQueue);
  const busyRetryMs = resolveClassValues(options.busyRetryMs, DEFAULT_GOVERNOR_OPTIONS.busyRetryMs);

  let nextSeq = 0;
  let runningJobs = 0;
  /** Jobs waiting for a slot, one arrival-ordered list per class. */
  const queues: Record<JobClass, Waiting[]> = { interactive: [], fresh: [], indexing: [], maintenance: [] };
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

  function queuedCount(): number {
    return JOB_CLASSES.reduce((total, cls) => total + queues[cls].length, 0);
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
    let cancelLimit: (() => void) | undefined;

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelLimit?.();
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
    if (job.timeoutMs !== undefined && !settled) {
      cancelLimit = clock.after(job.timeoutMs, () => {
        if (settled) {
          return;
        }
        controller.abort();
        finish(() => resolve({ kind: 'timeout' }));
      });
    }
  }

  /** Take the best queued job that can start: highest class first, oldest first inside a class. */
  function takeStartable(): Waiting | undefined {
    for (const cls of JOB_CLASSES) {
      const waiting = queues[cls];
      const index = waiting.findIndex((candidate) => canStart(candidate.slotKey));
      if (index >= 0) {
        return waiting.splice(index, 1)[0];
      }
    }
    return undefined;
  }

  /** Start every queued job that can start. */
  function pump(): void {
    for (;;) {
      const next = takeStartable();
      if (next === undefined) {
        return;
      }
      next.start();
    }
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
        const waiting: Waiting = { job, slotKey, start: () => begin(waiting, fn, resolve, reject) };
        if (canStart(slotKey)) {
          waiting.start();
        } else if (queues[job.class].length >= maxQueue[job.class]) {
          resolve({ kind: 'busy', retry_after: busyRetryMs[job.class] });
        } else {
          queues[job.class].push(waiting);
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
          // A lease is taken on behalf of a read, so it is told the interactive class's delay.
          return { kind: 'busy', retry_after: busyRetryMs.interactive };
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
      return { queued: queuedCount(), running: runningJobs, leases: pool.size, leasedBytes };
    },

    get evictErrors() {
      return evictErrors;
    },
  };
}
