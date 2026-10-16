/**
 * The Fact Store conformance suite: one list of cases, registered once per SQLite driver, so both drivers run
 * exactly the same cases through the public FactStore interface. This is test code: only this module's own
 * `*.test.ts` files import it, and `index.ts` does not re-export it (the compiled package must never load
 * node:test).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FileFacts, Span } from '../facts/index.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { Db, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { SchemaTooNew, StoreClosed, UnknownWorktree, WriterBusy } from './errors.ts';
import { openFactStore } from './open.ts';
import type { OpenFactStoreOptions } from './open.ts';
import { SCHEMA_VERSION, STORE_FILE_NAME } from './schema.ts';
import type { FactStore, StoreDeps } from './types.ts';

interface Fixture {
  readonly store: FactStore;
  readonly clock: FakeClock;
  readonly file: string;
  /** Open a read-only kit connection on the store file; it is closed before the directory is removed. */
  peek(): Promise<Db>;
  /** Open a writable kit connection on the store file (tests that tamper with or lock the file). */
  tamper(): Promise<Db>;
  /** Close the current store and open the same directory again. */
  reopen(extra?: Partial<OpenFactStoreOptions>): Promise<FactStore>;
  /** Open the directory again without closing the current store (for failures that must be observed). */
  open(extra?: Partial<OpenFactStoreOptions>): Promise<FactStore>;
}

async function withStore(
  driver: DriverName,
  run: (fx: Fixture) => Promise<void>,
  options: Partial<OpenFactStoreOptions> = {},
): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const deps: StoreDeps = {
    resolver: async function* () {
      // a resolver that resolves nothing
    },
    clock,
    gitHas: async () => true,
  };
  const dir = path.join(tmp.path, 'store');
  const file = path.join(dir, STORE_FILE_NAME);
  const opened: FactStore[] = [];
  const open = async (extra: Partial<OpenFactStoreOptions> = {}): Promise<FactStore> => {
    const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9', ...options, ...extra });
    opened.push(store);
    return store;
  };
  try {
    let current = await open();
    const fx: Fixture = {
      get store() {
        return current;
      },
      clock,
      file,
      peek: async () => tmp.adopt(await openDatabase(file, { readOnly: true, driver })),
      tamper: async () => tmp.adopt(await openDatabase(file, { driver })),
      reopen: async (extra) => {
        await current.close();
        current = await open(extra);
        return current;
      },
      open,
    };
    await run(fx);
  } finally {
    for (const store of opened) await store.close(); // close the store handles before the directory goes (EBUSY on Windows)
    tmp.cleanup();
  }
}

const span = (startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn + 1): Span => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

/** A 40-hex blob id built from a number, so fixtures read as H(1), H(2). */
const H = (n: number): string => n.toString(16).padStart(40, '0');

/** One exported function `parse` (span 2:0 to 4:1) that calls `tokenize` and imports it. */
function parseFacts(filePath: string, hash: string, overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: [{ name: 'parse', kind: 'function', span: span(2, 0, 4, 1), exported: true }],
    refSites: [{ name: 'tokenize', span: span(3, 2, 3, 10), kind: 'call', enclosing: 0 }],
    imports: [
      {
        path: './lex',
        span: span(0, 0, 0, 22),
        style: 'es',
        bindings: [{ imported: 'tokenize', local: 'tokenize' }],
      },
    ],
    exports: [{ name: 'parse', span: span(2, 0, 4, 1) }],
    parse: { errorBytes: 0, totalBytes: 120 },
    ...overrides,
  };
}

/** Facts that use every optional field, to prove they all survive a round trip. */
function richFacts(filePath: string, hash: string): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: [
      { name: 'Box', kind: 'class', qualifiedName: 'Box', span: span(0, 0, 9, 1), exported: false },
      { name: 'put', kind: 'method', qualifiedName: 'Box.put', span: span(2, 2, 4, 3), parent: 0 },
    ],
    refSites: [
      { name: 'put', span: span(6, 4, 6, 7), importPath: './box', kind: 'member', enclosing: 1 },
      { name: 'Box', span: span(8, 0, 8, 3), kind: 'new' },
    ],
    imports: [
      { path: './box', span: span(0, 0, 0, 20), style: 'cjs', bindings: [{ imported: '*', local: 'box' }] },
      { path: 'side', span: span(1, 0, 1, 14), style: 'side-effect' },
    ],
    exports: [
      { name: 'default', local: 'Box', span: span(9, 0, 9, 22), from: './other' },
      { name: 'Box', span: span(9, 0, 9, 10) },
    ],
    parse: { errorBytes: 3, totalBytes: 99 },
  };
}

