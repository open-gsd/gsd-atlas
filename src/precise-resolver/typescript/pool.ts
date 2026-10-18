/**
 * The machine-wide worker pool (plan 03-27, D-21, TSM-05, DESIGN A25).
 *
 * One pool per Host owns the compiler workers of every tenant under one {@link MemoryBudget}. Before a worker starts, the
 * pool reserves its share of the budget. When the budget cannot hold another worker, the least recently used IDLE worker is
 * stopped to make room, and its tenant restarts it on demand (a cold start, never a wrong answer). A worker with a request
 * in flight is never stopped: the newcomer is answered `memory_budget` instead. When even an empty pool could not hold the
 * request (a budget below the floor, or a request larger than the whole budget) the answer is `memory_budget` and nothing
 * starts. A worker idle for `precise.idleExitMs` is released.
 *
 * The pool also keeps the memory-stop latch of each tenant: after a worker was stopped for memory the tier answers
 * `memory_budget` for that project context without starting anything (T-03-272). No timer belongs to the latch.
 *
 * The pool knows nothing about processes: a worker is whatever `start` returns, with an `alive` flag and a `stop`. Timers
 * come from the injected Clock (cancellable); without one they are real timers that never keep the process alive.
 */
import type { Clock } from '../../facts/index.ts';
import { ResolverFailure } from '../../facts/index.ts';
import { MEMORY_DEFAULTS } from './budget.ts';
import type { MemoryBudget } from './budget.ts';

/** What the pool needs of a worker. */
export interface PoolWorker {
  /** False once the worker has ended, by itself or because it was stopped. */
  readonly alive: boolean;
  /** End the worker and resolve when it is gone. Safe to call twice. */
  stop(): Promise<void>;
}

export interface AcquireOptions<H extends PoolWorker> {
  /** Start a worker holding `mb` megabytes. Default: the pool's own `start`. */
  readonly start?: (mb: number) => Promise<H>;
  /** False when the running worker was started for other inputs and must be replaced. Default: any running worker will do. */
  readonly matches?: (worker: H) => boolean;
  /** The share of the budget this worker holds. Default: the pool's `workerMb`. */
  readonly mb?: number;
}

export interface WorkerPoolDeps<H extends PoolWorker> {
  readonly budget: MemoryBudget;
  /** Start a worker for `tenant` holding `mb` megabytes; used when `acquire` brings no `start` of its own. */
  readonly start?: (tenant: string, mb: number) => Promise<H>;
  /** The time source for the idle timers. Default: real timers that are unref'd. */
  readonly clock?: Clock;
  /** `precise.idleExitMs`. */
  readonly idleExitMs?: number;
  /** The share of the budget one worker holds: its RSS limit. Default: the budget's derived RSS limit. */
  readonly workerMb?: number;
}

export interface PoolStatus {
  readonly budgetMb: number;
  readonly reservedMb: number;
  readonly usable: boolean;
  readonly workers: ReadonlyArray<{ readonly tenant: string; readonly mb: number; readonly busy: boolean }>;
}

export interface WorkerPool<H extends PoolWorker> {
  /**
   * The worker of `tenant`, started when none runs (or the one running does not `match`), marked busy until `release`.
   * Rejects with a `memory_budget` ResolverFailure when the budget cannot hold it; a failed start rejects with its own error
   * and gives the reservation back.
   */
  acquire(tenant: string, options?: AcquireOptions<H>): Promise<H>;
  /** The request is done: the worker is idle (and released after `idleExitMs`), or dropped when it ended by itself. */
  release(tenant: string): void;
  /** `handle` ended by itself: free its share now unless a request still holds it (then `release` does). */
  notifyExit(tenant: string, handle: H): void;
  /** End a tenant: stop its worker, free its share and forget its latch. */
  drop(tenant: string): Promise<void>;
  /** Remember that `tenant`'s worker was stopped for memory under the project context `key`. */
  markMemoryStop(tenant: string, key: string): void;
  /** True while `tenant` is latched for `key`. A different key clears the latch and answers false. */
  memoryStopped(tenant: string, key: string): boolean;
  /** Forget the latch of `tenant`, or of every tenant when none is named. */
  clearMemoryStop(tenant?: string): void;
  status(): PoolStatus;
  /** Stop every worker and cancel every timer. Safe to call twice; later acquires answer `memory_budget`. */
  close(): Promise<void>;
}

interface Entry<H extends PoolWorker> {
  readonly handle: H;
  readonly mb: number;
  /** Requests holding the worker (acquired, not yet released). */
  holds: number;
  cancelIdle: (() => void) | undefined;
}

const noop = (): void => {};

/** A real timer that never keeps the process alive. */
function unrefAfter(ms: number, fn: () => void): () => void {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => {
    clearTimeout(handle);
  };
}

