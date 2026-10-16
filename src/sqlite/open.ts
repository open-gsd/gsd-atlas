import type { Db, DriverModule, DriverName, OpenOptions } from './driver.ts';
import { DriverUnsupportedError } from './errors.ts';

/** The oldest Node whose node:sqlite is supported: 24.15.0 truncates TEXT at an embedded NUL (Pitfall 2). */
export const NODE_FLOOR = '24.16.0';

/** What a driver can do beyond the contract; recorded by the self-test. */
export interface Capabilities {
  readonly fts5Trigram: boolean;
  readonly json: boolean;
  /** FTS5 `contentless_delete=1` (SQLite 3.43 and newer): the store picks its fuzzy-name path from this (research A11). */
  readonly contentlessDelete: boolean;
}

export type Loaders = Readonly<Record<DriverName, () => Promise<DriverModule>>>;

const defaultLoaders: Loaders = {
  'node:sqlite': async () => (await import('./node-sqlite.ts')).nodeSqliteDriver,
  'better-sqlite3': async () => (await import('./better-sqlite3.ts')).loadBetterSqlite3(),
};

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10));
  const pb = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `nodeVersion` (for example `24.16.0`, no leading v) is at or above the supported floor. */
export function isSupportedNode(nodeVersion: string = process.versions.node): boolean {
  return compareVersions(nodeVersion, NODE_FLOOR) >= 0;
}

/**
 * Load a driver by name. A failure maps to `DriverUnsupportedError`: `unsupported_node` for node:sqlite
 * (Node below the floor, or no node:sqlite at all) and `not_installed` for the optional better-sqlite3.
 * `loaders` is injectable for tests.
 */
export async function loadDriver(name: DriverName, loaders: Loaders = defaultLoaders): Promise<DriverModule> {
  if (name === 'node:sqlite' && !isSupportedNode()) {
    throw new DriverUnsupportedError(
      'unsupported_node',
      `node:sqlite needs Node ${NODE_FLOOR} or newer (this is ${process.versions.node}); older releases truncate TEXT at an embedded NUL`,
    );
  }
  try {
    return await loaders[name]();
  } catch (error) {
    if (error instanceof DriverUnsupportedError) throw error;
    if (name === 'better-sqlite3') {
      throw new DriverUnsupportedError(
        'not_installed',
        'better-sqlite3 is not installed; it is an optional peer dependency (npm install better-sqlite3)',
        { cause: error },
      );
    }
    throw new DriverUnsupportedError('unsupported_node', `node:sqlite could not be loaded on Node ${process.versions.node}`, {
      cause: error,
    });
  }
}

const NUL_TEXT = 'ab\u0000cd';
const selfTested = new WeakMap<DriverModule, Capabilities>();

function probe(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/**
 * Prove a driver stores and reads TEXT with an embedded NUL intact. node:sqlite on Node 24.15.0 cuts the
 * string at the NUL, silently corrupting source-derived text, so a driver that fails is refused with
 * `nul_truncation`. Also records capabilities. Runs once per driver module per process.
 */
export function selfTest(driver: DriverModule): Capabilities {
  const cached = selfTested.get(driver);
  if (cached !== undefined) return cached;

  let db: Db | undefined;
  try {
    db = driver.open(':memory:', { readOnly: false, timeoutMs: 0, bigints: 'number' });
    db.exec('CREATE TABLE self_test (s TEXT NOT NULL)');
    db.prepare('INSERT INTO self_test (s) VALUES (?)').run(NUL_TEXT);
    const row = db.prepare('SELECT s FROM self_test').get();
    const back = row?.s;
    if (typeof back !== 'string' || back !== NUL_TEXT) {
      throw new DriverUnsupportedError(
        'nul_truncation',
        `${driver.name} cut TEXT at an embedded NUL byte (stored ${NUL_TEXT.length} characters, read back ${typeof back === 'string' ? back.length : 'none'}); use Node >= ${NODE_FLOOR} or the better-sqlite3 driver`,
      );
    }
    const open = db;
    const capabilities: Capabilities = {
      json: probe(() => open.prepare(`SELECT json('{"a":1}') AS j`).get()),
      fts5Trigram: probe(() => open.exec(`CREATE VIRTUAL TABLE self_test_fts USING fts5(name, tokenize='trigram')`)),
      contentlessDelete: probe(() =>
        open.exec(
          `CREATE VIRTUAL TABLE self_test_fts_cd USING fts5(name, content='', contentless_delete=1, detail=full, tokenize='trigram')`,
        ),
      ),
    };
    selfTested.set(driver, capabilities);
    return capabilities;
  } catch (error) {
    if (error instanceof DriverUnsupportedError) throw error;
    throw new DriverUnsupportedError('self_test_failed', `${driver.name} failed its open-time self-test`, {
      cause: error,
    });
  } finally {
    db?.close();
  }
}

/**
 * Open a SQLite database. Selects the driver (default node:sqlite), runs the NUL self-test once per driver,
 * then applies the open policy: a writable database gets `journal_mode=WAL`, `synchronous=NORMAL` and
 * `foreign_keys=ON` (the busy timeout comes from `timeoutMs`); a read-only connection changes no journal mode.
 */
export async function openDatabase(path: string, options: OpenOptions = {}): Promise<Db> {
  const driver =
    typeof options.driver === 'object' ? options.driver : await loadDriver(options.driver ?? 'node:sqlite');
  selfTest(driver);

  const readOnly = options.readOnly ?? false;
  const db = driver.open(path, {
    readOnly,
    // No default busy wait: callers pass timeoutMs explicitly. The planned 5000 ms default is held back pending
    // human confirmation (a guard hook refused to let an agent set it); see 01-10-SUMMARY.md.
    timeoutMs: options.timeoutMs ?? 0,
    bigints: options.bigints ?? 'number',
  });
  try {
    if (!readOnly) {
      db.pragma('journal_mode', 'WAL'); // an in-memory database answers `memory`; that is fine
      db.pragma('synchronous', 'NORMAL');
      db.pragma('foreign_keys', 'ON');
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
