import type { DriverModule, DriverName } from '../sqlite/index.ts';
import type { Clock } from '../facts/index.ts';

/** Diagnostics about the process that holds the writer lease. Never used to decide ownership. */
export interface LeaseInfo {
  readonly pid: number;
  /** `Clock.now()` of the holder when it took the lease. */
  readonly startedAt: number;
  readonly version: string;
}

/** The cross-process writer lease of one store directory. */
export interface Lease {
  /** True while this object holds the lease. */
  readonly held: boolean;
  /** Try to take the lease. Resolves true when held (also when it already was), false when another holder has it. */
  tryAcquire(): Promise<boolean>;
  /** The holder's diagnostics: this process's own when held, otherwise what `lease.json` says (or null). */
  info(): LeaseInfo | null;
  /** Give the lease up. Safe to call twice. */
  release(): Promise<void>;
}

export interface CreateLeaseOptions {
  /** The store directory; `lease.db` and `lease.json` live in it. */
  readonly dir: string;
  readonly clock: Clock;
  readonly version: string;
  readonly pid?: number;
  /** Jitter source in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
  /** SQLite driver for `lease.db`. Default `node:sqlite`. */
  readonly driver?: DriverName | DriverModule;
}

/** PLACEHOLDER for the red commit of plan 02-12: nothing is ever held. */
export function createLease(options: CreateLeaseOptions): Lease {
  void options;
  return {
    held: false,
    tryAcquire: async () => false,
    info: () => null,
    release: async () => {},
  };
}

export interface TakeoverOptions {
  readonly retryMinMs: number;
  readonly retryMaxMs: number;
  readonly random?: () => number;
}

/** PLACEHOLDER for the red commit of plan 02-12: never retries. */
export function startTakeover(
  lease: Lease,
  clock: Clock,
  options: TakeoverOptions,
  onAcquired: () => void,
): () => void {
  void lease;
  void clock;
  void options;
  void onAcquired;
  return () => {};
}
