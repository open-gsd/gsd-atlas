import type { JobClass } from './types.ts';

/** Defaults for `createGovernor`. Every class has a finite queue bound, so saturation yields busy (HST-03). */
export interface GovernorDefaults {
  readonly concurrency: number;
  readonly maxQueue: Readonly<Record<JobClass, number>>;
  readonly busyRetryMs: Readonly<Record<JobClass, number>>;
}

/**
 * Source: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved),
 * keys `governor.concurrency`, `governor.maxQueue` and `governor.busyRetryMs`. Change the values
 * there first; this object only carries them.
 *
 * `maxQueue` bounds the jobs of one class that wait for a slot. `busyRetryMs` is the `retry_after`
 * in milliseconds that a rejected job of that class is told.
 */
export const DEFAULT_GOVERNOR_OPTIONS: GovernorDefaults = {
  concurrency: 4,
  maxQueue: { interactive: 64, fresh: 64, indexing: 1024, maintenance: 8 },
  busyRetryMs: { interactive: 250, fresh: 250, indexing: 1000, maintenance: 5000 },
};
