import type { Db } from '../sqlite/index.ts';

/** One forward-only schema step. `up` runs inside a transaction together with the `user_version` bump. */
export interface Migration {
  readonly version: number;
  up(db: Db): void;
}

/** Ordered, ascending, starting at 1. Not implemented yet (red). */
export const MIGRATIONS: readonly Migration[] = [];
