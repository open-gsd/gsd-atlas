/**
 * The cross-process writer lease (STO-08, worktree-lifecycle ADR amendment 2026-10-16, research Pattern 3).
 *
 * One writer per repo store is enforced by a dedicated SQLite file, `lease.db`, in the store directory. It is
 * opened through the driver kit with a zero busy timeout; the leader runs `BEGIN EXCLUSIVE` and keeps that
 * connection open for its whole life. Whoever cannot take the lock is a follower. The operating system drops the
 * lock when the holder dies, SIGKILL included, so there is no stale-lease detection anywhere: a follower simply
 * tries again on a jittered timer (`startTakeover`).
 *
 * `lease.json` holds diagnostics only (pid, start time, version), written by rename. It is never read to decide
 * who owns the lease; the lock alone decides.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../facts/index.ts';
import { DbError, openDatabase } from '../sqlite/index.ts';
import type { Db } from '../sqlite/index.ts';

const LEASE_DB = 'lease.db';
const LEASE_JSON = 'lease.json';

/**
 * A busy open (SQLITE_BUSY on the lease file) is retried this many times, after the first try, before the
 * process concludes it is a follower. Two processes starting at the same instant can both hit a busy first
 * open (Windows first-open races, research Pitfall 7); the retries guarantee at least one of them gets through.
 */
const OPEN_RETRIES = 4;

/** The jittered pause between those retries, in milliseconds. */
const OPEN_PAUSE_MIN_MS = 20;
const OPEN_PAUSE_MAX_MS = 80;

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
  /** Source of `startedAt`. */
  readonly clock: Clock;
  readonly version: string;
  readonly pid?: number;
  /** Jitter source in [0, 1) for the open retries. Default `Math.random`. */
  readonly random?: () => number;
  /**
   * Opens `lease.db` with a zero busy timeout. `openFactStore` supplies one bound to the store's SQL engine, so
   * this file names no engine; the default is the kit's default engine.
   */
  readonly openDb?: (file: string) => Promise<Db>;
}

function isBusy(error: unknown): boolean {
  return error instanceof DbError && error.code === 'busy';
}

function parseInfo(text: string): LeaseInfo | null {
  try {
    const value = JSON.parse(text) as Partial<LeaseInfo> | null;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof value.pid === 'number' &&
      typeof value.startedAt === 'number' &&
      typeof value.version === 'string'
    ) {
      return { pid: value.pid, startedAt: value.startedAt, version: value.version };
    }
  } catch {
    // diagnostics only: unreadable means unknown
  }
  return null;
}

export function createLease(options: CreateLeaseOptions): Lease {
  const { dir, clock, version } = options;
  const openDb = options.openDb ?? ((file: string) => openDatabase(file, { timeoutMs: 0 }));
  const pid = options.pid ?? process.pid;
  const random = options.random ?? Math.random;
  const dbFile = path.join(dir, LEASE_DB);
  const jsonFile = path.join(dir, LEASE_JSON);

  /** The connection that holds `BEGIN EXCLUSIVE`; present exactly while the lease is held. */
  let holder: Db | undefined;
  let mine: LeaseInfo | undefined;
  let pending: Promise<boolean> | undefined;

  /** Write `lease.json` by writing a sibling file and renaming it over the target. Best effort: diagnostics only. */
  function writeInfo(info: LeaseInfo): void {
    const temp = path.join(dir, `${LEASE_JSON}.${pid}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(info));
      fs.renameSync(temp, jsonFile);
    } catch {
      fs.rmSync(temp, { force: true });
    }
  }

  function readInfo(): LeaseInfo | null {
    try {
      return parseInfo(fs.readFileSync(jsonFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function open(): Promise<Db | undefined> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await openDb(dbFile);
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (retry >= OPEN_RETRIES) return undefined;
        // Real timers on purpose: this is a short back-off between attempts to open a file another process is
        // using, not a time-driven behaviour a fake clock should control.
        const pause = OPEN_PAUSE_MIN_MS + random() * (OPEN_PAUSE_MAX_MS - OPEN_PAUSE_MIN_MS);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, pause);
        });
      }
    }
  }

  async function attempt(): Promise<boolean> {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const handle = await open();
    if (handle === undefined) return false;
    try {
      handle.exec('CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY)');
      handle.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      handle.close();
      if (isBusy(error)) return false;
      throw error;
    }
    holder = handle;
    mine = { pid, startedAt: clock.now(), version };
    writeInfo(mine);
    return true;
  }

  return {
    get held() {
      return holder !== undefined;
    },
    tryAcquire() {
      if (holder !== undefined) return Promise.resolve(true);
      pending ??= attempt().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    info() {
      return holder !== undefined ? (mine ?? null) : readInfo();
    },
    async release() {
      await pending?.catch(() => false);
      const handle = holder;
      if (handle === undefined) return;
      holder = undefined;
      try {
        handle.exec('ROLLBACK');
      } catch {
        // closing the connection ends the transaction either way
      }
      handle.close();
      // Remove the diagnostics only if they still describe this process; a new leader may already have replaced them.
      if (readInfo()?.pid === pid) fs.rmSync(jsonFile, { force: true });
      mine = undefined;
    },
  };
}

export interface TakeoverOptions {
  readonly retryMinMs: number;
  readonly retryMaxMs: number;
  /** Jitter source in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
}

/**
 * Try to take `lease` now and then until it is taken: after a delay of `retryMinMs` plus a random share of the
 * range up to `retryMaxMs` (so followers do not retry in step), measured on `clock`. Calls `onAcquired` once when
 * a try succeeds and stops. Returns a cancel function (idempotent) that stops the retries.
 */
export function startTakeover(
  lease: Lease,
  clock: Clock,
  options: TakeoverOptions,
  onAcquired: () => void,
): () => void {
  const random = options.random ?? Math.random;
  let cancelled = false;
  let cancelTimer: (() => void) | undefined;

  const arm = (): void => {
    if (cancelled) return;
    const delay = options.retryMinMs + random() * (options.retryMaxMs - options.retryMinMs);
    cancelTimer = clock.after(delay, () => {
      void tryOnce();
    });
  };

  const tryOnce = async (): Promise<void> => {
    if (cancelled) return;
    let acquired = false;
    try {
      acquired = await lease.tryAcquire();
    } catch {
      acquired = false; // a failed try is simply tried again
    }
    if (cancelled) return;
    if (acquired) {
      onAcquired();
      return;
    }
    arm();
  };

  arm();
  return () => {
    cancelled = true;
    cancelTimer?.();
  };
}
