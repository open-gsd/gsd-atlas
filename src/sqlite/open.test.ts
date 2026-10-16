import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeTempDir } from '../test-kit/index.ts';
import type { DriverModule } from './driver.ts';
import { DriverUnsupportedError } from './errors.ts';
import { isSupportedNode, loadDriver, openDatabase, selfTest } from './open.ts';
import type { Loaders } from './open.ts';

/** The real node:sqlite driver, with TEXT cut at the first NUL on the way out (what Node 24.15.0 does). */
async function truncatingDriver(): Promise<DriverModule> {
  const real = await loadDriver('node:sqlite');
  return {
    name: real.name,
    open(path, options) {
      const db = real.open(path, options);
      return {
        ...db,
        prepare(sql) {
          const stmt = db.prepare(sql);
          const cut = (row: Record<string, unknown>) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? (v.split('\u0000')[0] ?? '') : v]),
            );
          return {
            run: stmt.run,
            get: (...params) => {
              const row = stmt.get(...params);
              return row === undefined ? undefined : (cut(row) as typeof row);
            },
            all: (...params) => stmt.all(...params).map((row) => cut(row) as typeof row),
          };
        },
      };
    },
  };
}

describe('openDatabase', () => {
  it('defaults to the node:sqlite driver', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const db = tmp.adopt(await openDatabase(`${tmp.path}/a.db`));
    assert.equal(db.driver, 'node:sqlite');
  });

  it('selects the better-sqlite3 adapter when asked', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const db = tmp.adopt(await openDatabase(`${tmp.path}/b.db`, { driver: 'better-sqlite3' }));
    assert.equal(db.driver, 'better-sqlite3');
    assert.equal(db.pragma('journal_mode'), 'wal');
  });

  it('refuses a driver that truncates TEXT at an embedded NUL (nul_truncation) and never returns a Db', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const driver = await truncatingDriver();
    await assert.rejects(
      openDatabase(`${tmp.path}/a.db`, { driver }),
      (error: unknown) => error instanceof DriverUnsupportedError && error.code === 'nul_truncation',
    );
    assert.throws(
      () => selfTest(driver),
      (error: unknown) => error instanceof DriverUnsupportedError && error.code === 'nul_truncation',
    );
  });

  it('reports self_test_failed when a driver cannot even open an in-memory database', () => {
    const broken: DriverModule = {
      name: 'node:sqlite',
      open() {
        throw new Error('boom');
      },
    };
    assert.throws(
      () => selfTest(broken),
      (error: unknown) => error instanceof DriverUnsupportedError && error.code === 'self_test_failed',
    );
  });

  it('applies WAL only to writable databases: a read-only connection changes no journal mode', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const file = `${tmp.path}/a.db`;
    const writer = tmp.adopt(await openDatabase(file));
    writer.exec('CREATE TABLE t (id INTEGER)');
    const reader = tmp.adopt(await openDatabase(file, { readOnly: true }));
    assert.equal(reader.pragma('journal_mode'), 'wal');
  });
});

describe('loadDriver', () => {
  it('maps a failing better-sqlite3 loader to not_installed', async () => {
    const loaders: Loaders = {
      'node:sqlite': () => Promise.reject(new Error('unused')),
      'better-sqlite3': () => Promise.reject(new Error("Cannot find package 'better-sqlite3'")),
    };
    await assert.rejects(
      loadDriver('better-sqlite3', loaders),
      (error: unknown) => error instanceof DriverUnsupportedError && error.code === 'not_installed',
    );
  });

  it('maps a failing node:sqlite loader to unsupported_node', async () => {
    const loaders: Loaders = {
      'node:sqlite': () => Promise.reject(new Error('No such built-in module: node:sqlite')),
      'better-sqlite3': () => Promise.reject(new Error('unused')),
    };
    await assert.rejects(
      loadDriver('node:sqlite', loaders),
      (error: unknown) => error instanceof DriverUnsupportedError && error.code === 'unsupported_node',
    );
  });

  it('rejects a Node below the 24.16.0 floor', () => {
    assert.equal(isSupportedNode('24.15.0'), false);
    assert.equal(isSupportedNode('22.99.0'), false);
    assert.equal(isSupportedNode('24.16.0'), true);
    assert.equal(isSupportedNode('24.22.0'), true);
    assert.equal(isSupportedNode('26.11.1'), true);
  });
});
