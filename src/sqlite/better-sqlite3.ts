import type { DriverModule } from './driver.ts';
import { createDb } from './wrap.ts';
import type { RawConnection, RawStatement } from './wrap.ts';

/**
 * The better-sqlite3 adapter, and the only file in src that imports the package. The package is an optional
 * peer dependency, so it is loaded lazily; the caller maps a load failure to `DriverUnsupportedError('not_installed')`.
 *
 * The package has no `allowExtension` option: its `load_extension()` SQL function is not authorised, and this
 * adapter never calls the JavaScript `loadExtension` method.
 */

/** Primary result codes by SQLite name. better-sqlite3 reports `SQLITE_CONSTRAINT_PRIMARYKEY` and the like. */
const PRIMARY_CODES: Readonly<Record<string, number>> = {
  ERROR: 1,
  PERM: 3,
  ABORT: 4,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  INTERRUPT: 9,
  IOERR: 10,
  CORRUPT: 11,
  FULL: 13,
  CANTOPEN: 14,
  SCHEMA: 17,
  TOOBIG: 18,
  CONSTRAINT: 19,
  MISMATCH: 20,
  MISUSE: 21,
  AUTH: 23,
  RANGE: 25,
  NOTADB: 26,
};

function primaryCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_')) return undefined;
  const name = code.slice('SQLITE_'.length).split('_')[0] ?? '';
  return PRIMARY_CODES[name] ?? 1;
}

export async function loadBetterSqlite3(): Promise<DriverModule> {
  const { default: Database } = await import('better-sqlite3');
  return {
    name: 'better-sqlite3',
    open(path, options) {
      const database = new Database(path, {
        readonly: options.readOnly,
        fileMustExist: options.readOnly,
        timeout: options.timeoutMs,
      });
      const raw: RawConnection = {
        exec: (sql) => {
          database.exec(sql);
        },
        prepare(sql): RawStatement {
          const stmt = database.prepare(sql);
          // Read every INTEGER as a bigint so createDb can apply the `bigints` option the same way on every driver.
          stmt.safeIntegers(true);
          return {
            // better-sqlite3 refuses run() on a statement that returns data and get()/all() on one that does not;
            // node:sqlite accepts both, and the kit behaves like node:sqlite.
            run: (params) => {
              if (stmt.reader) {
                stmt.all(...params);
                return { changes: 0, lastInsertRowid: 0 };
              }
              return stmt.run(...params);
            },
            get: (params) => (stmt.reader ? stmt.get(...params) : (stmt.run(...params), undefined)),
            all: (params) => (stmt.reader ? stmt.all(...params) : (stmt.run(...params), [])),
          };
        },
        close: () => {
          database.close();
        },
        primaryCode,
      };
      try {
        return createDb(raw, { driver: 'better-sqlite3', path, bigints: options.bigints });
      } catch (error) {
        database.close(); // never leak a handle: an open connection keeps the file locked on Windows
        throw error;
      }
    },
  };
}
