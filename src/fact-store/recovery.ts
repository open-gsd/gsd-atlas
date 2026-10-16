import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../facts/index.ts';
import type { Db } from '../sqlite/index.ts';

/** The dirty sentinel, beside the database. */
export const DIRTY_FILE_NAME = 'dirty';

/** The marker in the name of a database file that failed its check and was moved aside. */
export const QUARANTINE_MARK = '.corrupt-';

/** Test hook: how many `quick_check` runs the recovery code started in this process. */
export const recoveryCounters = { quickChecks: 0 };

export function dirtyMarkerPath(dir: string): string {
  return path.join(dir, DIRTY_FILE_NAME);
}

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

/** PLACEHOLDER for the red commit of plan 02-12. */
export function runQuickCheck(db: Db): boolean {
  void db;
  return true;
}

/** PLACEHOLDER for the red commit of plan 02-12. */
export function quarantine(dir: string, clock: Clock): { readonly movedTo: string } {
  void clock;
  return { movedTo: path.join(dir, 'nowhere') };
}

/** PLACEHOLDER for the red commit of plan 02-12. */
export function pruneQuarantine(dir: string, keep: number): void {
  void dir;
  void keep;
}

/** Keeps the dirty sentinel in step with write activity. */
export interface DirtyGuard {
  /** A write is starting: make sure the sentinel exists and stop its removal timer. */
  begin(): void;
  /** A write finished: restart the removal timer when no write is running. */
  end(): void;
  /** Remove the sentinel now (release and close), if this guard created it. */
  flush(): void;
}

/** PLACEHOLDER for the red commit of plan 02-12. */
export function createDirtyGuard(options: { readonly dir: string; readonly clock: Clock; readonly idleMs: number }): DirtyGuard {
  void options;
  return { begin: () => {}, end: () => {}, flush: () => {} };
}
