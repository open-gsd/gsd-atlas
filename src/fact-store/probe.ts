/**
 * The store probe (WR-02, plan 02-41): what a read request needs to know about an existing store before it is
 * allowed to open one. Opening a store as the leader takes the repository's writer lease, so a store that holds
 * nothing to read must not be opened by a question, or the advertised `gsd-atlas build` would answer `lease_held`.
 *
 * The probe opens `facts.db` read-only for an instant, with no busy wait, reads one `meta` value and one count, and
 * closes. It never creates the file, never repairs or moves it, never takes a lease and never writes. It is the
 * one place outside the open path that reads a store file.
 *
 * A definite answer is required to withhold a tenant: only a store that is known to hold nothing (`empty`,
 * `older_schema`, `unreadable`) is kept from the open path. Anything the probe cannot settle (a busy database, an
 * error nobody expected) counts as `indexed`, so the tenant opens it exactly as it did before this probe existed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DbError, openDatabase } from '../sqlite/index.ts';
import type { Db, OpenOptions } from '../sqlite/index.ts';
import type { StoreLocation } from './location.ts';
import { isCorruptionError } from './recovery.ts';
import { SCHEMA_VERSION, STORE_FILE_NAME } from './schema.ts';

/**
 * What the store in a directory holds:
 * - `indexed`: the current schema and at least one live overlay (also: the probe could not tell);
 * - `newer_schema`: written by a newer gsd-atlas, so the tenant answers with the `schema_too_new` message;
 * - `empty`: the current schema and no live overlay (created and never built, or rebuilt after corruption);
 * - `older_schema`: the open path would delete and recreate it, so there is nothing to read;
 * - `unreadable`: not a database of ours (damaged, empty file, no `meta` table, or gone).
 */
export type StoreProbe = 'indexed' | 'newer_schema' | 'empty' | 'older_schema' | 'unreadable';

export interface ProbeOptions {
  /** TEST ONLY. Extra options for the read-only open (an injected SQLite driver); `readOnly` and the busy wait cannot be changed. */
  readonly kit?: OpenOptions;
}

/** SQLITE_CANTOPEN: the file is not there (or not readable), so there is nothing a tenant could read either. */
const SQLITE_CANTOPEN = 14;

/** What an open or a query that threw says about the store. */
function classify(error: unknown): StoreProbe {
  if (isCorruptionError(error)) return 'unreadable';
  if (error instanceof DbError && error.sqliteCode === SQLITE_CANTOPEN) return 'unreadable';
  return 'indexed'; // busy, or anything else the probe cannot settle
}

function count(db: Db, sql: string): number {
  return Number(db.prepare(sql).get()?.n);
}

/** Classify the store in `location.dir`. Never throws. */
export async function probeStore(location: Pick<StoreLocation, 'dir'>, options: ProbeOptions = {}): Promise<StoreProbe> {
  const file = path.join(location.dir, STORE_FILE_NAME);
  // The driver reports a missing file as a plain error with no result code, so say so here: a file that went away
  // since `findExistingStore` looked has nothing to read.
  if (!fs.existsSync(file)) return 'unreadable';
  let db: Db;
  try {
    db = await openDatabase(file, { ...options.kit, readOnly: true, timeoutMs: 0 });
  } catch (error) {
    return classify(error);
  }
  try {
    if (count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'") === 0) return 'unreadable';
    const raw = db.prepare("SELECT value FROM meta WHERE name = 'schema_version'").get()?.value;
    const version = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isNaN(version)) return 'unreadable';
    if (version > SCHEMA_VERSION) return 'newer_schema';
    if (version < SCHEMA_VERSION) return 'older_schema';
    return count(db, 'SELECT count(*) AS n FROM overlays WHERE dropped = 0') > 0 ? 'indexed' : 'empty';
  } catch (error) {
    return classify(error);
  } finally {
    try {
      db.close();
    } catch {
      // closing a read-only connection that is already unusable holds nothing
    }
  }
}
