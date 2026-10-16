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
import { DbError, IntegerOutOfRangeError } from './errors.ts';
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

define('integers beyond 2^53 throw IntegerOutOfRangeError in number mode and read exactly in bigint mode', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (n INTEGER)');
  const insert = db.prepare('INSERT INTO t (n) VALUES (?)');
  insert.run(9007199254740993n);
  insert.run(5);
  const small = db.prepare('SELECT n FROM t WHERE n = ?').get(5);
  assert.deepStrictEqual(small, { n: 5 });
  assert.equal(typeof small?.n, 'number');
  assert.throws(() => db.prepare('SELECT n FROM t ORDER BY n DESC').get(), IntegerOutOfRangeError);
  assert.throws(() => db.prepare('SELECT n FROM t').all(), IntegerOutOfRangeError);

  const exact = await ctx.open({ bigints: 'bigint' });
  assert.deepStrictEqual(exact.prepare('SELECT n FROM t ORDER BY n DESC').get(), { n: 9007199254740993n });
  assert.deepStrictEqual(exact.prepare('SELECT n FROM t WHERE n = ?').get(5), { n: 5n });
});

define('unsupported parameter types throw TypeError', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (v)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  assert.throws(() => insert.run(undefined as never), TypeError);
  assert.throws(() => insert.run(true as never), TypeError);
  assert.throws(() => insert.run({} as never), TypeError);
  assert.equal(db.prepare('SELECT count(*) AS c FROM t').get()?.c, 0);
});

define('bound parameters, run results and all()', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
  assert.deepStrictEqual(insert.run('a'), { changes: 1, lastInsertRowid: 1 });
  assert.deepStrictEqual(insert.run('b'), { changes: 1, lastInsertRowid: 2 });
  assert.deepStrictEqual(db.prepare('SELECT name FROM t WHERE id > ? ORDER BY id').all(0), [
    { name: 'a' },
    { name: 'b' },
  ]);
  assert.throws(() => db.prepare('SELEC nope'), (error: unknown) => error instanceof DbError && error.code === 'other');
});

define('a transaction commits on return and rolls back on throw; a nested transaction throws', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const count = () => db.prepare('SELECT count(*) AS c FROM t').get()?.c;
  assert.equal(
    db.transaction(() => {
      db.prepare('INSERT INTO t DEFAULT VALUES').run();
      return 'done';
    }),
    'done',
  );
  assert.equal(count(), 1);
  assert.throws(
    () =>
      db.transaction(() => {
        db.prepare('INSERT INTO t DEFAULT VALUES').run();
        throw new Error('stop');
      }),
    /stop/,
  );
  assert.equal(count(), 1);
  assert.throws(() => db.transaction(() => db.transaction(() => 1)), /savepoint/);
  assert.equal(count(), 1);
  // The failed nested attempt must not leave a transaction open.
  assert.equal(db.transaction(() => 7), 7);
});

define('a savepoint rolls back only the inner work', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.transaction(() => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
    assert.throws(
      () =>
        db.savepoint('inner', () => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
          throw new Error('undo');
        }),
      /undo/,
    );
    db.savepoint('kept', () => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('kept');
    });
  });
  assert.deepStrictEqual(
    db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v),
    ['outer', 'kept'],
  );
});

define('savepoint names and pragma names and values are validated, so nothing is injected', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE x (id INTEGER)');
  const tableSurvives = () => db.prepare(`SELECT name FROM sqlite_master WHERE name = 'x'`).get() !== undefined;
  assert.throws(() => db.savepoint('a; DROP TABLE x', () => 1), TypeError);
  assert.throws(() => db.savepoint('1bad', () => 1), TypeError);
  assert.throws(() => db.pragma('user_version; DROP TABLE x' as never), TypeError);
  assert.throws(() => db.pragma('writable_schema' as never), TypeError);
  assert.throws(() => db.pragma('user_version', '1; DROP TABLE x'), TypeError);
  assert.throws(() => db.pragma('user_version', 1.5), TypeError);
  assert.equal(tableSurvives(), true);
  assert.equal(db.pragma('user_version', 7), undefined);
  assert.equal(db.pragma('user_version'), 7);
  assert.equal(db.pragma('quick_check'), 'ok');
});

