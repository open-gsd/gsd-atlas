import fs from 'node:fs';
import path from 'node:path';
import { loadDriver, openDatabase, selfTest } from '../sqlite/index.ts';
import type { Db, DriverModule, DriverName } from '../sqlite/index.ts';
import { SchemaTooNew } from './errors.ts';
import { createLease, startTakeover } from './lease.ts';
import type { Lease } from './lease.ts';
import type { LifecycleSettings, StoreParts } from './parts.ts';
import {
  KEEP_QUARANTINED,
  clearDirty,
  createDirtyGuard,
  isCorruptionError,
  isDirty,
  pruneQuarantine,
  quarantine,
  runQuickCheck,
} from './recovery.ts';
import { FUZZY_PATH_META, SCHEMA_VERSION, STORE_FILE_NAME, createSchema } from './schema.ts';
import type { FuzzyIndex } from './schema.ts';
import { REBUILD_PENDING_META, REBUILT_AT_META, REBUILT_MOVED_TO_META, createStore, processDegraded } from './store.ts';
import type { StoreLifecycle } from './store.ts';
import type { FactStore, StoreDeps, StoreOptions } from './types.ts';

/** The approved `sqlite.busyTimeoutMs` of 02-CONSTANTS.md: how long a writer waits on a locked database. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** The approved `lease.retryMinMs` of 02-CONSTANTS.md: the shortest wait before a follower tries to take the lease. */
export const DEFAULT_LEASE_RETRY_MIN_MS = 10000;

/** The approved `lease.retryMaxMs` of 02-CONSTANTS.md: the longest wait before a follower tries to take the lease. */
export const DEFAULT_LEASE_RETRY_MAX_MS = 30000;

/** The approved `store.dirtyIdleMs` of 02-CONSTANTS.md: quiet time after the last write before the dirty sentinel goes. */
export const DEFAULT_DIRTY_IDLE_MS = 1000;

/** The approved `gc.graceMs` of 02-CONSTANTS.md (D-16): how long a retired version is kept when git lacks its blob, 24 hours. */
export const DEFAULT_GC_GRACE_MS = 86_400_000;

/** How many retired files one `collect` transaction deletes (plan 02-18: 50 files per transaction). */
export const DEFAULT_COLLECT_CHUNK_SIZE = 50;

/** The approved `maintenance.sliceMs` of 02-CONSTANTS.md: the longest single maintenance pause, 200 ms. */
export const DEFAULT_SLICE_MS = 200;

/** Options of `openFactStore`: the engine-independent `StoreOptions` plus the SQL driver choice. */
export interface OpenFactStoreOptions extends StoreOptions {
  /** Which SQLite driver to open. Default `node:sqlite`. */
  readonly driver?: DriverName;
  /**
   * TEST ONLY. Set `false` to create the fuzzy-name table without FTS5 `contentless_delete`, so tests can run the
   * path an engine without it takes. It can not switch the capability on where the probe found it missing.
   */
  readonly contentlessDelete?: boolean;
}

/** Options of `openFactStore` that belong to the store's lifecycle (plan 02-12): the writer lease and recovery. */
export interface StoreOpenOptions extends OpenFactStoreOptions {
  /**
   * `none` (default): no cross-process lease; only the in-process single-writer rule applies. `acquire`: take
   * the cross-process writer lease (`lease.db`) at open. A process that cannot take it is a follower: it reads,
   * never writes, and retries on a jittered timer so it takes over when the leader goes away.
   */
  readonly lease?: 'none' | 'acquire';
  /** How a follower retries the lease. Default: the approved `lease.retryMinMs` to `lease.retryMaxMs`. `random` is the jitter source. */
  readonly takeover?: { readonly retryMinMs: number; readonly retryMaxMs: number; readonly random?: () => number };
  /** Quiet time after the last write before the dirty sentinel is removed. Default: the approved `store.dirtyIdleMs`. */
  readonly dirtyIdleMs?: number;
  /** Called when this process gains (`true`) or gives up (`false`) the writer lease after the store was opened. */
  readonly onLeaseChange?: (held: boolean) => void;
  /** TEST ONLY. The schema version written into a new store, so tests can make one that is newer or older than this build. */
  readonly schemaVersion?: number;
}

function hasTables(db: Db): boolean {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  return Number(row?.n) > 0;
}