export function createWorkerPool<H extends PoolWorker>(deps: WorkerPoolDeps<H>): WorkerPool<H> {
  const { budget } = deps;
  const after = deps.clock === undefined ? unrefAfter : (ms: number, fn: () => void) => (deps.clock as Clock).after(ms, fn);
  const idleExitMs = deps.idleExitMs ?? MEMORY_DEFAULTS.idleExitMs;
  const workerMb = deps.workerMb ?? budget.derived.rssLimitMb;
  const entries = new Map<string, Entry<H>>();
  /** Tenants whose worker is being started: they hold a reservation but have no worker to stop yet. */
  const starting = new Set<string>();
  const stops = new Map<string, string>();
  let closed = false;

  const refusal = (): ResolverFailure => new ResolverFailure('memory_budget', 'the memory budget cannot hold another compiler worker');

  function forget(tenant: string, entry: Entry<H>): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    if (entries.get(tenant) === entry) entries.delete(tenant);
    budget.release(tenant);
  }

  /** The budget asks to stop `victim`'s worker: yes when it is idle (or gone), no when a request holds it or it is starting. */
  async function evict(victim: string): Promise<boolean> {
    if (starting.has(victim)) return false;
    const entry = entries.get(victim);
    if (entry === undefined) return true;
    if (entry.holds > 0) return false;
    forget(victim, entry);
    await entry.handle.stop().catch(noop);
    return true;
  }

  function armIdle(tenant: string, entry: Entry<H>): void {
    entry.cancelIdle?.();
    entry.cancelIdle = after(idleExitMs, () => {
      entry.cancelIdle = undefined;
      if (entries.get(tenant) !== entry || entry.holds > 0) return;
      forget(tenant, entry);
      void entry.handle.stop().catch(noop);
    });
  }

  return {
    async acquire(tenant, options = {}) {
      if (closed) throw refusal();
      const existing = entries.get(tenant);
      if (existing !== undefined) {
        if (existing.handle.alive && (options.matches?.(existing.handle) ?? true)) {
          existing.holds += 1;
          existing.cancelIdle?.();
          existing.cancelIdle = undefined;
          budget.touch(tenant);
          return existing.handle;
        }
        // The running worker ended, or was started for other inputs: it is replaced, and its share is asked for again.
        forget(tenant, existing);
        await existing.handle.stop().catch(noop);
      }
      const mb = options.mb ?? workerMb;
      starting.add(tenant);
      try {
        if (!(await budget.reserve(tenant, mb, evict))) throw refusal();
        const start = options.start ?? (deps.start === undefined ? undefined : (share: number) => (deps.start as NonNullable<typeof deps.start>)(tenant, share));
        if (start === undefined) throw new TypeError('createWorkerPool: no start function');
        let handle: H;
        try {
          handle = await start(mb);
        } catch (error) {
          budget.release(tenant);
          throw error;
        }
        if (closed) {
          budget.release(tenant);
          await handle.stop().catch(noop);
          throw refusal();
        }
        entries.set(tenant, { handle, mb, holds: 1, cancelIdle: undefined });
        return handle;
      } finally {
        starting.delete(tenant);
      }
    },

    release(tenant) {
      const entry = entries.get(tenant);
      if (entry === undefined) return;
      entry.holds = Math.max(0, entry.holds - 1);
      if (entry.holds > 0) return;
      budget.touch(tenant);
      if (!entry.handle.alive) {
        forget(tenant, entry);
        return;
      }
      armIdle(tenant, entry);
    },

    notifyExit(tenant, handle) {
      const entry = entries.get(tenant);
      if (entry === undefined || entry.handle !== handle || entry.holds > 0) return;
      forget(tenant, entry);
    },

    async drop(tenant) {
      stops.delete(tenant);
      const entry = entries.get(tenant);
      if (entry === undefined) return;
      forget(tenant, entry);
      await entry.handle.stop().catch(noop);
    },

    markMemoryStop(tenant, key) {
      stops.set(tenant, key);
    },

    memoryStopped(tenant, key) {
      const latched = stops.get(tenant);
      if (latched === undefined) return false;
      if (latched === key) return true;
      stops.delete(tenant);
      return false;
    },

    clearMemoryStop(tenant) {
      if (tenant === undefined) stops.clear();
      else stops.delete(tenant);
    },

    status() {
      const held = budget.status();
      return {
        budgetMb: held.budgetMb,
        reservedMb: held.reservedMb,
        usable: held.usable,
        workers: [...entries].map(([tenant, entry]) => ({ tenant, mb: entry.mb, busy: entry.holds > 0 })),
      };
    },

    async close() {
      closed = true;
      const all = [...entries];
      for (const [tenant, entry] of all) forget(tenant, entry);
      stops.clear();
      await Promise.all(all.map(([, entry]) => entry.handle.stop().catch(noop)));
    },
  };
}
