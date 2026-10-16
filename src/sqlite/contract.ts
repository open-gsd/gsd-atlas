/**
 * The driver conformance suite: one list of cases, registered once per driver, so both drivers run exactly the
 * same cases. This is test code: only this module's own `*.test.ts` files import it, and `index.ts` does not
 * re-export it (the compiled package must never load node:test).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../test-kit/index.ts';
import type { Db, DriverModule, DriverName, OpenOptions } from './driver.ts';
import { loadDriver, openDatabase, selfTest } from './open.ts';

type DriverUnderTest = DriverName | DriverModule;

interface Ctx {
  /** Open a database file in a fresh temp dir; it is closed before the directory is removed. */
  open(options?: Omit<OpenOptions, 'driver'>, name?: string): Promise<Db>;
  /** Path of a database file in the same temp dir. */
  file(name?: string): string;
}

type Case = (ctx: Ctx, driver: DriverUnderTest) => Promise<void> | void;

const cases: Array<readonly [string, Case]> = [];

function define(title: string, body: Case): void {
  cases.push([title, body]);
}

define('writable databases open in WAL mode with synchronous NORMAL and foreign keys on', async (ctx) => {
  const db = await ctx.open();
  assert.equal(db.pragma('journal_mode'), 'wal');
  assert.equal(db.pragma('synchronous'), 1);
  assert.equal(db.pragma('foreign_keys'), 1);
  assert.match(db.sqliteVersion, /^\d+\.\d+\.\d+/);
  const [major = 0, minor = 0] = db.sqliteVersion.split('.').map(Number);
  assert.ok(major > 3 || (major === 3 && minor >= 34), `SQLite ${db.sqliteVersion} is older than 3.34`);
});

define('TEXT with an embedded NUL round-trips intact, as do the empty string and an emoji', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO t (s) VALUES (?)');
  insert.run('ab\u0000cd');
  insert.run('');
  insert.run('a\u{1F600}b');
  const rows = db.prepare('SELECT s FROM t ORDER BY id').all();
  assert.deepStrictEqual(
    rows.map((r) => r.s),
    ['ab\u0000cd', '', 'a\u{1F600}b'],
  );
  assert.equal(String(rows[0]?.s).length, 5);
});

define('BLOB, REAL and NULL round-trip with exact types', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB, r REAL, n TEXT)');
  db.prepare('INSERT INTO t (b, r, n) VALUES (?, ?, ?)').run(new Uint8Array([0, 1, 2, 255]), 1.5, null);
  const row = db.prepare('SELECT b, r, n FROM t').get();
  assert.deepStrictEqual(row, { b: new Uint8Array([0, 1, 2, 255]), r: 1.5, n: null });
});

define('rows are plain objects', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO t (name) VALUES (?)').run('x');
  const row = db.prepare('SELECT id, name FROM t').get();
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepStrictEqual(row, { id: 1, name: 'x' });
  assert.deepStrictEqual(db.prepare('SELECT id, name FROM t').all(), [{ id: 1, name: 'x' }]);
  assert.equal(db.prepare('SELECT id FROM t WHERE id = ?').get(99), undefined);
});

define('close is idempotent and the database files can be deleted right after', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO t DEFAULT VALUES').run();
  const file = db.path;
  db.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(file + suffix, { force: true }); // EBUSY on Windows if a handle were still open
    assert.equal(fs.existsSync(file + suffix), false);
  }
});

/** Register the whole suite for one driver. Call it from the driver's own `*.test.ts` file. */
export function defineDriverContract(label: string, driver: DriverUnderTest): void {
  describe(`driver contract: ${label}`, () => {
    for (const [title, body] of cases) {
      it(title, async (t) => {
        const tmp = makeTempDir();
        t.after(() => tmp.cleanup());
        const ctx: Ctx = {
          file: (name = 'test.db') => path.join(tmp.path, name),
          open: async (options = {}, name = 'test.db') =>
            tmp.adopt(await openDatabase(path.join(tmp.path, name), { ...options, driver })),
        };
        await body(ctx, driver);
      });
    }

    it('self-test passes and reports capabilities', async () => {
      const module = typeof driver === 'string' ? await loadDriver(driver) : driver;
      const capabilities = selfTest(module);
      assert.equal(typeof capabilities.fts5Trigram, 'boolean');
      assert.equal(typeof capabilities.json, 'boolean');
    });
  });
}