function readMeta(db: Db, name: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
  return row === undefined ? undefined : String(row.value);
}

/** How a store file that has tables relates to this build's schema (D-15). */
type SchemaVerdict = 'current' | 'newer' | 'older' | 'foreign';

function schemaVerdict(db: Db): SchemaVerdict {
  const metaTable = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (Number(metaTable?.n) === 0) return 'foreign';
  const raw = readMeta(db, 'schema_version');
  const version = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isNaN(version)) return 'foreign';
  if (version > SCHEMA_VERSION) return 'newer';
  return version < SCHEMA_VERSION ? 'older' : 'current';
}

/** What `attemptOpen` needs, fixed for the life of one `openFactStore` call. */
interface OpenEnv {
  readonly dir: string;
  readonly file: string;
  readonly driver: DriverModule;
  readonly timeoutMs: number;
  readonly fuzzy: FuzzyIndex;
  readonly version: string;
  readonly schemaVersion: number;
}

interface Connections {
  writeDb: Db;
  readDb: Db;
}

type Attempt =
  | { readonly kind: 'ready'; readonly conns: Connections; readonly fuzzyTrigram: boolean }
  /** The file is damaged or not ours: the caller moves it aside. Nothing is left open. */
  | { readonly kind: 'corrupt' }
  /** The file is a fact store of an older schema: the caller deletes it. Nothing is left open. */
  | { readonly kind: 'older' };

function fileHasContent(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * One try at opening the store files in `env.dir`.
 *
 * `authority` is true for a process that may change the files: the leader, or any process without a lease. Only
 * such a process runs the sentinel check, treats a damaged or foreign file as one to move aside, and creates or
 * changes the schema. A follower reads: it leaves an existing schema untouched and reports trouble as an error.
 */
async function attemptOpen(env: OpenEnv, authority: boolean): Promise<Attempt> {
  const existed = fileHasContent(env.file);
  const { driver, timeoutMs } = env;

  let writeDb: Db;
  try {
    writeDb = await openDatabase(env.file, { driver, timeoutMs });
  } catch (error) {
    // "file is not a database" surfaces on the first statement of the open policy.
    if (authority && existed && isCorruptionError(error)) return { kind: 'corrupt' };
    throw error;
  }

  let readDb: Db | undefined;
  const giveUp = (kind: 'corrupt' | 'older'): Attempt => {
    readDb?.close();
    writeDb.close();
    return { kind };
  };
  try {
    // D-14: a sentinel means the last writer may have died mid-batch, so check before trusting the file.
    if (authority && isDirty(env.dir) && !runQuickCheck(writeDb)) return giveUp('corrupt');

    const existing = hasTables(writeDb);
    if (existing) {
      const verdict = schemaVerdict(writeDb);
      if (verdict === 'newer') throw new SchemaTooNew(readMeta(writeDb, 'created_by') ?? 'unknown');
      if (verdict === 'foreign') {
        if (authority) return giveUp('corrupt');
        throw new Error('the store file is not a gsd-atlas fact store; the process that holds the writer lease will move it aside');
      }
      if (verdict === 'older') {
        if (authority) return giveUp('older');
        throw new Error('the store was written by an older schema; the process that holds the writer lease will rebuild it');
      }
    }

    let fuzzyTrigram = env.fuzzy.trigram;
    if (authority || !existing) {
      if (!existing) {
        writeDb.pragma('auto_vacuum', 'INCREMENTAL');
        writeDb.exec('VACUUM');
      }
      const db = writeDb;
      db.transaction(() => {
        createSchema(db, env.fuzzy);
        const seed = db.prepare('INSERT OR IGNORE INTO meta (name, value) VALUES (?, ?)');
        seed.run('schema_version', String(env.schemaVersion));
        seed.run('created_by', env.version);
      });
    } else {
      // A follower leaves an existing store untouched; it reads the fuzzy-name path the leader recorded.
      fuzzyTrigram = env.fuzzy.trigram && readMeta(writeDb, FUZZY_PATH_META) === 'trigram';
    }
    readDb = await openDatabase(env.file, { driver, readOnly: true, timeoutMs });
    if (authority) clearDirty(env.dir); // the check passed (or there was nothing to check)
    return { kind: 'ready', conns: { writeDb, readDb }, fuzzyTrigram };
  } catch (error) {
    readDb?.close();
    writeDb.close();
    if (authority && existed && isCorruptionError(error)) return { kind: 'corrupt' };
    throw error;
  }
}

/** The upkeep settings of a store: the options, each checked, over the approved defaults. */
function lifecycleSettings(options: StoreOptions, contentlessDelete: boolean): LifecycleSettings {
  const graceMs = options.graceMs ?? DEFAULT_GC_GRACE_MS;
  const chunkSize = options.chunkSize ?? DEFAULT_COLLECT_CHUNK_SIZE;
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError('graceMs must be a finite number of milliseconds, zero or more');
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('chunkSize must be a whole number, one or more');
  if (!Number.isFinite(sliceMs) || sliceMs <= 0) throw new RangeError('sliceMs must be a finite number of milliseconds, above zero');
  return { graceMs, chunkSize, sliceMs, contentlessDelete };
}

/** Delete the store database and its WAL companions (an older-schema store is derived data, D-15). */
function removeStoreFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
}

