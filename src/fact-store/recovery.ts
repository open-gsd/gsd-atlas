/**
 * What the Fact Store does when it finds, or may have left, a broken file (STO-06, D-14, research Pattern 4).
 *
 * - A **dirty sentinel** (`dirty`, a file beside the database) is set before a batch of writes and removed after
 *   `store.dirtyIdleMs` of quiet, or at release and close. It is a plain file on purpose, so it still tells the
 *   truth when the database itself cannot be read.
 * - Opening a store that finds the sentinel runs `PRAGMA quick_check`. A store that fails it, or whose file is not
 *   a usable database at all, is **quarantined**: its files are moved aside to `facts.db.corrupt-<time>` (never
 *   deleted, so the evidence survives a bad rebuild; only the newest two are kept) and a fresh store is created.
 *
 * Everything here uses `fs` and the kit's `pragma` only. Closing the database before it is moved is the caller's
 * job.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../facts/index.ts';
import { DbError } from '../sqlite/index.ts';
import type { Db } from '../sqlite/index.ts';
import { STORE_FILE_NAME } from './schema.ts';

/** The dirty sentinel, beside the database. */
export const DIRTY_FILE_NAME = 'dirty';

/** The marker in the name of a database file that failed its check and was moved aside. */
export const QUARANTINE_MARK = '.corrupt-';

/** How many moved-aside databases are kept; older ones are removed when a newer one is made. */
export const KEEP_QUARANTINED = 2;

/** Test hook: how many `quick_check` runs the recovery code started in this process. */
export const recoveryCounters = { quickChecks: 0 };

/** Zero every counter. Tests call it in `afterEach`; production code never does. */
export function resetRecoveryCounters(): void {
  recoveryCounters.quickChecks = 0;
}

/** SQLite primary result codes for a damaged file: SQLITE_CORRUPT and SQLITE_NOTADB. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** True when `error` says the database file itself is damaged or is not a database. */
export function isCorruptionError(error: unknown): boolean {
  return error instanceof DbError && (error.sqliteCode === SQLITE_CORRUPT || error.sqliteCode === SQLITE_NOTADB);
}

export function dirtyMarkerPath(dir: string): string {
  return path.join(dir, DIRTY_FILE_NAME);
}

/** Create the sentinel if it is not there. Idempotent. */
export function markDirty(dir: string): void {
  const marker = dirtyMarkerPath(dir);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, String(process.pid));
}

export function clearDirty(dir: string): void {
  fs.rmSync(dirtyMarkerPath(dir), { force: true });
}

export function isDirty(dir: string): boolean {
  return fs.existsSync(dirtyMarkerPath(dir));
}

/**
 * `PRAGMA quick_check` through the kit. True when it answers `ok`. A check that cannot run because the file is
 * damaged counts as a failed check; any other error (busy, I/O) is not a verdict and propagates.
 */
export function runQuickCheck(db: Db): boolean {
  recoveryCounters.quickChecks += 1;
  try {
    return db.pragma('quick_check') === 'ok';
  } catch (error) {
    if (isCorruptionError(error)) return false;
    throw error;
  }
}

/** The companions SQLite keeps beside a database in WAL mode. */
const COMPANIONS = ['-wal', '-shm'] as const;

/** A moved-aside database's name (`STORE_FILE_NAME` + `QUARANTINE_MARK` + time [+ `.` + counter]); both parts are captured. */
const QUARANTINE_NAME = /^facts\.db\.corrupt-(\d+)(?:\.(\d+))?$/;

function taken(file: string): boolean {
  return fs.existsSync(file) || COMPANIONS.some((suffix) => fs.existsSync(`${file}${suffix}`));
}

/**
 * Move `facts.db` and its `-wal` and `-shm` files aside to `facts.db.corrupt-<time>` (a counter is added when
 * that name is taken, so an earlier moved-aside file is never overwritten) and remove the sentinel, which
 * described the old file. The caller has closed every connection.
 */
export function quarantine(dir: string, clock: Clock): { readonly movedTo: string } {
  const main = path.join(dir, STORE_FILE_NAME);
  const stamp = String(Math.max(0, Math.trunc(clock.now()))).padStart(15, '0');
  let movedTo = `${main}${QUARANTINE_MARK}${stamp}`;
  for (let counter = 1; taken(movedTo); counter += 1) movedTo = `${main}${QUARANTINE_MARK}${stamp}.${counter}`;
  if (fs.existsSync(main)) fs.renameSync(main, movedTo);
  for (const suffix of COMPANIONS) {
    if (fs.existsSync(`${main}${suffix}`)) fs.renameSync(`${main}${suffix}`, `${movedTo}${suffix}`);
  }
  clearDirty(dir);
  return { movedTo };
}

/** Remove all but the newest `keep` moved-aside databases (and their companions). Idempotent. */
export function pruneQuarantine(dir: string, keep: number): void {
  const found: Array<{ name: string; time: number; counter: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    const match = QUARANTINE_NAME.exec(name);
    if (match !== null) found.push({ name, time: Number(match[1]), counter: Number(match[2] ?? 0) });
  }
  found.sort((a, b) => b.time - a.time || b.counter - a.counter);
  for (const old of found.slice(Math.max(0, keep))) {
    const file = path.join(dir, old.name);
    fs.rmSync(file, { force: true });
    for (const suffix of COMPANIONS) fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

/** Keeps the dirty sentinel in step with write activity. */
export interface DirtyGuard {
  /** A write is starting: make sure the sentinel exists and stop its removal timer. */
  begin(): void;
  /** A write finished: when no write is running, restart the timer that removes the sentinel after `idleMs`. */
  end(): void;
  /** Remove the sentinel now (release and close), if this guard ever set it. */
  flush(): void;
}

export function createDirtyGuard(options: { readonly dir: string; readonly clock: Clock; readonly idleMs: number }): DirtyGuard {
  const { dir, clock, idleMs } = options;
  let running = 0;
  let owned = false;
  let cancelTimer: (() => void) | undefined;

  const stopTimer = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
  };

  return {
    begin() {
      running += 1;
      stopTimer();
      owned = true;
      try {
        markDirty(dir); // checks the file every time: it may have been removed by the timer or from outside
      } catch {
        // The sentinel is a hint. A directory that cannot take a new file cannot take a WAL file either, and the
        // write itself will say so; failing here would only hide that error.
      }
    },
    end() {
      running = Math.max(0, running - 1);
      if (running > 0) return;
      stopTimer();
      cancelTimer = clock.after(idleMs, () => {
        cancelTimer = undefined;
        if (running === 0) clearDirty(dir);
      });
    },
    flush() {
      stopTimer();
      if (owned) clearDirty(dir);
    },
  };
}
