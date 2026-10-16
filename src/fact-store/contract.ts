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
import type { CommitFileInput, CommitResult, FactStore, StoreDeps, Writer } from './types.ts';

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

/** Commit `parseFacts(path, H(n))` (or an override of it) into a worktree. */
function put(
  writer: Writer,
  worktree: string,
  filePath: string,
  n: number,
  overrides: Partial<FileFacts> = {},
): Promise<CommitResult> {
  return writer.commitFile({ worktree, path: filePath, hash: H(n), facts: parseFacts(filePath, H(n), overrides) });
}

/** Facts with one definition called `name` and nothing else. */
function named(filePath: string, n: number, name: string, extra: Partial<FileFacts> = {}): FileFacts {
  return parseFacts(filePath, H(n), {
    symbols: [{ name, kind: 'function', span: span(1, 0, 2, 1) }],
    refSites: [],
    imports: [],
    exports: [],
    ...extra,
  });
}

/** Run a commit that must be rejected and prove the store did not change: same rows, same watermark. */
async function expectRejected(fx: Fixture, writer: Writer, input: CommitFileInput, code: string): Promise<void> {
  const peek = await fx.peek();
  const before = counts(peek);
  const seqBefore = (await fx.store.at('main').find('parse')).watermark.seq;
  const result = await writer.commitFile(input);
  assert.equal(result.status, 'rejected');
  assert.equal(result.seq, seqBefore);
  assert.ok(
    result.diagnostics.some((d) => d.code === code),
    `expected a ${code} diagnostic, got ${JSON.stringify(result.diagnostics)}`,
  );
  assert.deepStrictEqual(counts(peek), before);
  assert.equal((await fx.store.at('main').find('parse')).watermark.seq, seqBefore);
}