/** Write the rebuild notes into a fresh store's `meta` (see `REBUILD_PENDING_META`). */
function noteRebuild(db: Db, moved: { readonly movedTo: string; readonly at: number } | undefined): void {
  db.transaction(() => {
    const put = db.prepare('INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)');
    put.run(REBUILD_PENDING_META, '1');
    if (moved !== undefined) {
      put.run(REBUILT_MOVED_TO_META, moved.movedTo);
      put.run(REBUILT_AT_META, String(moved.at));
    }
  });
}

/**
 * Open the files for a process with write authority; when they are damaged or of an older schema, put them
 * right first: a damaged store is moved aside (the newest two moved-aside files are kept) and an older one is
 * deleted, then a fresh store is created and marked as rebuilding.
 */
async function openWithRecovery(env: OpenEnv, deps: StoreDeps): Promise<{ conns: Connections; fuzzyTrigram: boolean }> {
  let attempt = await attemptOpen(env, true);
  if (attempt.kind === 'ready') return attempt;

  let moved: { readonly movedTo: string; readonly at: number } | undefined;
  if (attempt.kind === 'corrupt') {
    const { movedTo } = quarantine(env.dir, deps.clock);
    pruneQuarantine(env.dir, KEEP_QUARANTINED);
    moved = { movedTo, at: deps.clock.now() };
  } else {
    removeStoreFiles(env.file);
    clearDirty(env.dir);
  }
  attempt = await attemptOpen(env, true);
  if (attempt.kind !== 'ready') throw new Error('the fact store could not be recreated after it was moved aside');
  noteRebuild(attempt.conns.writeDb, moved);
  return attempt;
}

/**
 * Open (creating when missing) the Fact Store in directory `dir`. It owns one writable connection and one
 * read-only connection on `<dir>/facts.db`, both through the SQLite kit only, so the store never sees a
 * driver type.
 *
 * A new store has `auto_vacuum` set to INCREMENTAL before its first table exists; the setting only takes
 * effect after a one-time VACUUM once the file is in WAL mode. Opening an existing store changes nothing.
 *
 * Recovery (STO-06, D-14, D-15), for the process that may write: a `dirty` sentinel beside the file triggers
 * `PRAGMA quick_check`; a file that fails it, is not a database, or is not a fact store is moved aside to
 * `facts.db.corrupt-<time>` and a fresh store is created. A store written by a newer build throws
 * `SchemaTooNew` carrying the build that created it; one written by an older schema is deleted and recreated
 * (it is derived data). A rebuilt store answers `rebuilding` until a full overlay has been written again.
 *
 * With `lease: 'acquire'` the store first tries to take the cross-process writer lease. The process that gets
 * it is the leader and does everything above. A process that does not is a follower: it never writes the
 * database (an existing schema is not touched, the sentinel is not checked), `writer()` throws `WriterBusy`,
 * every answer says `follower`, and it retries the lease on a jittered timer. When it takes over it checks a
 * sentinel the dead leader left behind.
 *
 * Assignable to `OpenStore`: the third parameter is optional.
 */
