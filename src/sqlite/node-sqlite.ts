import { DatabaseSync } from 'node:sqlite';
import type { DriverModule } from './driver.ts';
import { createDb } from './wrap.ts';
import type { RawConnection, RawStatement } from './wrap.ts';

/**
 * The node:sqlite adapter, and the only file in src that imports `node:sqlite`.
 *
 * Only options available at the Node 24.16.0 floor are used. `allowExtension` stays false: extension
 * loading is off in 1.0.
 */

function primaryCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { code?: unknown; errcode?: unknown };
  if (e.code !== 'ERR_SQLITE_ERROR' || typeof e.errcode !== 'number') return undefined;
  // errcode is the extended result code; the low byte is the primary code.
  return e.errcode & 0xff;
}

export const nodeSqliteDriver: DriverModule = {
  name: 'node:sqlite',
  open(path, options) {
    const database = new DatabaseSync(path, {
      readOnly: options.readOnly,
      timeout: options.timeoutMs,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    const raw: RawConnection = {
      exec: (sql) => database.exec(sql),
      prepare(sql): RawStatement {
        const stmt = database.prepare(sql);
        // Read every INTEGER as a bigint so createDb can apply the `bigints` option the same way on every driver.
        stmt.setReadBigInts(true);
        return {
          run: (params) => stmt.run(...(params as never[])) as { changes: number | bigint; lastInsertRowid: number | bigint },
          get: (params) => stmt.get(...(params as never[])),
          all: (params) => stmt.all(...(params as never[])),
        };
      },
      close: () => database.close(),
      primaryCode,
    };
    try {
      return createDb(raw, { driver: 'node:sqlite', path, bigints: options.bigints });
    } catch (error) {
      database.close(); // never leak a handle: an open connection keeps the file locked on Windows
      throw error;
    }
  },
};
