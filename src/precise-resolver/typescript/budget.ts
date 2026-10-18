/**
 * The compiler's memory budget (plan 03-27, D-21, D-22, TSM-05, research Pitfall 4).
 *
 * One machine-wide budget, a share of RAM (25 percent by default). `deriveBudget` turns the machine's RAM into the three
 * numbers a worker is started with: the budget itself, the V8 heap flag (`--max-old-space-size`, the backstop) and the RSS
 * limit the worker's sampler thread enforces. `createMemoryBudget` is the ledger the worker pool reserves against, with a
 * least-recently-used order so that a request which does not fit can ask the pool to stop an idle worker.
 *
 * The numbers are the approved constants of 03-CONSTANTS.md (`precise.memoryBudgetPercent`, `precise.heapShareOfBudget`,
 * `precise.rssSampleMs`, `precise.minBudgetMb`, `precise.idleExitMs`); nothing here is invented. Pure: no process, no timer.
 */

/** Approved values of 03-CONSTANTS.md (`precise.*`), owned by plan 03-27. */
export const MEMORY_DEFAULTS = Object.freeze({
  /** `precise.memoryBudgetPercent`: the share of RAM the compiler may use, machine-wide (D-21, DESIGN A25). */
  percent: 25,
  /** `precise.heapShareOfBudget`: RSS exceeded the heap by about 130 MB on gsd-core (430 versus 296 MB). */
  heapShare: 0.8,
  /** `precise.rssSampleMs`: the sampler's period; cheap, far below the 5 s update budget. */
  sampleMs: 250,
  /** `precise.minBudgetMb`: below this the tier answers `memory_budget` without starting a worker. */
  minMb: 512,
  /** `precise.idleExitMs`: an idle worker is released after this long (about 400 MB freed). */
  idleExitMs: 300_000,
});

/**
 * Inside a worker, programs of other configs are dropped, least recently used first, once RSS passes this share of the
 * limit (research Pitfall 4: an incremental update holds the old and the new program, about 1.5 times the steady size, so
 * the limit must leave that headroom). The share is part of the plan text, not of 03-CONSTANTS.md.
 */
export const PROGRAM_EVICT_FRACTION = 0.7;

/** The largest heap value the exact worker shape accepts (`--max-old-space-size=[0-9]{1,6}`). */
const MAX_HEAP_MB = 999_999;
const BYTES_PER_MB = 1_048_576;

export interface DeriveInput {
  /** The machine's RAM in bytes (`os.totalmem()`). */
  readonly totalMemBytes: number;
  /** The share of RAM, 1 to 90. */
  readonly percent: number;
  /** The share of the budget that is V8 heap, above 0 and at most 1. */
  readonly heapShare: number;
  /** The floor below which the budget is not usable, in megabytes. */
  readonly minMb: number;
}

export interface DerivedBudget {
  /** The machine-wide budget in whole megabytes. */
  readonly budgetMb: number;
  /** The V8 old-space limit of a worker in whole megabytes; always fits the six-digit pattern of the worker shape. */
  readonly heapMb: number;
  /** The RSS limit the worker's sampler enforces; the heap plus what the process needs besides it, so the whole budget. */
  readonly rssLimitMb: number;
  /** False when the budget is below the floor: no worker is started. */
  readonly usable: boolean;
}

/** What the machine allows. Throws a RangeError for a percent outside 1 to 90, a heap share outside (0, 1], a negative floor or a RAM value that is not a positive finite number. */
export function deriveBudget(input: DeriveInput): DerivedBudget {
  const { totalMemBytes, percent, heapShare, minMb } = input;
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) throw new RangeError('deriveBudget: the RAM must be a positive finite number of bytes');
  if (!Number.isFinite(percent) || percent < 1 || percent > 90) throw new RangeError('deriveBudget: the percent must be between 1 and 90');
  if (!Number.isFinite(heapShare) || heapShare <= 0 || heapShare > 1) throw new RangeError('deriveBudget: the heap share must be above 0 and at most 1');
  if (!Number.isFinite(minMb) || minMb < 0) throw new RangeError('deriveBudget: the floor must not be negative');
  const budgetMb = Math.floor(((totalMemBytes / BYTES_PER_MB) * percent) / 100);
  const heapMb = Math.min(MAX_HEAP_MB, Math.floor(budgetMb * heapShare));
  return { budgetMb, heapMb, rssLimitMb: budgetMb, usable: budgetMb >= minMb };
}