define('a second connection gets DbError busy while the first holds a write transaction', async (ctx) => {
  const first = await ctx.open({ timeoutMs: 0 });
  first.exec('CREATE TABLE t (id INTEGER)');
  const second = await ctx.open({ timeoutMs: 0 });
  first.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(
      () => second.transaction(() => 1),
      (error: unknown) => error instanceof DbError && error.code === 'busy' && error.sqliteCode === 5,
    );
  } finally {
    first.exec('ROLLBACK');
  }
  assert.equal(second.transaction(() => 1), 1);
});

define('a read-only connection gets DbError readonly on insert', async (ctx) => {
  const writer = await ctx.open();
  writer.exec('CREATE TABLE t (id INTEGER)');
  const reader = await ctx.open({ readOnly: true });
  assert.deepStrictEqual(reader.prepare('SELECT count(*) AS c FROM t').get(), { c: 0 });
  assert.throws(
    () => reader.prepare('INSERT INTO t DEFAULT VALUES').run(),
    (error: unknown) => error instanceof DbError && error.code === 'readonly',
  );
});

define('a unique-key violation is DbError constraint', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO t (k) VALUES (?)').run('a');
  assert.throws(
    () => db.prepare('INSERT INTO t (k) VALUES (?)').run('a'),
    (error: unknown) => error instanceof DbError && error.code === 'constraint' && error.sqliteCode === 19,
  );
});

define('FTS5 trigram finds a substring and returns no rows, and no error, for a two-character query', async (ctx) => {
  const db = await ctx.open();
  db.exec(`CREATE VIRTUAL TABLE names USING fts5(name, tokenize='trigram')`);
  db.prepare('INSERT INTO names (name) VALUES (?)').run('getUserName');
  assert.deepStrictEqual(db.prepare('SELECT name FROM names WHERE names MATCH ?').all('serNa'), [{ name: 'getUserName' }]);
  assert.deepStrictEqual(db.prepare('SELECT name FROM names WHERE names MATCH ?').all('se'), []);
});

define('loadExtension is unavailable: the Db has none and the load_extension SQL function fails', async (ctx) => {
  const db = await ctx.open();
  assert.equal('loadExtension' in db, false);
  assert.throws(
    () => db.exec(`SELECT load_extension('nothing')`),
    (error: unknown) => error instanceof DbError && error.code === 'other',
  );
});

/** Fill a table with enough rows (about 2 MB of TEXT) that deleting them frees many pages. */
function fillAndEmpty(db: Db): void {
  db.exec('DROP TABLE IF EXISTS bulk');
  db.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)');
  const pad = 'x'.repeat(1000);
  db.transaction(() => {
    const insert = db.prepare('INSERT INTO bulk (pad) VALUES (?)');
    for (let i = 0; i < 2000; i += 1) insert.run(pad);
  });
  db.exec('DELETE FROM bulk');
}

const toInt = (value: unknown): number => {
  assert.equal(typeof value, 'number', `expected an integer, got ${String(value)}`);
  return value as number;
};

define('incremental_vacuum returns freed pages to the file on an auto_vacuum INCREMENTAL database, run twice with the same result (STO-01 idempotency)', async (ctx) => {
  const db = await ctx.open();
  db.pragma('auto_vacuum', 'INCREMENTAL'); // must be set before the first table exists
  assert.equal(db.pragma('auto_vacuum'), 2);
  const results: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    fillAndEmpty(db);
    const freeBefore = toInt(db.pragma('freelist_count'));
    assert.ok(freeBefore > 20, `round ${round}: expected many free pages, got ${freeBefore}`);
    const pagesBefore = toInt(db.pragma('page_count'));
    db.pragma('incremental_vacuum', 10);
    const freeAfter = toInt(db.pragma('freelist_count'));
    assert.equal(freeAfter, freeBefore - 10, `round ${round}: incremental_vacuum(10) frees exactly ten pages`);
    assert.equal(toInt(db.pragma('page_count')), pagesBefore - 10);
    db.pragma('incremental_vacuum', 100000); // more than the freelist holds: frees all of it, no error
    assert.equal(db.pragma('freelist_count'), 0);
    results.push(freeBefore - freeAfter);
  }
  assert.deepStrictEqual(results[0], results[1]);
});

