import type { BigIntMode, Db, DriverName, PragmaName, RunResult, SqlValue, Statement } from './driver.ts';
import { PRAGMA_ALLOWLIST } from './driver.ts';
import { DbError, IntegerOutOfRangeError } from './errors.ts';
import type { DbErrorCode } from './errors.ts';
import {
  checkParams,
  checkPragmaValue,
  checkSavepointName,
  integerOut,
  rowOut,
  valueOut,
} from './normalize.ts';

/**
 * What an adapter must supply. Everything the two drivers have in common (pragma allowlist, transactions,
 * savepoints, row and bigint normalisation, error mapping) lives in `createDb`, not in the adapters.
 *
 * A raw statement returns every INTEGER as a bigint and rows as the driver's own objects; `createDb` converts.
 */
export interface RawStatement {
  run(params: readonly unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(params: readonly unknown[]): unknown;
  all(params: readonly unknown[]): unknown[];
}

export interface RawConnection {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  /** Close the connection. `createDb` guarantees it is called at most once. */
  close(): void;
  /** The SQLite primary result code carried by a driver error, or undefined when `error` is not a SQLite error. */
  primaryCode(error: unknown): number | undefined;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CONSTRAINT = 19;

function codeFor(primary: number): DbErrorCode {
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return 'busy';
  if (primary === SQLITE_READONLY) return 'readonly';
  if (primary === SQLITE_CONSTRAINT) return 'constraint';
  return 'other';
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createDb(
  raw: RawConnection,
  meta: { driver: DriverName; path: string; bigints: BigIntMode },
): Db {
  const { bigints } = meta;
  let closed = false;
  let inTransaction = false;
  let savepointDepth = 0;

  /** Map driver errors to DbError; our own errors and non-SQLite errors pass through unchanged. */
  const guard = <T>(fn: () => T): T => {
    if (closed) throw new DbError('other', 'database is closed');
    try {
      return fn();
    } catch (error) {
      if (error instanceof DbError || error instanceof IntegerOutOfRangeError || error instanceof TypeError) {
        throw error;
      }
      const primary = raw.primaryCode(error);
      if (primary === undefined) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new DbError(codeFor(primary), message, primary, { cause: error });
    }
  };

  const wrapStatement = (sql: string): Statement => {
    const stmt = guard(() => raw.prepare(sql));
    const runResult = (r: { changes: number | bigint; lastInsertRowid: number | bigint }): RunResult => ({
      changes: typeof r.changes === 'bigint' ? integerOut(r.changes, bigints) : r.changes,
      lastInsertRowid:
        typeof r.lastInsertRowid === 'bigint' ? integerOut(r.lastInsertRowid, bigints) : r.lastInsertRowid,
    });
    return {
      run: (...params) => guard(() => runResult(stmt.run(checkParams(params)))),
      get: (...params) =>
        guard(() => {
          const row = stmt.get(checkParams(params));
          return row === undefined || row === null ? undefined : rowOut(row, bigints);
        }),
      all: (...params) => guard(() => stmt.all(checkParams(params)).map((row) => rowOut(row, bigints))),
    };
  };

  const sqliteVersion = guard(() => {
    const row = raw.prepare('select sqlite_version() as v').get([]);
    return String((row as { v: unknown }).v);
  });

  const db: Db = {
    driver: meta.driver,
    path: meta.path,
    sqliteVersion,
    exec: (sql) => guard(() => raw.exec(sql)),
    prepare: wrapStatement,
    pragma(name: PragmaName, value?: string | number): SqlValue | undefined {
      if (!(PRAGMA_ALLOWLIST as readonly string[]).includes(name)) {
        throw new TypeError(`pragma ${JSON.stringify(name)} is not on the allowlist`);
      }
      // Only validated tokens reach the SQL text; nothing here is data.
      const sql = value === undefined ? `PRAGMA ${name}` : `PRAGMA ${name} = ${checkPragmaValue(value)}`;
      return guard(() => {
        const row = raw.prepare(sql).get([]);
        if (row === undefined || row === null) return undefined;
        const first = Object.values(row as Record<string, unknown>)[0];
        return valueOut(first, bigints);
      });
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction || savepointDepth > 0) {
        throw new Error('transaction() cannot nest; use savepoint() inside a transaction');
      }
      guard(() => raw.exec('BEGIN IMMEDIATE'));
      inTransaction = true;
      try {
        const result = fn();
        if (isThenable(result)) {
          throw new TypeError('transaction() callback must be synchronous; it returned a promise');
        }
        guard(() => raw.exec('COMMIT'));
        return result;
      } catch (error) {
        if (!closed) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            // The original error is the one the caller needs; a failed ROLLBACK means the transaction is already gone.
          }
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    savepoint<T>(name: string, fn: () => T): T {
      const safe = checkSavepointName(name);
      guard(() => raw.exec(`SAVEPOINT ${safe}`));
      savepointDepth += 1;
      try {
        const result = fn();
        if (isThenable(result)) {
          throw new TypeError('savepoint() callback must be synchronous; it returned a promise');
        }
        guard(() => raw.exec(`RELEASE ${safe}`));
        return result;
      } catch (error) {
        if (!closed) {
          try {
            raw.exec(`ROLLBACK TO ${safe}`);
            raw.exec(`RELEASE ${safe}`);
          } catch {
            // As above: surface the original error.
          }
        }
        throw error;
      } finally {
        savepointDepth -= 1;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      raw.close();
    },
  };
  return db;
}