const FILE_STATES_SQL = 'SELECT hash, state, retired_at FROM files ORDER BY id';

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

    it('unchanged: committing the same worktree, path and hash twice returns unchanged with the same seq and writes no row', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        assert.equal((await put(writer, 'main', 'src/a.ts', 1)).status, 'committed');
        const before = counts(peek);
        const again = await put(writer, 'main', 'src/a.ts', 1);
        assert.equal(again.status, 'unchanged');
        assert.equal(again.seq, 1);
        assert.deepStrictEqual(again.diagnostics, []);
        assert.deepStrictEqual(counts(peek), before);
        assert.equal((await fx.store.at('main').find('parse')).watermark.seq, 1);
        writer.release();
      });
    });

    it('retire: a new hash for a path retires the old file when nothing else references it, and the old hash revives without new fact rows', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);
        await fx.clock.advance(50);
        const second = await put(writer, 'main', 'src/a.ts', 2, {
          symbols: [{ name: 'parse', kind: 'function', span: span(7, 0, 9, 1) }],
        });
        assert.equal(second.status, 'committed');
        assert.equal(second.seq, 2);
        assert.deepStrictEqual(peek.prepare(FILE_STATES_SQL).all(), [
          { hash: H(1), state: 'retired', retired_at: 1050 },
          { hash: H(2), state: 'live', retired_at: null },
        ]);
        const found = await fx.store.at('main').find('parse');
        assert.equal(found.data.length, 1);
        assert.equal(found.data[0]?.content_hash, H(2));

        const symbolRows = counts(peek).symbols;
        await fx.clock.advance(50);
        const third = await put(writer, 'main', 'src/a.ts', 1);
        assert.equal(third.status, 'committed');
        assert.equal(third.seq, 3);
        assert.deepStrictEqual(peek.prepare(FILE_STATES_SQL).all(), [
          { hash: H(1), state: 'live', retired_at: null },
          { hash: H(2), state: 'retired', retired_at: 1100 },
        ]);
        assert.equal(counts(peek).symbols, symbolRows, 'reviving a retired hash inserts no fact rows');
        const revived = await fx.store.at('main').find('parse');
        assert.equal(revived.data[0]?.content_hash, H(1));
        assert.equal(revived.data[0]?.first_seen, 1000);
        assert.equal(revived.data[0]?.last_seen, 1100);
        writer.release();
      });
    });

    it('[edge STO-03/concurrency] retire: facts for a hash are kept while any path or worktree still references them', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        const states = (): unknown[] => peek.prepare(FILE_STATES_SQL).all().map((row) => [row.hash, row.state]);
        await put(writer, 'main', 'src/a.ts', 1);
        await put(writer, 'main', 'src/b.ts', 1);
        await put(writer, 'main', 'src/a.ts', 2);
        assert.deepStrictEqual(states(), [[H(1), 'live'], [H(2), 'live']], 'src/b.ts still references H1');

        await put(writer, 'feat', 'src/x.ts', 3);
        await put(writer, 'main', 'src/c.ts', 3);
        await put(writer, 'main', 'src/c.ts', 4);
        assert.deepStrictEqual(states(), [[H(1), 'live'], [H(2), 'live'], [H(3), 'live'], [H(4), 'live']], 'feat still references H3');

        await writer.dropOverlay('feat');
        assert.deepStrictEqual(states(), [[H(1), 'live'], [H(2), 'live'], [H(3), 'retired'], [H(4), 'live']]);
        writer.release();
      });
    });

    it('[edge STO-03/adjacency] two paths with identical content share one files row and yield one record per path', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);
        await fx.clock.advance(10);
        const second = await put(writer, 'main', 'src/b.ts', 1);
        assert.equal(second.status, 'committed');
        assert.equal(second.seq, 2);
        const counted = counts(peek);
        assert.equal(counted.files, 1);
        assert.equal(counted.symbols, 1);
        assert.equal(counted.overlay_files, 2);
        const found = await fx.store.at('main').find('parse');
        assert.deepStrictEqual(
          found.data.map((record) => record.source_path),
          ['src/a.ts', 'src/b.ts'],
        );
        assert.deepStrictEqual(
          found.data.map((record) => record.identity.path),
          ['src/a.ts', 'src/b.ts'],
        );
        assert.equal(new Set(found.data.map((record) => record.debug)).size, 2);
        assert.equal(found.data[0]?.first_seen, 1000);
        assert.equal(found.data[0]?.last_seen, 1010);
        writer.release();
      });
    });

    it('link attaches an existing hash to a path with no new fact rows, and an unknown hash is rejected with hash_unknown', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);
        const before = counts(peek);

        const linked = await writer.link('main', 'src/copy.ts', H(1));
        assert.equal(linked.status, 'committed');
        assert.equal(linked.seq, 2);
        const after = counts(peek);
        assert.equal(after.symbols, before.symbols);
        assert.equal(after.files, before.files);
        assert.equal(after.overlay_files, before.overlay_files + 1);
        const found = await fx.store.at('main').find('parse');
        assert.deepStrictEqual(
          found.data.map((record) => record.source_path),
          ['src/a.ts', 'src/copy.ts'],
        );

        const again = await writer.link('main', 'src/copy.ts', H(1));
        assert.equal(again.status, 'unchanged');
        assert.equal(again.seq, 2);

        const other = await writer.link('elsewhere', 'src/a.ts', H(1));
        assert.equal(other.status, 'committed');
        assert.equal(other.seq, 1);

        const settled = counts(peek);
        const unknown = await writer.link('main', 'src/none.ts', H(9));
        assert.equal(unknown.status, 'rejected');
        assert.equal(unknown.seq, 2);
        assert.ok(unknown.diagnostics.some((d) => d.code === 'hash_unknown'));
        assert.deepStrictEqual(counts(peek), settled);
        writer.release();
      });
    });

    it('rejected: facts that fail validateFileFacts leave the store unchanged, and a rejected first commit creates no overlay', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await put(writer, 'main', 'src/a.ts', 1);
        const noSpan = parseFacts('src/b.ts', H(2), { symbols: [{ name: 'x', kind: 'function' } as never] });
        await expectRejected(fx, writer, { worktree: 'main', path: 'src/b.ts', hash: H(2), facts: noSpan }, 'span_missing');

        const brandNew = await writer.commitFile({ worktree: 'brand-new', path: 'src/b.ts', hash: H(2), facts: noSpan });
        assert.equal(brandNew.status, 'rejected');
        assert.equal(brandNew.seq, 0);
        await assert.rejects(fx.store.at('brand-new').find('x'), UnknownWorktree);
        writer.release();
      });
    });

    it('[edge STO-02/concurrency] hash_mismatch: facts extracted from a different content hash are rejected with nothing written', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await put(writer, 'main', 'src/a.ts', 1);
        await expectRejected(
          fx,
          writer,
          { worktree: 'main', path: 'src/b.ts', hash: H(3), facts: parseFacts('src/b.ts', H(2)) },
          'hash_mismatch',
        );
        writer.release();
      });
    });

    it('facts_too_large: a commit above 200,000 fact rows is rejected with nothing written', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await put(writer, 'main', 'src/a.ts', 1);
        const refSites = Array.from({ length: 200_001 }, (_, i) => ({ name: 'r', span: span(i % 1000, 0, i % 1000, 1) }));
        await expectRejected(
          fx,
          writer,
          { worktree: 'main', path: 'src/big.ts', hash: H(2), facts: parseFacts('src/big.ts', H(2), { refSites }) },
          'facts_too_large',
        );
        writer.release();
      });
    });

    it('commitFile with null facts removes the path, and the second identical call returns unchanged', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);
        const removed = await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: null });
        assert.equal(removed.status, 'committed');
        assert.equal(removed.seq, 2);
        assert.equal((await fx.store.at('main').fileFacts('src/a.ts')).data, null);
        assert.deepStrictEqual((await fx.store.at('main').find('parse')).data, []);
        assert.deepStrictEqual(peek.prepare(FILE_STATES_SQL).all(), [{ hash: H(1), state: 'retired', retired_at: 1000 }]);

        const again = await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: null });
        assert.equal(again.status, 'unchanged');
        assert.equal(again.seq, 2);

        const ghost = await writer.commitFile({ worktree: 'ghost', path: 'src/a.ts', hash: H(1), facts: null });
        assert.equal(ghost.status, 'unchanged');
        assert.equal(ghost.seq, 0);
        await assert.rejects(fx.store.at('ghost').find('parse'), UnknownWorktree);
        writer.release();
      });
    });

    it('setOverlay replaces the overlay: removed paths go, a path whose hash has no facts is pending in stalePaths, and a later commit of that hash clears it in every worktree', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);

        await writer.setOverlay(
          'feat',
          'refs/heads/feat',
          new Map([
            ['src/a.ts', H(1)],
            ['src/new.ts', H(5)],
          ]),
        );
        await writer.setOverlay('other', 'refs/heads/other', new Map([['src/z.ts', H(5)]]));
        assert.equal(peek.prepare('SELECT ref FROM overlays WHERE worktree = ?').get('feat')?.ref, 'refs/heads/feat');

        const feat = await fx.store.at('feat').find('parse');
        assert.deepStrictEqual(feat.data.map((record) => record.source_path), ['src/a.ts']);
        assert.deepStrictEqual(feat.watermark, { seq: 1, stalePaths: ['src/new.ts'] });
        assert.deepStrictEqual(feat.degraded, ['stale']);
        assert.equal((await fx.store.at('feat').fileFacts('src/new.ts')).data, null, 'a pending path has no facts yet');
        assert.deepStrictEqual((await fx.store.at('other').find('fresh')).data, []);

        const committed = await writer.commitFile({
          worktree: 'main',
          path: 'src/new.ts',
          hash: H(5),
          facts: named('src/new.ts', 5, 'fresh'),
        });
        assert.equal(committed.status, 'committed');
        assert.equal(committed.seq, 2);
        const featAfter = await fx.store.at('feat').find('fresh');
        assert.deepStrictEqual(featAfter.data.map((record) => record.source_path), ['src/new.ts']);
        assert.deepStrictEqual(featAfter.watermark, { seq: 2, stalePaths: [] });
        assert.equal(featAfter.degraded, undefined);
        const otherAfter = await fx.store.at('other').find('fresh');
        assert.deepStrictEqual(otherAfter.data.map((record) => record.source_path), ['src/z.ts']);
        assert.deepStrictEqual(otherAfter.watermark, { seq: 2, stalePaths: [] });

        await writer.setOverlay('feat', 'refs/heads/feat-2', new Map([['src/a.ts', H(1)]]));
        assert.equal(peek.prepare('SELECT ref FROM overlays WHERE worktree = ?').get('feat')?.ref, 'refs/heads/feat-2');
        assert.deepStrictEqual((await fx.store.at('feat').find('fresh')).data, []);
        assert.equal((await fx.store.at('other').find('fresh')).data.length, 1, 'H5 is still referenced elsewhere');
        assert.equal(peek.prepare("SELECT state FROM files WHERE hash = ?").get(H(5))?.state, 'live');
        writer.release();
      });
    });

    it('[edge STO-03/empty] setOverlay with an empty map creates an overlay with no files and reads return empty data with the advanced seq', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.setOverlay('empty', 'refs/heads/e', new Map());
        const reader = fx.store.at('empty');
        const found = await reader.find('anything');
        assert.deepStrictEqual(found.data, []);
        assert.deepStrictEqual(found.watermark, { seq: 1, stalePaths: [] });
        assert.equal((await reader.fileFacts('a.ts')).data, null);
        await writer.setOverlay('empty', 'refs/heads/e', new Map());
        assert.equal((await reader.find('anything')).watermark.seq, 1, 'an identical overlay does not advance seq');
        const status = await fx.store.status();
        assert.deepStrictEqual(status.worktrees, [{ worktree: 'empty', seq: 1, stalePaths: 0 }]);
        writer.release();
      });
    });

    it('dropOverlay makes later reads reject with UnknownWorktree and retires files no other overlay references', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);
        await put(writer, 'feat', 'src/a.ts', 1);
        await writer.dropOverlay('main');
        await assert.rejects(fx.store.at('main').find('parse'), UnknownWorktree);
        assert.equal(peek.prepare(FILE_STATES_SQL).get()?.state, 'live', 'feat still references H1');
        assert.equal((await fx.store.at('feat').find('parse')).data.length, 1);
        assert.deepStrictEqual(
          (await fx.store.status()).worktrees.map((entry) => entry.worktree),
          ['feat'],
        );

        await writer.dropOverlay('feat');
        await assert.rejects(fx.store.at('feat').find('parse'), UnknownWorktree);
        assert.equal(peek.prepare(FILE_STATES_SQL).get()?.state, 'retired');
        await writer.dropOverlay('feat');
        await writer.dropOverlay('never-existed');

        const back = await put(writer, 'main', 'src/a.ts', 1);
        assert.equal(back.status, 'committed');
        assert.equal(back.seq, 3, 'seq continues across a drop and a re-creation');
        assert.equal(peek.prepare(FILE_STATES_SQL).get()?.state, 'live');
        writer.release();
      });
    });

    it('markStale marks live files of a module at another grammar version, returns the count, and their facts keep serving as stalePaths', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        await put(writer, 'main', 'src/a.ts', 1);
        await put(writer, 'main', 'src/b.ts', 2);
        await put(writer, 'main', 'src/c.js', 3, { module: 'javascript', grammarVersion: '0.25.0' });

        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '0.23.2' }), 0, 'same version');
        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '0.24.0' }), 2);
        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '0.24.0' }), 0, 'already stale');

        const found = await fx.store.at('main').find('parse');
        assert.equal(found.data.length, 3, 'stale facts keep serving');
        assert.deepStrictEqual(found.watermark, { seq: 4, stalePaths: ['src/a.ts', 'src/b.ts'] });
        assert.deepStrictEqual(found.degraded, ['stale']);
        assert.deepStrictEqual((await fx.store.status()).worktrees, [{ worktree: 'main', seq: 4, stalePaths: 2 }]);

        const symbolRows = counts(peek).symbols;
        const refreshed = await put(writer, 'main', 'src/a.ts', 1, { grammarVersion: '0.24.0' });
        assert.equal(refreshed.status, 'committed');
        assert.equal(refreshed.seq, 5);
        assert.equal(counts(peek).symbols, symbolRows, 'the refreshed facts replace the stale ones');
        const after = await fx.store.at('main').find('parse');
        assert.deepStrictEqual(after.watermark, { seq: 5, stalePaths: ['src/b.ts'] });
        assert.equal(after.data[0]?.extractor, 'grammar:typescript@0.24.0');
        assert.equal(after.data[1]?.extractor, 'grammar:typescript@0.23.2');
        writer.release();
      });
    });

    it('a reader obtained before a commit sees the committed state on its next call', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: named('src/a.ts', 1, 'first') });
        const reader = fx.store.at('main');
        assert.equal((await reader.find('first')).data.length, 1);
        assert.equal((await reader.find('second')).data.length, 0);
        await writer.commitFile({ worktree: 'main', path: 'src/b.ts', hash: H(2), facts: named('src/b.ts', 2, 'second') });
        const later = await reader.find('second');
        assert.equal(later.data.length, 1);
        assert.equal(later.watermark.seq, 2);
        writer.release();
      });
    });

    it('seq is monotonic across every operation and never changes on unchanged or rejected results', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const seq = async (): Promise<number> => (await fx.store.at('main').find('parse')).watermark.seq;
        const seen: number[] = [];
        await put(writer, 'main', 'src/a.ts', 1);
        seen.push(await seq());
        await put(writer, 'main', 'src/a.ts', 1);
        seen.push(await seq());
        await writer.commitFile({ worktree: 'main', path: 'src/x.ts', hash: H(7), facts: parseFacts('src/x.ts', H(8)) });
        seen.push(await seq());
        await put(writer, 'main', 'src/b.ts', 2);
        seen.push(await seq());
        await writer.link('main', 'src/c.ts', H(1));
        seen.push(await seq());
        await writer.link('main', 'src/c.ts', H(1));
        seen.push(await seq());
        const same = new Map([['src/a.ts', H(1)], ['src/b.ts', H(2)], ['src/c.ts', H(1)]]);
        await writer.setOverlay('main', '', same);
        seen.push(await seq());
        await writer.setOverlay('main', '', new Map([['src/a.ts', H(1)], ['src/b.ts', H(2)]]));
        seen.push(await seq());
        await writer.markStale({ module: 'typescript', grammarVersion: '9.9.9' });
        seen.push(await seq());
        await writer.markStale({ module: 'typescript', grammarVersion: '9.9.9' });
        seen.push(await seq());
        assert.deepStrictEqual(seen, [1, 1, 1, 2, 3, 3, 3, 4, 5, 5]);
        writer.release();
      });
    });

    it('[edge STO-03/adjacency] identical spans: two symbols with identical spans in one file are both stored and both returned, never merged', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const twin = { name: 'dup', kind: 'function', span: span(3, 0, 5, 1) };
        await writer.commitFile({
          worktree: 'main',
          path: 'src/dup.ts',
          hash: H(1),
          facts: named('src/dup.ts', 1, 'dup', {
            symbols: [twin, twin, { name: 'dup', kind: 'class', span: span(3, 0, 5, 1) }],
          }),
        });
        const reader = fx.store.at('main');
        const found = await reader.find('dup');
        assert.equal(found.data.length, 3);
        assert.deepStrictEqual(
          found.data.map((record) => [record.identity.kind, record.identity.discriminator]),
          [['function', '0'], ['function', '1'], ['class', undefined]],
        );
        assert.equal(new Set(found.data.map((record) => record.debug)).size, 3);
        assert.deepStrictEqual(found.data[0]?.span, found.data[1]?.span);

        for (const record of found.data) {
          const one = await reader.symbol(record.identity);
          assert.deepStrictEqual(one.data, record);
        }
        assert.equal((await reader.symbol({ repo: 'repo', path: 'src/dup.ts', qualifiedName: 'dup', kind: 'variable' })).data, null);
        assert.equal((await reader.symbol({ repo: 'repo', path: 'src/none.ts', qualifiedName: 'dup', kind: 'class' })).data, null);
        assert.equal((await reader.symbol({ repo: 'elsewhere', path: 'src/dup.ts', qualifiedName: 'dup', kind: 'class' })).data, null);
        writer.release();
      });
    });

    it('[edge STO-03/ordering] find returns records ordered by path, then start line, start column, then definition order, whatever the insertion order', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const symbols = [
          { name: 'item', kind: 'function', span: span(5, 0, 6, 1) },
          { name: 'item', kind: 'class', span: span(1, 4, 2, 1) },
          { name: 'item', kind: 'method', span: span(1, 2, 1, 6) },
          { name: 'item', kind: 'variable', span: span(1, 2, 1, 9) },
        ];
        for (const [n, p] of [[1, 'z.ts'], [2, 'a.ts'], [3, 'm.ts']] as const) {
          await writer.commitFile({ worktree: 'main', path: p, hash: H(n), facts: named(p, n, 'item', { symbols }) });
        }
        const found = await fx.store.at('main').find('item');
        const order = found.data.map((record) => `${record.source_path}:${record.debug.split('/').pop()}`);
        assert.deepStrictEqual(order, [
          'a.ts:2', 'a.ts:3', 'a.ts:1', 'a.ts:0',
          'm.ts:2', 'm.ts:3', 'm.ts:1', 'm.ts:0',
          'z.ts:2', 'z.ts:3', 'z.ts:1', 'z.ts:0',
        ]);
        writer.release();
      });
    });

    it('reconcile lists, sorted, the paths whose hash differs, the truth paths the overlay lacks and the overlay paths the truth lacks', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await put(writer, 'main', 'src/a.ts', 1);
        await put(writer, 'main', 'src/b.ts', 2);
        await put(writer, 'main', 'src/gone.ts', 4);

        const equal = await fx.store.reconcile({
          worktree: 'main',
          pathToHash: new Map([['src/a.ts', H(1)], ['src/b.ts', H(2)], ['src/gone.ts', H(4)]]),
        });
        assert.deepStrictEqual(equal, { reindex: [], complete: true });

        const drifted = await fx.store.reconcile({
          worktree: 'main',
          pathToHash: new Map([['src/c.ts', H(3)], ['src/b.ts', H(9)], ['src/a.ts', H(1)]]),
        });
        assert.deepStrictEqual(drifted, { reindex: ['src/b.ts', 'src/c.ts', 'src/gone.ts'], complete: true });

        const unknown = await fx.store.reconcile({
          worktree: 'nowhere',
          pathToHash: new Map([['z.ts', H(1)], ['a.ts', H(2)]]),
        });
        assert.deepStrictEqual(unknown, { reindex: ['a.ts', 'z.ts'], complete: true });

        await writer.setOverlay('feat', 'refs/heads/feat', new Map([['p.ts', H(5)], ['q.ts', H(1)]]));
        await writer.markStale({ module: 'typescript', grammarVersion: '9.9.9' });
        const waiting = await fx.store.reconcile({
          worktree: 'feat',
          pathToHash: new Map([['p.ts', H(5)], ['q.ts', H(1)]]),
        });
        assert.deepStrictEqual(waiting.reindex, ['p.ts', 'q.ts'], 'a pending path and a stale path still need extraction');
        writer.release();
      });
    });

    it('status reports one WorktreeStatus per live overlay with its seq and stale path count', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await put(writer, 'zeta', 'src/a.ts', 1);
        await writer.setOverlay('alpha', 'refs/heads/alpha', new Map([['p.ts', H(5)]]));
        await put(writer, 'doomed', 'src/a.ts', 1);
        await writer.dropOverlay('doomed');
        const status = await fx.store.status();
        assert.deepStrictEqual(status.worktrees, [
          { worktree: 'alpha', seq: 1, stalePaths: 1 },
          { worktree: 'zeta', seq: 1, stalePaths: 0 },
        ]);
        writer.release();
      });
    });
  });
}
