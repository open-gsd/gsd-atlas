/**
 * The Governor seam (tenant-composition ADR decision 4, ARCHITECTURE seam 5). The signature in
 * this file is final: Indexer and Query call `run` from Phase 2 and the compiler pool needs
 * `lease` with its eviction callback in Phase 3, so later phases add implementations, not
 * parameters. Only a no-op and a fake exist in Phase 1 (D-10); real scheduling, weighted
 * round-robin and cross-tenant memory budgets land in Phases 2 and 4.
 */

/**
 * Priority classes, highest first: `interactive` reads outrank `fresh` (an `ensureFresh` pass
 * made on behalf of a read), which outranks `indexing`, which outranks `maintenance`.
 */
export type JobClass = 'interactive' | 'fresh' | 'indexing' | 'maintenance';

/** The priority classes in priority order, highest first. */
export const JOB_CLASSES: readonly JobClass[] = ['interactive', 'fresh', 'indexing', 'maintenance'];

/** One unit of schedulable work. */
export interface Job {
  /** The tenant (one repo composition) the work is for. */
  readonly tenant: string;
  readonly class: JobClass;
  /**
   * Relative cost of the job. Informational in Phase 1: the doubles do not weigh it, the real
   * Governor will (Phase 4).
   */
  readonly cost: number;
  /**
   * The request this job serves. `ensureFresh` takes ONE `fresh` priority slot per request, not
   * one per call (D-17): `fresh` jobs that share a `requestId` occupy a single slot and run
   * concurrently. For the other classes the field is ignored.
   */
  readonly requestId?: string;
  /**
   * Per-job time limit in milliseconds, measured from when the job starts running (not from
   * submission). On expiry the signal passed to the function is aborted, the job's slot is
   * released AT ONCE and `run` resolves `timeout`.
   *
   * Contract for callers: a job that sets `timeoutMs` MUST honour its `AbortSignal` (stop its work
   * when it aborts), or set no timeout. The Governor cannot stop a function: one that ignores the
   * signal keeps running after its slot was freed, outside the concurrency cap. Keeping the slot
   * until the function settles was rejected on purpose: one hung job would hold its slot forever
   * and starve its class. Every job the Host and the Indexer submit today sets no timeout.
   */
  readonly timeoutMs?: number;
}

/**
 * Outcome of `run`. `ok` carries the function's value. `busy` means the job was not admitted and
 * the function never ran. `timeout` means the per-job time limit expired. `retry_after` is a
 * delay in MILLISECONDS. A function that rejects makes `run` reject with that same error; it is
 * never reported as `busy` or `timeout`.
 *
 * `timeout` is reported when the limit expires, not when the function stops: the slot is already
 * free and the signal already aborted, but a function that ignores its `AbortSignal` may still be
 * running (see {@link Job.timeoutMs}). Its eventual result or error is dropped.
 */
export type GovernorResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'busy'; readonly retry_after: number }
  | { readonly kind: 'timeout' };

/**
 * Identifies a compiler-program pool entry. The pool's LRU keys on the FILE SET alone (D-17):
 * two tenants leasing the same `fileSetId` share one entry and one memory charge. `tenant` says
 * who is asking; it does not partition the entry.
 */
export interface LeaseKey {
  readonly tenant: string;
  readonly fileSetId: string;
}

/** A hold on a pool entry. Releasing is idempotent. A held entry is never evicted. */
export interface Lease {
  readonly key: LeaseKey;
  release(): void;
}

/** Outcome of `lease`. `retry_after` is in MILLISECONDS. */
export type LeaseResult =
  | { readonly kind: 'ok'; readonly lease: Lease }
  | { readonly kind: 'busy'; readonly retry_after: number };

/** A point-in-time snapshot. Every field is a non-negative integer. */
export interface GovernorStatus {
  /** Jobs admitted to the queue and waiting for a slot. */
  readonly queued: number;
  /** Jobs whose function is currently running. */
  readonly running: number;
  /** Pool entries currently charged (held or idle-but-cached). */
  readonly leases: number;
  /** Bytes charged to those entries. A shared entry is charged once. */
  readonly leasedBytes: number;
}

export interface Governor {
  /**
   * Run `fn` under the Governor's scheduling, priority order `interactive > fresh > indexing >
   * maintenance` with FIFO inside a class. `fn` receives an `AbortSignal` that is aborted when
   * the job times out; `fn` must honour it when the job sets `timeoutMs` (see {@link Job.timeoutMs}).
   */
  run<T>(job: Job, fn: (signal: AbortSignal) => Promise<T>): Promise<GovernorResult<T>>;
  /**
   * Take a hold on the compiler-program pool entry for `key.fileSetId`, charging
   * `estimatedBytes` (a non-negative integer) to the machine-wide budget unless the entry
   * already exists, in which case the entry is shared and not charged again. To make room the
   * Governor evicts least-recently-used entries that have no holders, calling `onEvict` once per
   * evicted entry; a callback that throws must not stop the eviction. Returns `busy` when room
   * cannot be made.
   */
  lease(key: LeaseKey, estimatedBytes: number, onEvict: () => void): Promise<LeaseResult>;
  status(): GovernorStatus;
}
