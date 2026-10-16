import type { Clock } from '../facts/index.ts';
import type { Governor, JobClass } from './types.ts';

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

export function createGovernor(options: GovernorOptions): RealGovernor {
  throw new Error(`createGovernor is not implemented (clock supplied: ${String(options.clock !== undefined)})`);
}