const COUNTED_TABLES = ['files', 'names', 'symbols', 'refs', 'imports', 'import_bindings', 'exports', 'overlays', 'overlay_files'];

/** Row counts of every table, read through a second kit connection. */
function counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
    out[table] = Number(row?.n);
  }
  return out;
}

export function defineFactStoreContract(label: string, driver: DriverName): void {
  describe(`fact store contract (${label})`, () => {
    it('a fresh store reports schema version 1, no worktrees and no held writer lease', async () => {
      await withStore(driver, async (fx) => {
        const status = await fx.store.status();
        assert.equal(status.schemaVersion, SCHEMA_VERSION);
        assert.equal(status.schemaVersion, 1);
        assert.deepStrictEqual(status.worktrees, []);
        assert.ok(status.sizeBytes > 0);
        assert.equal(status.writerLeaseHeld, false);
      });
    });

    it('commitFile stores one file and find returns the definition with full provenance', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const result = await writer.commitFile({
          worktree: 'main',
          path: 'src/a.ts',
          hash: H(1),
          facts: parseFacts('src/a.ts', H(1)),
        });
        assert.equal(result.status, 'committed');
        assert.equal(result.seq, 1);
        assert.deepStrictEqual(result.diagnostics, []);

        const answer = await fx.store.at('main').find('parse');
        assert.deepStrictEqual(answer.watermark, { seq: 1, stalePaths: [] });
        assert.equal(answer.degraded, undefined);
        assert.equal(answer.data.length, 1);
        const record = answer.data[0];
        assert.ok(record);
        assert.deepStrictEqual(record.identity, { repo: 'repo', path: 'src/a.ts', qualifiedName: 'parse', kind: 'function' });
        assert.equal(record.source_path, 'src/a.ts');
        assert.deepStrictEqual(record.span, span(2, 0, 4, 1));
        assert.equal(record.extractor, 'grammar:typescript@0.23.2');
        assert.equal(record.content_hash, H(1));
        assert.equal(record.first_seen, 1000);
        assert.equal(record.last_seen, 1000);
        assert.equal(record.confidence, 'EXTRACTED');
        assert.equal(record.exported, true);
        assert.equal(record.version, H(1));
        assert.equal(record.debug, `sym/src%2Fa.ts/${H(1)}/0`);
        writer.release();
      });
    });

    it('fileFacts returns the committed facts and null for a path outside the overlay', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const facts = parseFacts('src/a.ts', H(1));
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts });
        const reader = fx.store.at('main');
        const found = await reader.fileFacts('src/a.ts');
        assert.deepStrictEqual(found.data, facts);
        assert.deepStrictEqual(found.watermark, { seq: 1, stalePaths: [] });
        const missing = await reader.fileFacts('src/none.ts');
        assert.equal(missing.data, null);
        writer.release();
      });
    });

    it('fileFacts round-trips every optional field: qualifiedName, parent, exported, importPath, kind, enclosing, style, bindings, local and from', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const facts = richFacts('lib/box.ts', H(2));
        await writer.commitFile({ worktree: 'main', path: 'lib/box.ts', hash: H(2), facts });
        const found = await fx.store.at('main').fileFacts('lib/box.ts');
        assert.deepStrictEqual(found.data, facts);
        writer.release();
      });
    });

    it('a read of an unknown worktree rejects with UnknownWorktree', async () => {
      await withStore(driver, async (fx) => {
        await assert.rejects(
          fx.store.at('nope').find('x'),
          (error: unknown) => error instanceof UnknownWorktree && error.worktree === 'nope',
        );
        await assert.rejects(fx.store.at('nope').fileFacts('a.ts'), UnknownWorktree);
      });
    });

    it('every call after close rejects with StoreClosed, and close is idempotent', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: parseFacts('src/a.ts', H(1)) });
        const reader = fx.store.at('main');
        await fx.store.close();
        await assert.rejects(reader.find('parse'), StoreClosed);
        await assert.rejects(reader.fileFacts('src/a.ts'), StoreClosed);
        await assert.rejects(fx.store.at('other').find('parse'), StoreClosed);
        await assert.rejects(
          writer.commitFile({ worktree: 'main', path: 'src/b.ts', hash: H(3), facts: parseFacts('src/b.ts', H(3)) }),
          StoreClosed,
        );
        assert.throws(() => fx.store.writer(), StoreClosed);
        await assert.rejects(fx.store.status(), StoreClosed);
        await assert.rejects(fx.store.reconcile({ worktree: 'main', pathToHash: new Map() }), StoreClosed);
        await fx.store.close();
      });
    });

    it('auto_vacuum is incremental on the created database', async () => {
      await withStore(driver, async (fx) => {
        const db = await fx.peek();
        assert.equal(db.pragma('auto_vacuum'), 2);
      });
    });

    it('SchemaTooNew carries meta.created_by when the store on disk is newer than this build', async () => {
      await withStore(driver, async (fx) => {
        await fx.store.close();
        const db = await fx.tamper();
        db.prepare('UPDATE meta SET value = ? WHERE name = ?').run(String(SCHEMA_VERSION + 1), 'schema_version');
        const created = db.prepare('SELECT value FROM meta WHERE name = ?').get('created_by');
        assert.equal(created?.value, '9.9.9');
        db.close();
        await assert.rejects(
          fx.open(),
          (error: unknown) => error instanceof SchemaTooNew && error.hostVersion === '9.9.9',
        );
      });
    });

    it('[edge STO-01/idempotency] opening an existing store again leaves every row and the schema version unchanged', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: parseFacts('src/a.ts', H(1)) });
        writer.release();
        const peek = await fx.peek();
        const before = counts(peek);
        const metaBefore = peek.prepare('SELECT name, value FROM meta ORDER BY name').all();

        const again = await fx.reopen();
        assert.deepStrictEqual(counts(peek), before);
        assert.deepStrictEqual(peek.prepare('SELECT name, value FROM meta ORDER BY name').all(), metaBefore);
        assert.equal((await again.status()).schemaVersion, 1);
        const found = await again.at('main').find('parse');
        assert.equal(found.data.length, 1);
        assert.deepStrictEqual(found.watermark, { seq: 1, stalePaths: [] });
      });
    });

    it('[edge STO-01/concurrency] a second writer() throws WriterBusy until the first is released', async () => {
      await withStore(driver, async (fx) => {
        const first = fx.store.writer();
        assert.equal((await fx.store.status()).writerLeaseHeld, true);
        assert.throws(() => fx.store.writer(), WriterBusy);
        first.release();
        first.release();
        assert.equal((await fx.store.status()).writerLeaseHeld, false);
        const second = fx.store.writer();
        second.release();
      });
    });

    it('[edge STO-01/concurrency] a reader keeps returning the last committed state while a writer transaction is open', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: parseFacts('src/a.ts', H(1)) });
        const other = await fx.tamper();
        other.exec('BEGIN IMMEDIATE');
        other.prepare('UPDATE overlays SET seq = seq + 10 WHERE worktree = ?').run('main');
        const during = await fx.store.at('main').find('parse');
        other.exec('ROLLBACK');
        assert.equal(during.data.length, 1);
        assert.deepStrictEqual(during.watermark, { seq: 1, stalePaths: [] });
        const after = await fx.store.at('main').find('parse');
        assert.deepStrictEqual(after.watermark, { seq: 1, stalePaths: [] });
        writer.release();
      });
    });

    it('stores names, kinds, spans, hashes and specifiers only: no column is named text, source or content', async () => {
      await withStore(driver, async (fx) => {
        const db = await fx.peek();
        const rows = db
          .prepare(
            `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'`,
          )
          .all();
        assert.ok(rows.length > 20, 'the schema has tables and columns');
        const tables = new Set(rows.map((row) => String(row.tbl)));
        for (const table of COUNTED_TABLES) assert.ok(tables.has(table), `table ${table} exists`);
        for (const row of rows) {
          assert.ok(
            !['text', 'source', 'content', 'contents', 'body'].includes(String(row.col).toLowerCase()),
            `${String(row.tbl)}.${String(row.col)} could hold source text`,
          );
        }
      });
    });
  });
}
