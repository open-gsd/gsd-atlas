import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../sqlite/index.ts';
import type { Db, DriverName } from '../sqlite/index.ts';
import { SchemaTooNew } from './errors.ts';
import type { StoreParts } from './parts.ts';
import { SCHEMA_VERSION, STORE_FILE_NAME, createSchema } from './schema.ts';
import { createStore } from './store.ts';
import type { FactStore, StoreDeps, StoreOptions } from './types.ts';

/** The approved `sqlite.busyTimeoutMs` of 02-CONSTANTS.md: how long a writer waits on a locked database. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Options of `openFactStore`: the engine-independent `StoreOptions` plus the SQL driver choice. */
export interface OpenFactStoreOptions extends StoreOptions {
  /** Which SQLite driver to open. Default `node:sqlite`. */
  readonly driver?: DriverName;
}

function hasTables(db: Db): boolean {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  return Number(row?.n) > 0;
}

function readMeta(db: Db, name: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
  return row === undefined ? undefined : String(row.value);
}

/** Refuse a store that is not this build's schema: newer is `SchemaTooNew`; anything else needs a rebuild (plan 02-12). */
function checkSchemaVersion(db: Db): void {
  const metaTable = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const version = Number(metaTable?.n) > 0 ? Number(readMeta(db, 'schema_version')) : Number.NaN;
  if (Number.isNaN(version)) {
    throw new Error('the store file is not a gsd-atlas fact store (no schema version); remove it to rebuild');
  }
  if (version > SCHEMA_VERSION) throw new SchemaTooNew(readMeta(db, 'created_by') ?? 'unknown');
  if (version < SCHEMA_VERSION) {
    throw new Error(`the store has schema version ${version}, this build writes ${SCHEMA_VERSION}; it must be rebuilt`);
  }
}

/**
 * Open (creating when missing) the Fact Store in directory `dir`. It owns one writable connection and one
 * read-only connection on `<dir>/facts.db`, both through the SQLite kit only, so the store never sees a
 * driver type.
 *
 * A new store has `auto_vacuum` set to INCREMENTAL before its first table exists; the setting only takes
 * effect after a one-time VACUUM once the file is in WAL mode. Opening an existing store changes nothing. A
 * store written by a newer build throws `SchemaTooNew` carrying the build that created it.
 *
 * Assignable to `OpenStore`: the third parameter is optional.
 */
export async function openFactStore(
  dir: string,
  deps: StoreDeps,
  options: OpenFactStoreOptions = {},
): Promise<FactStore> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STORE_FILE_NAME);
  const timeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  const writeDb = await openDatabase(file, { driver: options.driver, timeoutMs });
  let readDb: Db | undefined;
  try {
    if (hasTables(writeDb)) {
      checkSchemaVersion(writeDb);
    } else {
      writeDb.pragma('auto_vacuum', 'INCREMENTAL');
      writeDb.exec('VACUUM');
    }
    writeDb.transaction(() => {
      createSchema(writeDb);
      const seed = writeDb.prepare('INSERT OR IGNORE INTO meta (name, value) VALUES (?, ?)');
      seed.run('schema_version', String(SCHEMA_VERSION));
      seed.run('created_by', options.version ?? 'unknown');
    });
    readDb = await openDatabase(file, { driver: options.driver, readOnly: true, timeoutMs });
  } catch (error) {
    readDb?.close();
    writeDb.close();
    throw error;
  }

  const parts: StoreParts = {
    writeDb,
    readDb,
    deps,
    repo: options.repo ?? path.basename(path.resolve(dir)),
    canCache: options.canCache ?? (() => true),
    resolutionContext: options.resolutionContext ?? (() => ({ id: 'grammar', configHashes: [] })),
    state: { closed: false, writerTaken: false },
    degradedNow: () => [],
  };
  return createStore(parts);
}