export async function openFactStore(
  dir: string,
  deps: StoreDeps,
  options: StoreOpenOptions = {},
): Promise<FactStore> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // The open-time capability probe (research A11): the fuzzy-name path is chosen from what the engine can do.
  // `trigram: false` can switch the table off for a test, never on where the probe found it missing.
  const driver = await loadDriver(options.driver ?? 'node:sqlite');
  const capabilities = selfTest(driver);
  const contentlessDelete = capabilities.contentlessDelete && options.contentlessDelete !== false;
  const baseSettings = lifecycleSettings(options, contentlessDelete); // checked before anything is opened
  const env: OpenEnv = {
    dir,
    file: path.join(dir, STORE_FILE_NAME),
    driver,
    timeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    fuzzy: {
      trigram: capabilities.fts5Trigram && options.trigram !== false,
      contentlessDelete,
    },
    version: options.version ?? 'unknown',
    schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
  };

  const lease: Lease | undefined =
    options.lease === 'acquire'
      ? createLease({
          dir,
          clock: deps.clock,
          version: env.version,
          openDb: (file) => openDatabase(file, { driver, timeoutMs: 0 }),
        })
      : undefined;
  const leader = lease === undefined ? true : await lease.tryAcquire();

  let opened: { conns: Connections; fuzzyTrigram: boolean };
  try {
    if (leader) {
      opened = await openWithRecovery(env, deps);
    } else {
      const attempt = await attemptOpen(env, false);
      if (attempt.kind !== 'ready') throw new Error('a follower cannot open the store');
      opened = attempt;
    }
  } catch (error) {
    await lease?.release();
    throw error;
  }
  const { conns } = opened;
  // What the table on disk can do decides how names leave it; a store made by another engine may differ from the probe.
  const ftsRow = opened.fuzzyTrigram
    ? conns.readDb.prepare("SELECT sql FROM sqlite_master WHERE name = 'names_fts'").get()
    : undefined;
  const settings: LifecycleSettings = {
    ...baseSettings,
    contentlessDelete: ftsRow !== undefined && /contentless_delete\s*=\s*1/.test(String(ftsRow.sql)),
  };

  const lifecycle: StoreLifecycle = {
    ...(lease === undefined ? {} : { lease }),
    ...(options.onLeaseChange === undefined ? {} : { leaseChanged: options.onLeaseChange }),
    dirty: createDirtyGuard({ dir, clock: deps.clock, idleMs: options.dirtyIdleMs ?? DEFAULT_DIRTY_IDLE_MS }),
  };
  // The connections live in `conns` so that a takeover that finds a damaged store can replace them in place.
  const parts: StoreParts = {
    get writeDb() {
      return conns.writeDb;
    },
    get readDb() {
      return conns.readDb;
    },
    deps,
    repo: options.repo ?? path.basename(path.resolve(dir)),
    canCache:
      lease === undefined
        ? (options.canCache ?? (() => true))
        : () => lease.held && (options.canCache?.() ?? true),
    resolutionContext: options.resolutionContext ?? (() => ({ id: 'grammar', configHashes: [] })),
    fuzzyTrigram: opened.fuzzyTrigram,
    settings,
    snapshotIds: new Map(),
    state: { closed: false, writerTaken: false },
    degradedNow: processDegraded(lifecycle, () => conns.readDb),
  };

  /**
   * This follower just became the leader. If the leader before it died mid-batch it left the sentinel: check the
   * store now, and when the check fails move it aside and rebuild it in place.
   */
  const recoverAfterTakeover = async (): Promise<void> => {
    if (!isDirty(dir)) return;
    if (runQuickCheck(conns.writeDb)) {
      clearDirty(dir);
      return;
    }
    lifecycle.recovering = true;
    try {
      conns.readDb.close();
      conns.writeDb.close();
      const replaced = await openWithRecovery(env, deps);
      conns.writeDb = replaced.conns.writeDb;
      conns.readDb = replaced.conns.readDb;
      parts.snapshotIds.clear(); // a rebuilt store counts its sequence numbers from zero again
    } finally {
      lifecycle.recovering = false;
    }
  };

  if (lease !== undefined && !lease.held) {
    const range = options.takeover ?? {
      retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS,
      retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS,
    };
    lifecycle.stopTakeover = startTakeover(lease, deps.clock, range, () => {
      void (async () => {
        if (parts.state.closed) return;
        try {
          await recoverAfterTakeover();
        } catch {
          // The store could not be put right. It keeps serving what it can, and the next open will say what is wrong.
        }
        if (!parts.state.closed) options.onLeaseChange?.(true);
      })();
    });
  }
  return createStore(parts, lifecycle);
}