export interface MemoryBudgetConfig {
  readonly percent: number;
  readonly heapShare: number;
  readonly minMb: number;
}

export interface MemoryBudgetOptions {
  /** The machine's RAM in bytes. A test injects it; the composition root passes `os.totalmem()`. */
  readonly totalMemBytes: number;
  /** Default: the approved constants. */
  readonly config?: Partial<MemoryBudgetConfig>;
}

export interface BudgetStatus {
  readonly budgetMb: number;
  readonly reservedMb: number;
  readonly usable: boolean;
  /** Who holds a reservation, least recently used first. */
  readonly owners: ReadonlyArray<{ readonly owner: string; readonly mb: number }>;
}

/**
 * Asked to stop the worker of `victim`. Returns true when it did (the reservation is then released by the budget), false
 * when it must not be stopped (a request is in flight).
 */
export type Evict = (victim: string) => Promise<boolean>;

export interface MemoryBudget {
  /** The numbers this machine's RAM gives. */
  readonly derived: DerivedBudget;
  /**
   * Reserve `mb` for `owner`. When it does not fit, idle owners are asked to give theirs up, least recently used first,
   * through `evict`, until it fits. False when it still does not fit (or when the budget is not usable, or `mb` is more
   * than the whole budget): nothing is reserved then. An owner that already holds a reservation keeps it and is touched.
   */
  reserve(owner: string, mb: number, evict: Evict): Promise<boolean>;
  /** Give `owner`'s reservation back. Safe when it holds none. */
  release(owner: string): void;
  /** Mark `owner` as the most recently used. */
  touch(owner: string): void;
  status(): BudgetStatus;
}

export function createMemoryBudget(options: MemoryBudgetOptions): MemoryBudget {
  const derived = deriveBudget({
    totalMemBytes: options.totalMemBytes,
    percent: options.config?.percent ?? MEMORY_DEFAULTS.percent,
    heapShare: options.config?.heapShare ?? MEMORY_DEFAULTS.heapShare,
    minMb: options.config?.minMb ?? MEMORY_DEFAULTS.minMb,
  });
  // Insertion order of a Map is the recency order: `touch` re-inserts, so the first entry is the least recently used.
  const held = new Map<string, number>();
  let reserved = 0;
  // Reservations are decided one at a time: two concurrent requests must not both count the same free megabytes.
  let queue: Promise<unknown> = Promise.resolve();

  function release(owner: string): void {
    const mb = held.get(owner);
    if (mb === undefined) return;
    held.delete(owner);
    reserved -= mb;
  }

  function touch(owner: string): void {
    const mb = held.get(owner);
    if (mb === undefined) return;
    held.delete(owner);
    held.set(owner, mb);
  }

  async function decide(owner: string, mb: number, evict: Evict): Promise<boolean> {
    if (!derived.usable || !Number.isInteger(mb) || mb < 1 || mb > derived.budgetMb) return false;
    if (held.has(owner)) {
      touch(owner);
      return true;
    }
    for (const victim of [...held.keys()]) {
      if (reserved + mb <= derived.budgetMb) break;
      if (await evict(victim)) release(victim);
    }
    if (reserved + mb > derived.budgetMb) return false;
    held.set(owner, mb);
    reserved += mb;
    return true;
  }

  return {
    derived,
    reserve(owner, mb, evict) {
      const run = queue.then(() => decide(owner, mb, evict));
      queue = run.catch(() => undefined);
      return run;
    },
    release,
    touch,
    status() {
      return { budgetMb: derived.budgetMb, reservedMb: reserved, usable: derived.usable, owners: [...held].map(([owner, mb]) => ({ owner, mb })) };
    },
  };
}
