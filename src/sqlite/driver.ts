/** Public types of the SQLite driver kit. Callers see these and never a driver's own types. */

export type DriverName = 'node:sqlite' | 'better-sqlite3';

/** Which JavaScript type INTEGER columns read back as. */
export type BigIntMode = 'number' | 'bigint';

/** A value that can be bound as a parameter or read from a column. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export type Row = Record<string, SqlValue>;

export interface RunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: readonly SqlValue[]): RunResult;
  get(...params: readonly SqlValue[]): Row | undefined;
  all(...params: readonly SqlValue[]): Row[];
}

export interface OpenOptions {
  /** Open with the read-only flag. Changes no journal mode and never creates the file. */
  readonly readOnly?: boolean;
  /** Busy timeout in milliseconds. Callers should pass it explicitly (the default is 0, fail at once). */
  readonly timeoutMs?: number;
  /**
   * `'number'` (default): INTEGER reads as a JavaScript number and a value beyond 2^53 throws
   * IntegerOutOfRangeError. `'bigint'`: every INTEGER reads as a bigint.
   */
  readonly bigints?: BigIntMode;
  /** A driver name, or an injected driver module (tests). Default `'node:sqlite'`. */
  readonly driver?: DriverName | DriverModule;
}

/** Pragmas the kit will run, by name. Anything else is refused. */
export const PRAGMA_ALLOWLIST = [
  'journal_mode',
  'synchronous',
  'foreign_keys',
  'user_version',
  'busy_timeout',
  'wal_autocheckpoint',
  'auto_vacuum',
  'quick_check',
  'integrity_check',
  'page_size',
  'mmap_size',
  'cache_size',
  'temp_store',
  'secure_delete',
  'optimize',
  // The Fact Store's maintenance needs (phase 2): compaction frees pages and truncates the WAL, the store
  // sizes its journal, and status/compaction read the two size counters. All stay on the kit so the store
  // never bypasses it with raw exec (research Pattern 4).
  'incremental_vacuum',
  'wal_checkpoint',
  'journal_size_limit',
  'page_count',
  'freelist_count',
] as const;

export type PragmaName = (typeof PRAGMA_ALLOWLIST)[number];

/**
 * A SQLite connection. There is deliberately no `loadExtension`: extension loading stays off in 1.0
 * (sqlite-vec is post-1.0).
 */
export interface Db {
  readonly driver: DriverName;
  readonly path: string;
  readonly sqliteVersion: string;
  /** Run one or more statements with no parameters and no result. */
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /**
   * Run an allowlisted pragma and return the first column of the first row (`undefined` when it returns
   * no row). Pass `value` to set it; the value must match `^[A-Za-z_]+$` or be a finite integer.
   */
  pragma(name: PragmaName, value?: string | number): SqlValue | undefined;
  /** `BEGIN IMMEDIATE` ... `COMMIT`, or `ROLLBACK` when `fn` throws. Nesting throws: use `savepoint`. */
  transaction<T>(fn: () => T): T;
  /** `SAVEPOINT` ... `RELEASE`, or `ROLLBACK TO` then `RELEASE` when `fn` throws. May nest. */
  savepoint<T>(name: string, fn: () => T): T;
  /** Idempotent. Close every connection before deleting the files (Windows keeps them locked). */
  close(): void;
}

/** An implementation of the kit for one SQL engine. `open` returns a raw connection with no open policy applied. */
export interface DriverModule {
  readonly name: DriverName;
  open(path: string, options: Required<Pick<OpenOptions, 'readOnly' | 'timeoutMs' | 'bigints'>>): Db;
}