define('wal_checkpoint TRUNCATE reports success in its first column and empties the -wal file, run twice (STO-01 idempotency)', async (ctx) => {
  const db = await ctx.open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)');
  const wal = `${db.path}-wal`;
  for (let round = 0; round < 2; round += 1) {
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO t (pad) VALUES (?)');
      for (let i = 0; i < 50; i += 1) insert.run('y'.repeat(200));
    });
    assert.ok(fs.statSync(wal).size > 0, `round ${round}: the write left frames in the -wal file`);
    assert.equal(db.pragma('wal_checkpoint', 'TRUNCATE'), 0, `round ${round}: busy flag`);
    assert.equal(fs.statSync(wal).size, 0, `round ${round}: the -wal file is empty after TRUNCATE`);
  }
  assert.equal(db.prepare('SELECT count(*) AS c FROM t').get()?.c, 100);
});

define('journal_size_limit can be set to an integer and read back, run twice (STO-01 idempotency)', async (ctx) => {
  const db = await ctx.open();
  for (let round = 0; round < 2; round += 1) {
    assert.equal(db.pragma('journal_size_limit', 1048576), 1048576);
    assert.equal(db.pragma('journal_size_limit'), 1048576);
  }
  assert.equal(db.pragma('journal_size_limit', -1), -1);
});

define('page_count is positive once a table exists and freelist_count is 0 on a fresh database, then positive after rows are deleted, run twice (STO-01 idempotency)', async (ctx) => {
  const db = await ctx.open();
  db.pragma('auto_vacuum', 'INCREMENTAL');
  db.exec('CREATE TABLE fresh (id INTEGER PRIMARY KEY)');
  assert.ok(toInt(db.pragma('page_count')) > 0);
  assert.equal(db.pragma('freelist_count'), 0);
  for (let round = 0; round < 2; round += 1) {
    fillAndEmpty(db);
    assert.ok(toInt(db.pragma('freelist_count')) > 0, `round ${round}`);
    assert.ok(toInt(db.pragma('page_count')) > 0, `round ${round}`);
    db.pragma('incremental_vacuum'); // no argument: free every page, so the next round starts clean
    assert.equal(db.pragma('freelist_count'), 0, `round ${round}`);
  }
});

define('a pragma outside the allowlist and a value that is not a word or an integer are still refused after the allowlist grew', async (ctx) => {
  const db = await ctx.open();
  assert.throws(() => db.pragma('locking_mode' as never), TypeError);
  assert.throws(() => db.pragma('wal_checkpoint', 'TRUNCATE; DROP TABLE x'), TypeError);
  assert.throws(() => db.pragma('incremental_vacuum', 1.5), TypeError);
  assert.throws(() => db.pragma('journal_size_limit', '1; DROP TABLE x'), TypeError);
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
      assert.equal(typeof capabilities.contentlessDelete, 'boolean');
      assert.equal(selfTest(module), capabilities, 'the capabilities are cached per driver');
    });

    it('contentlessDelete is reported true on a SQLite that has contentless_delete (3.43 and newer)', async (t) => {
      const tmp = makeTempDir();
      t.after(() => tmp.cleanup());
      const db = tmp.adopt(await openDatabase(path.join(tmp.path, 'cap.db'), { driver }));
      const module = typeof driver === 'string' ? await loadDriver(driver) : driver;
      const [major = 0, minor = 0] = db.sqliteVersion.split('.').map(Number);
      const hasFeature = major > 3 || (major === 3 && minor >= 43);
      assert.equal(selfTest(module).contentlessDelete, hasFeature);
    });
  });
}
