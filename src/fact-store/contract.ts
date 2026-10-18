/**
 * The Fact Store conformance suite: one list of cases, registered once per SQLite driver, so both drivers run
 * exactly the same cases through the public FactStore interface. This is test code: only this module's own
 * `*.test.ts` files import it, and `index.ts` does not re-export it (the compiled package must never load
 * node:test).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FileFacts, ImportSite, Span, SymbolIdentity } from '../facts/index.ts';
import { createScriptedResolver } from '../precise-resolver/index.ts';
import type { ScriptedEdge } from '../precise-resolver/index.ts';
import { loadDriver, openDatabase, selfTest } from '../sqlite/index.ts';
import type { Db, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { overlaySnapshotId } from './cache.ts';
import { SchemaTooNew, StoreClosed, UnknownWorktree, WriterBusy } from './errors.ts';
import { openFactStore } from './open.ts';
import type { OpenFactStoreOptions } from './open.ts';
import { SCHEMA_VERSION, STORE_FILE_NAME } from './schema.ts';
import type { CommitFileInput, CommitResult, FactStore, FindOptions, Resolver, StoreDeps, Writer } from './types.ts';

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

/** The resolver of a store that has no precise resolver: it resolves nothing. */
const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

async function withStore(
  driver: DriverName,
  run: (fx: Fixture) => Promise<void>,
  options: Partial<OpenFactStoreOptions> = {},
  resolver: Resolver = noResolver,
): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const deps: StoreDeps = {
    resolver,
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

/** A file with the given symbols, sites, imports and exports on top of empty defaults (module typescript 0.23.2). */
function fileOf(filePath: string, n: number, parts: Partial<FileFacts>): FileFacts {
  return parseFacts(filePath, H(n), { symbols: [], refSites: [], imports: [], exports: [], ...parts });
}

/** An import of `specifier` on `line` that binds the given (imported name, local name) pairs. */
function importOf(specifier: string, line: number, ...bindings: Array<[string, string]>): ImportSite {
  return {
    path: specifier,
    span: span(line, 0, line, 30),
    style: 'es',
    bindings: bindings.map(([imported, local]) => ({ imported, local })),
  };
}

/** One function definition called `name` over the three lines from `line`. */
function definition(name: string, line = 1, extra: { exported?: boolean } = {}): FileFacts['symbols'][number] {
  return { name, kind: 'function', span: span(line, 0, line + 2, 1), ...extra };
}

/** How many times a scripted resolver was invoked. */
interface Calls {
  count: number;
}

/** A store Resolver backed by the scripted PreciseResolver stub; `calls` counts invocations. */
function scripted(edges: readonly ScriptedEdge[], calls: Calls): Resolver {
  const inner = createScriptedResolver({ id: 'scripted', edges });
  return (sites, context) => {
    calls.count += 1;
    return inner.resolve({ id: 'overlay', pathToHash: new Map() }, context, sites);
  };
}

/** A scripted resolver that waits for `door` before it yields anything (a slow resolver). */
function gated(edges: readonly ScriptedEdge[], calls: Calls, door: Promise<void>): Resolver {
  const inner = createScriptedResolver({ id: 'scripted', edges });
  return async function* (sites, context) {
    calls.count += 1;
    await door;
    yield* inner.resolve({ id: 'overlay', pathToHash: new Map() }, context, sites);
  };
}

function deferred(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Poll a condition on real timers until it holds; background work has no other signal to wait on. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  assert.fail(`timed out waiting for ${label}`);
}

const SITE_1 = { path: 'src/c.cjs', span: span(3, 2, 3, 5), name: 'run' };
const SITE_2 = { path: 'src/c.cjs', span: span(6, 2, 6, 5), name: 'run' };
const RUN_CTS = identity('src/foo.cts', 'run', 'function');
const RUN_CJS = identity('src/foo.cjs', 'run', 'function');
/** A resolver script that binds both call sites to foo.cjs, so every candidate site has a cached answer. */
const BOTH_SITES: readonly ScriptedEdge[] = [
  { site: SITE_1, target: RUN_CJS },
  { site: SITE_2, target: RUN_CJS },
];

/**
 * Two definitions of `run` (foo.cts and foo.cjs) and c.cjs, which imports `run` from './foo.cjs' (a specifier
 * that names both files, so the grammar tier reports two candidates), calls it at two sites inside `main`, and
 * calls `main` from `top`.
 */
async function seedAmbiguous(writer: Writer, worktree = 'main'): Promise<void> {
  const runFile = (filePath: string, n: number): FileFacts =>
    fileOf(filePath, n, { symbols: [definition('run', 1, { exported: true })], exports: [{ name: 'run', span: span(1, 0, 3, 1) }] });
  await writer.commitFile({ worktree, path: 'src/foo.cts', hash: H(1), facts: runFile('src/foo.cts', 1) });
  await writer.commitFile({ worktree, path: 'src/foo.cjs', hash: H(2), facts: runFile('src/foo.cjs', 2) });
  await writer.commitFile({
    worktree,
    path: 'src/c.cjs',
    hash: H(3),
    facts: fileOf('src/c.cjs', 3, {
      symbols: [
        { name: 'main', kind: 'function', span: span(1, 0, 9, 1) },
        { name: 'top', kind: 'function', span: span(11, 0, 13, 1) },
      ],
      imports: [importOf('./foo.cjs', 0, ['run', 'run'])],
      refSites: [
        { name: 'run', span: SITE_1.span, kind: 'call', enclosing: 0, importPath: './foo.cjs' },
        { name: 'run', span: SITE_2.span, kind: 'call', enclosing: 0, importPath: './foo.cjs' },
        { name: 'main', span: span(12, 2, 12, 6), kind: 'call', enclosing: 1 },
      ],
    }),
  });
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

/** The identity of a definition in the repo the fixtures use. */
function identity(filePath: string, qualifiedName: string, kind: string): SymbolIdentity {
  return { repo: 'repo', path: filePath, qualifiedName, kind };
}

/** `load` is defined at the top and called twice inside `main`, read once, and called once at the top level. */
const loadA = parseFacts('src/a.ts', H(1), {
  symbols: [
    { name: 'load', kind: 'function', span: span(0, 0, 5, 1), exported: true },
    { name: 'main', kind: 'function', span: span(7, 0, 12, 1) },
  ],
  refSites: [
    { name: 'load', span: span(8, 2, 8, 6), kind: 'call', enclosing: 1 },
    { name: 'load', span: span(14, 0, 14, 4), kind: 'call' },
    { name: 'load', span: span(9, 2, 9, 6), kind: 'read', enclosing: 1 },
  ],
  imports: [],
  exports: [{ name: 'load', span: span(0, 0, 5, 1) }],
});

/** Imports `load` from `./a`: one call inside the method `Job.run` and one type use at the top level. */
const loadB = parseFacts('src/b.ts', H(2), {
  symbols: [{ name: 'run', kind: 'method', qualifiedName: 'Job.run', span: span(4, 2, 8, 3) }],
  refSites: [
    { name: 'load', span: span(5, 4, 5, 8), kind: 'call', enclosing: 0, importPath: './a' },
    { name: 'load', span: span(1, 0, 1, 4), kind: 'type', importPath: './a' },
  ],
  imports: [
    { path: './a', span: span(0, 0, 0, 24), style: 'es', bindings: [{ imported: 'load', local: 'load' }] },
  ],
  exports: [],
});

/** Definitions for the prefix and fuzzy cases, plus a name that is only ever referenced. */
const namesFacts = parseFacts('src/names.ts', H(20), {
  symbols: [
    { name: 'getUserName', kind: 'function', span: span(1, 0, 2, 1) },
    { name: 'getUser', kind: 'function', span: span(3, 0, 4, 1) },
    { name: 'setUser', kind: 'function', span: span(5, 0, 6, 1) },
    { name: 'fetchUser', kind: 'function', span: span(7, 0, 8, 1) },
    { name: 'ab', kind: 'function', span: span(9, 0, 10, 1) },
    { name: 'Get', kind: 'variable', span: span(11, 0, 11, 3) },
  ],
  refSites: [{ name: 'userRefOnly', span: span(12, 0, 12, 11) }],
  imports: [],
  exports: [],
});

export function defineFactStoreContract(label: string, driver: DriverName): void {
  describe(`fact store contract (${label})`, () => {
    it('a fresh store reports schema version 2, no worktrees and no held writer lease', async () => {
      await withStore(driver, async (fx) => {
        const status = await fx.store.status();
        assert.equal(status.schemaVersion, SCHEMA_VERSION);
        assert.equal(status.schemaVersion, 2);
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
        assert.equal((await again.status()).schemaVersion, SCHEMA_VERSION);
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
        assert.deepStrictEqual(status.worktrees, [{ worktree: 'empty', seq: 1, stalePaths: 0, files: 0 }]);
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
        assert.deepStrictEqual((await fx.store.status()).worktrees, [{ worktree: 'main', seq: 4, stalePaths: 2, files: 3 }]);

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

    it('refs import scope: sites in the defining file and in files that import the definition, grammar tier INFERRED, ordered by path then span', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: loadA });
        await writer.commitFile({ worktree: 'main', path: 'src/b.ts', hash: H(2), facts: loadB });
        const idA = identity('src/a.ts', 'load', 'function');
        const reader = fx.store.at('main');

        const refs = await reader.refs(idA);
        assert.equal(refs.degraded, undefined);
        assert.deepStrictEqual(refs.watermark, { seq: 2, stalePaths: [] });
        assert.deepStrictEqual(
          refs.data.map((record) => [record.source_path, record.kind, record.span.startLine]),
          [['src/a.ts', 'call', 8], ['src/a.ts', 'read', 9], ['src/a.ts', 'call', 14], ['src/b.ts', 'type', 1], ['src/b.ts', 'call', 5]],
        );
        for (const record of refs.data) {
          assert.equal(record.tier, 'grammar');
          assert.equal(record.confidence, 'INFERRED');
          assert.deepStrictEqual(record.target, idA);
          assert.equal(record.site.name, 'load');
          assert.equal(record.site.path, record.source_path);
          assert.deepStrictEqual(record.site.span, record.span);
          assert.equal(record.extractor, 'grammar:typescript@0.23.2');
        }
        const [first, second, third, fourth, fifth] = refs.data;
        assert.equal(first?.content_hash, H(1));
        assert.equal(first?.debug, `ref/src%2Fa.ts/${H(1)}/0`);
        assert.equal(second?.debug, `ref/src%2Fa.ts/${H(1)}/2`);
        assert.deepStrictEqual(first?.enclosing, identity('src/a.ts', 'main', 'function'));
        assert.equal(third?.enclosing, null, 'a top-level site has no enclosing symbol');
        assert.equal(fourth?.enclosing, null);
        assert.deepStrictEqual(fifth?.enclosing, identity('src/b.ts', 'Job.run', 'method'));
        assert.equal(fifth?.content_hash, H(2));

        for (const record of refs.data) assert.equal(record.candidates, undefined, 'one definition in scope: no candidates field');

        const none = await reader.refs(identity('src/a.ts', 'ghost', 'function'));
        assert.deepStrictEqual(none.data, []);
        assert.deepStrictEqual(none.watermark, { seq: 2, stalePaths: [] });
        writer.release();
      });
    });

    it('refs matches a method by its bare name, taken from the symbol the identity names', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'lib/box.ts', hash: H(2), facts: richFacts('lib/box.ts', H(2)) });
        const reader = fx.store.at('main');
        const put = await reader.refs(identity('lib/box.ts', 'Box.put', 'method'));
        assert.equal(put.data.length, 1);
        assert.equal(put.data[0]?.kind, 'member');
        assert.deepStrictEqual(put.data[0]?.enclosing, identity('lib/box.ts', 'Box.put', 'method'));
        const box = await reader.refs(identity('lib/box.ts', 'Box', 'class'));
        assert.equal(box.data.length, 1);
        assert.equal(box.data[0]?.kind, 'new');
        assert.equal(box.data[0]?.enclosing, null);
        writer.release();
      });
    });

    it('refs same file: a definition and a site of the same name in one file give one record, and an identically named site in a file that does not import it gives none', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({
          worktree: 'main',
          path: 'src/a.ts',
          hash: H(1),
          facts: fileOf('src/a.ts', 1, {
            symbols: [definition('parse', 1), definition('main', 5)],
            refSites: [{ name: 'parse', span: span(6, 2, 6, 7), kind: 'call', enclosing: 1 }],
          }),
        });
        await writer.commitFile({
          worktree: 'main',
          path: 'src/c.ts',
          hash: H(2),
          facts: fileOf('src/c.ts', 2, {
            symbols: [definition('other', 1)],
            refSites: [{ name: 'parse', span: span(2, 2, 2, 7), kind: 'call', enclosing: 0 }],
          }),
        });
        const refs = await fx.store.at('main').refs(identity('src/a.ts', 'parse', 'function'));
        assert.deepStrictEqual(
          refs.data.map((record) => [record.source_path, record.span.startLine, record.tier, record.confidence]),
          [['src/a.ts', 6, 'grammar', 'INFERRED']],
        );
        assert.equal(refs.data[0]?.candidates, undefined);
        assert.deepStrictEqual(refs.data[0]?.enclosing, identity('src/a.ts', 'main', 'function'));
        writer.release();
      });
    });

    it('refs import scope: an aliased named import, a namespace member and a default import reach the definition, while unbound names, other bindings and package imports do not', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const commit = async (filePath: string, n: number, parts: Partial<FileFacts>): Promise<void> => {
          await writer.commitFile({ worktree: 'main', path: filePath, hash: H(n), facts: fileOf(filePath, n, parts) });
        };
        // parse has an export entry; helper has none, so it is found through the exported-flag fallback.
        await commit('src/a.ts', 1, {
          symbols: [definition('parse', 1, { exported: true }), definition('helper', 5, { exported: true })],
          exports: [{ name: 'parse', span: span(1, 0, 3, 1) }],
        });
        // import { parse as p } from './a': the site name p maps through the binding to parse.
        await commit('src/b.ts', 2, {
          symbols: [definition('run', 1)],
          imports: [importOf('./a', 0, ['parse', 'p'])],
          refSites: [{ name: 'p', span: span(2, 2, 2, 3), kind: 'call', enclosing: 0, importPath: './a' }],
        });
        // import * as ns from './a': a member site named parse (and one named helper) reaches the module's exports.
        await commit('src/c.ts', 3, {
          symbols: [definition('run', 1)],
          imports: [importOf('./a', 0, ['*', 'ns'])],
          refSites: [
            { name: 'parse', span: span(2, 5, 2, 10), kind: 'member', enclosing: 0 },
            { name: 'helper', span: span(3, 5, 3, 11), kind: 'member', enclosing: 0 },
          ],
        });
        // import { helper } from './a' and an unbound parse: only helper is in scope.
        await commit('src/d.ts', 4, {
          symbols: [definition('run', 1)],
          imports: [importOf('./a', 0, ['helper', 'helper'])],
          refSites: [
            { name: 'helper', span: span(2, 2, 2, 8), kind: 'call', enclosing: 0, importPath: './a' },
            { name: 'parse', span: span(3, 2, 3, 7), kind: 'call', enclosing: 0 },
          ],
        });
        // import { parse } from 'parse-lib': a package name never resolves.
        await commit('src/e.ts', 5, {
          symbols: [definition('run', 1)],
          imports: [importOf('parse-lib', 0, ['parse', 'parse'])],
          refSites: [{ name: 'parse', span: span(2, 2, 2, 7), kind: 'call', enclosing: 0, importPath: 'parse-lib' }],
        });
        // import parse from './a': a.ts has no default export, so the binding maps to nothing.
        await commit('src/h.ts', 6, {
          symbols: [definition('run', 1)],
          imports: [importOf('./a', 0, ['default', 'parse'])],
          refSites: [{ name: 'parse', span: span(2, 2, 2, 7), kind: 'call', enclosing: 0, importPath: './a' }],
        });
        // import make from './g': g.ts exports `build` as its default.
        await commit('src/g.ts', 7, {
          symbols: [definition('build', 1, { exported: true })],
          exports: [{ name: 'default', local: 'build', span: span(1, 0, 3, 1) }],
        });
        await commit('src/f.ts', 8, {
          symbols: [definition('run', 1)],
          imports: [importOf('./g', 0, ['default', 'make'])],
          refSites: [{ name: 'make', span: span(2, 2, 2, 6), kind: 'call', enclosing: 0, importPath: './g' }],
        });

        const reader = fx.store.at('main');
        const parse = await reader.refs(identity('src/a.ts', 'parse', 'function'));
        assert.deepStrictEqual(
          parse.data.map((record) => [record.source_path, record.site.name, record.kind]),
          [['src/b.ts', 'p', 'call'], ['src/c.ts', 'parse', 'member']],
        );
        for (const record of parse.data) {
          assert.equal(record.tier, 'grammar');
          assert.equal(record.confidence, 'INFERRED');
          assert.equal(record.candidates, undefined);
          assert.deepStrictEqual(record.target, identity('src/a.ts', 'parse', 'function'));
        }
        const helper = await reader.refs(identity('src/a.ts', 'helper', 'function'));
        assert.deepStrictEqual(
          helper.data.map((record) => [record.source_path, record.kind]),
          [['src/c.ts', 'member'], ['src/d.ts', 'call']],
        );
        const build = await reader.refs(identity('src/g.ts', 'build', 'function'));
        assert.deepStrictEqual(build.data.map((record) => [record.source_path, record.site.name]), [['src/f.ts', 'make']]);
        writer.release();
      });
    });

    it('refs export scope: an export alias maps a site in the defining file and in an importer to the local symbol', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const commit = async (filePath: string, n: number, parts: Partial<FileFacts>): Promise<void> => {
          await writer.commitFile({ worktree: 'main', path: filePath, hash: H(n), facts: fileOf(filePath, n, parts) });
        };
        // export { parse as run }: the site `run` in a.ts maps to the local symbol parse.
        await commit('src/a.ts', 1, {
          symbols: [definition('parse', 1)],
          exports: [{ name: 'run', local: 'parse', span: span(5, 0, 5, 25) }],
          refSites: [{ name: 'run', span: span(7, 0, 7, 3), kind: 'call' }],
        });
        await commit('src/b.ts', 2, {
          symbols: [definition('main', 1)],
          imports: [importOf('./a', 0, ['run', 'run'])],
          refSites: [{ name: 'run', span: span(2, 2, 2, 5), kind: 'call', enclosing: 0, importPath: './a' }],
        });
        await commit('src/c.ts', 3, {
          symbols: [definition('main', 1)],
          refSites: [{ name: 'run', span: span(2, 2, 2, 5), kind: 'call', enclosing: 0 }],
        });
        const refs = await fx.store.at('main').refs(identity('src/a.ts', 'parse', 'function'));
        assert.deepStrictEqual(
          refs.data.map((record) => [record.source_path, record.site.name, record.span.startLine]),
          [['src/a.ts', 'run', 7], ['src/b.ts', 'run', 2]],
        );
        writer.release();
      });
    });

    it('refs ambiguity: a specifier that matches two files gives every candidate the site, each record carrying candidates equal to the number of alternatives', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const commit = async (filePath: string, n: number, parts: Partial<FileFacts>): Promise<void> => {
          await writer.commitFile({ worktree: 'main', path: filePath, hash: H(n), facts: fileOf(filePath, n, parts) });
        };
        // The same-file call in foo.cts has exactly one target; the call through ./foo.cjs has two.
        await commit('src/foo.cts', 1, {
          symbols: [definition('x', 1, { exported: true }), definition('self', 5)],
          exports: [{ name: 'x', span: span(1, 0, 3, 1) }],
          refSites: [{ name: 'x', span: span(6, 2, 6, 3), kind: 'call', enclosing: 1 }],
        });
        await commit('src/foo.cjs', 2, {
          symbols: [definition('x', 1, { exported: true })],
          exports: [{ name: 'x', span: span(1, 0, 3, 1) }],
        });
        await commit('src/c.cjs', 3, {
          symbols: [definition('main', 1)],
          imports: [importOf('./foo.cjs', 0, ['x', 'x'])],
          refSites: [{ name: 'x', span: span(2, 2, 2, 3), kind: 'call', enclosing: 0, importPath: './foo.cjs' }],
        });
        const reader = fx.store.at('main');
        const cts = await reader.refs(identity('src/foo.cts', 'x', 'function'));
        assert.deepStrictEqual(
          cts.data.map((record) => [record.source_path, record.candidates]),
          [['src/c.cjs', 2], ['src/foo.cts', undefined]],
        );
        const cjs = await reader.refs(identity('src/foo.cjs', 'x', 'function'));
        assert.deepStrictEqual(cjs.data.map((record) => [record.source_path, record.candidates]), [['src/c.cjs', 2]]);
        assert.deepStrictEqual(cts.data[0]?.site, cjs.data[0]?.site, 'both candidates receive the same site');
        for (const record of [...cts.data, ...cjs.data]) assert.equal(record.confidence, 'INFERRED');
        writer.release();
      });
    });

    it('refs two branches: one file resolves ./b to src/b.ts in one overlay and to src/b/index.ts in the other, with no cache involved', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const peek = await fx.peek();
        const main = fileOf('src/main.ts', 1, {
          symbols: [definition('start', 1)],
          imports: [importOf('./b', 0, ['run', 'run'])],
          refSites: [{ name: 'run', span: span(2, 2, 2, 5), kind: 'call', enclosing: 0, importPath: './b' }],
        });
        const runFile = (filePath: string, n: number): FileFacts =>
          fileOf(filePath, n, { symbols: [definition('run', 1, { exported: true })], exports: [{ name: 'run', span: span(1, 0, 3, 1) }] });
        await writer.commitFile({ worktree: 'wt-a', path: 'src/main.ts', hash: H(1), facts: main });
        await writer.commitFile({ worktree: 'wt-a', path: 'src/b.ts', hash: H(2), facts: runFile('src/b.ts', 2) });
        await writer.commitFile({ worktree: 'wt-b', path: 'src/main.ts', hash: H(1), facts: main });
        await writer.commitFile({ worktree: 'wt-b', path: 'src/b/index.ts', hash: H(3), facts: runFile('src/b/index.ts', 3) });
        assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM files WHERE hash = ?').get(H(1))?.n), 1, 'main.ts is one files row shared by both overlays');

        const inA = await fx.store.at('wt-a').refs(identity('src/b.ts', 'run', 'function'));
        const inB = await fx.store.at('wt-b').refs(identity('src/b/index.ts', 'run', 'function'));
        assert.deepStrictEqual(inA.data.map((record) => record.source_path), ['src/main.ts']);
        assert.deepStrictEqual(inB.data.map((record) => record.source_path), ['src/main.ts']);
        assert.deepStrictEqual(inA.data[0]?.site, inB.data[0]?.site);
        assert.equal(inA.data[0]?.content_hash, inB.data[0]?.content_hash);
        assert.deepStrictEqual(inA.data[0]?.target, identity('src/b.ts', 'run', 'function'));
        assert.deepStrictEqual(inB.data[0]?.target, identity('src/b/index.ts', 'run', 'function'));
        assert.deepStrictEqual((await fx.store.at('wt-a').refs(identity('src/b/index.ts', 'run', 'function'))).data, []);
        assert.deepStrictEqual((await fx.store.at('wt-b').refs(identity('src/b.ts', 'run', 'function'))).data, []);
        writer.release();
      });
    });

    it('callers (one hop) returns the enclosing symbol of each call site and skips top-level calls and non-call sites', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: loadA });
        await writer.commitFile({ worktree: 'main', path: 'src/b.ts', hash: H(2), facts: loadB });
        const idA = identity('src/a.ts', 'load', 'function');
        const reader = fx.store.at('main');

        const callers = await reader.callers(idA, { hops: 1 });
        assert.deepStrictEqual(
          callers.data.map((record) => [record.caller, record.source_path, record.span.startLine]),
          [
            [identity('src/a.ts', 'main', 'function'), 'src/a.ts', 8],
            [identity('src/b.ts', 'Job.run', 'method'), 'src/b.ts', 5],
          ],
        );
        for (const record of callers.data) {
          assert.deepStrictEqual(record.callee, idA);
          assert.equal(record.hops, 1);
          assert.equal(record.tier, 'grammar');
          assert.equal(record.confidence, 'INFERRED');
        }
        assert.equal(callers.data[0]?.debug, `ref/src%2Fa.ts/${H(1)}/0`);

        const deeper = await reader.callers(idA, { hops: 3 });
        assert.deepStrictEqual(deeper.data, callers.data, 'nothing calls main or Job.run, so more hops add nothing');
        assert.deepStrictEqual((await reader.callers(idA)).data, callers.data);
        assert.deepStrictEqual((await reader.callers(identity('src/a.ts', 'ghost', 'function'))).data, []);
        writer.release();
      });
    });

    it('importers resolves relative specifiers against the importing directory and compares paths without their extension', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const imp = (specifier: string, line: number, style: 'es' | 'cjs' = 'es'): ImportSite => ({
          path: specifier,
          span: span(line, 0, line, 20),
          style,
        });
        const files: Array<[string, number, string, ImportSite[]]> = [
          ['src/lib/util.ts', 10, 'util', []],
          ['src/app/main.ts', 11, 'main', [imp('../lib/util', 0), imp('lodash', 1), imp('../lib/util', 2, 'cjs')]],
          ['src/app/other.ts', 12, 'other', [imp('../lib/util.js', 0)]],
          ['src/lib/sibling.ts', 13, 'sibling', [imp('./util', 3)]],
          ['src/lib/misc.ts', 14, 'misc', [imp('./utility', 0), imp('util', 1), imp('../../node_modules/util', 2), imp('./util/', 3)]],
        ];
        for (const [filePath, n, name, imports] of files) {
          await writer.commitFile({ worktree: 'main', path: filePath, hash: H(n), facts: named(filePath, n, name, { imports }) });
        }
        const reader = fx.store.at('main');

        const found = await reader.importers('src/lib/util.ts');
        assert.deepStrictEqual(
          found.data.map((record) => [record.importer, record.specifier, record.style, record.hops]),
          [
            ['src/app/main.ts', '../lib/util', 'es', 1],
            ['src/app/main.ts', '../lib/util', 'cjs', 1],
            ['src/app/other.ts', '../lib/util.js', 'es', 1],
            ['src/lib/sibling.ts', './util', 'es', 1],
          ],
        );
        const first = found.data[0];
        assert.equal(first?.source_path, 'src/app/main.ts');
        assert.deepStrictEqual(first?.span, span(0, 0, 0, 20));
        for (const record of found.data) assert.equal(record.confidence, 'EXTRACTED', 'each specifier matched exactly one overlay path');
        assert.equal(first?.content_hash, H(11));
        assert.equal(first?.extractor, 'grammar:typescript@0.23.2');
        assert.equal(first?.debug, `imp/src%2Fapp%2Fmain.ts/${H(11)}/0`);

        assert.equal((await reader.importers('src/lib/util.ts', { limit: 2 })).data.length, 2);
        assert.deepStrictEqual((await reader.importers('src/lib/util.ts', { depth: 3 })).data, found.data);
        assert.deepStrictEqual((await reader.importers('src/lib/util')).data, found.data, 'a path without its extension names the same file');
        const none = await reader.importers('src/lib/none.ts');
        assert.deepStrictEqual(none.data, []);
        assert.deepStrictEqual(none.watermark, { seq: 5, stalePaths: [] });
        writer.release();
      });
    });

    it('find in prefix mode returns definitions whose name starts with the query, case-sensitively', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/names.ts', hash: H(20), facts: namesFacts });
        const reader = fx.store.at('main');
        const names = async (query: string, options: FindOptions = {}): Promise<string[]> =>
          (await reader.find(query, { mode: 'prefix', ...options })).data.map((record) => record.identity.qualifiedName);
        assert.deepStrictEqual(await names('getUser'), ['getUserName', 'getUser']);
        assert.deepStrictEqual(await names('get'), ['getUserName', 'getUser']);
        assert.deepStrictEqual(await names('Get'), ['Get']);
        assert.deepStrictEqual(await names('userRef'), [], 'a name used only as a reference is not a definition');
        assert.deepStrictEqual(await names(''), []);
        assert.deepStrictEqual(await names('get', { limit: 1 }), ['getUserName'], 'limit truncates after ordering');
        assert.deepStrictEqual(await names('get', { limit: 0 }), []);
        assert.deepStrictEqual((await reader.find('getUser')).data.map((record) => record.identity.qualifiedName), ['getUser']);
        writer.release();
      });
    });

    it('find in fuzzy mode returns definitions containing the query case-insensitively, and nothing for a query under three characters', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/names.ts', hash: H(20), facts: namesFacts });
        const reader = fx.store.at('main');
        const names = async (query: string, options: FindOptions = {}): Promise<string[]> =>
          (await reader.find(query, { mode: 'fuzzy', ...options })).data.map((record) => record.identity.qualifiedName);
        assert.deepStrictEqual(await names('user'), ['getUserName', 'getUser', 'setUser', 'fetchUser']);
        assert.deepStrictEqual(await names('USERNAME'), ['getUserName']);
        assert.deepStrictEqual(await names('get'), ['getUserName', 'getUser', 'Get']);
        assert.deepStrictEqual(await names('ab'), [], 'under three characters');
        assert.deepStrictEqual(await names('ge'), []);
        assert.deepStrictEqual(await names(''), []);
        assert.deepStrictEqual(await names('user', { limit: 2 }), ['getUserName', 'getUser']);
        writer.release();
      });
    });

    it('callers hops: a chain returns each caller at its own hop, hop 1 equals the one-hop answer, and hops is clamped to 5', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        // main calls load calls parse
        await writer.commitFile({
          worktree: 'main',
          path: 'src/chain.ts',
          hash: H(1),
          facts: fileOf('src/chain.ts', 1, {
            symbols: [definition('main', 1), definition('load', 11), definition('parse', 21)],
            refSites: [
              { name: 'load', span: span(2, 2, 2, 6), kind: 'call', enclosing: 0 },
              { name: 'parse', span: span(12, 2, 12, 7), kind: 'call', enclosing: 1 },
            ],
          }),
        });
        const reader = fx.store.at('main');
        const parse = identity('src/chain.ts', 'parse', 'function');
        const two = await reader.callers(parse, { hops: 2 });
        assert.deepStrictEqual(
          two.data.map((record) => [record.caller.qualifiedName, record.callee.qualifiedName, record.hops, record.span.startLine]),
          [['load', 'parse', 1, 12], ['main', 'load', 2, 2]],
        );
        for (const record of two.data) {
          assert.equal(record.tier, 'grammar');
          assert.equal(record.confidence, 'INFERRED');
        }
        const one = await reader.callers(parse);
        assert.deepStrictEqual(one.data, [two.data[0]], 'hop 1 of a deeper walk equals the one-hop answer');
        assert.deepStrictEqual((await reader.callers(parse, { hops: 1 })).data, one.data);
        assert.deepStrictEqual((await reader.callers(parse, { hops: 0 })).data, one.data, 'fewer than one hop still means one');

        // f0 calls f1 calls ... f6: callers of f6 are f5 at hop 1 down to f1 at hop 5; f0 would be hop 6.
        await writer.commitFile({
          worktree: 'main',
          path: 'src/long.ts',
          hash: H(2),
          facts: fileOf('src/long.ts', 2, {
            symbols: Array.from({ length: 7 }, (_, i) => definition(`f${i}`, 10 * i + 1)),
            refSites: Array.from({ length: 6 }, (_, i) => ({
              name: `f${i + 1}`,
              span: span(10 * i + 2, 2, 10 * i + 2, 4),
              kind: 'call' as const,
              enclosing: i,
            })),
          }),
        });
        const long = await reader.callers(identity('src/long.ts', 'f6', 'function'), { hops: 9 });
        assert.deepStrictEqual(
          long.data.map((record) => [record.caller.qualifiedName, record.hops]),
          [['f5', 1], ['f4', 2], ['f3', 3], ['f2', 4], ['f1', 5]],
        );
        writer.release();
      });
    });

    it('callers cycle: mutual recursion terminates with each caller once, and a self call is a hop-1 caller', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({
          worktree: 'main',
          path: 'src/cycle.ts',
          hash: H(1),
          facts: fileOf('src/cycle.ts', 1, {
            symbols: [definition('a', 1), definition('b', 11), definition('s', 21)],
            refSites: [
              { name: 'b', span: span(2, 2, 2, 3), kind: 'call', enclosing: 0 },
              { name: 'a', span: span(12, 2, 12, 3), kind: 'call', enclosing: 1 },
              { name: 's', span: span(22, 2, 22, 3), kind: 'call', enclosing: 2 },
            ],
          }),
        });
        const reader = fx.store.at('main');
        const a = await reader.callers(identity('src/cycle.ts', 'a', 'function'), { hops: 4 });
        assert.deepStrictEqual(a.data.map((record) => [record.caller.qualifiedName, record.hops]), [['b', 1]]);
        const s = await reader.callers(identity('src/cycle.ts', 's', 'function'), { hops: 4 });
        assert.deepStrictEqual(s.data.map((record) => [record.caller.qualifiedName, record.hops]), [['s', 1]]);
        writer.release();
      });
    });

    it('callers hops are ordered by hop, then caller path, then span, across files', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({
          worktree: 'main',
          path: 'src/x.ts',
          hash: H(1),
          facts: fileOf('src/x.ts', 1, {
            symbols: [definition('t', 1, { exported: true }), definition('p', 11), definition('q', 21), definition('top', 31)],
            exports: [{ name: 't', span: span(1, 0, 3, 1) }],
            refSites: [
              { name: 't', span: span(22, 2, 22, 3), kind: 'call', enclosing: 2 },
              { name: 'q', span: span(32, 2, 32, 3), kind: 'call', enclosing: 3 },
              { name: 't', span: span(12, 2, 12, 3), kind: 'call', enclosing: 1 },
            ],
          }),
        });
        await writer.commitFile({
          worktree: 'main',
          path: 'src/y.ts',
          hash: H(2),
          facts: fileOf('src/y.ts', 2, {
            symbols: [definition('r', 1)],
            imports: [importOf('./x', 0, ['t', 't'])],
            refSites: [{ name: 't', span: span(2, 2, 2, 3), kind: 'call', enclosing: 0, importPath: './x' }],
          }),
        });
        const reader = fx.store.at('main');
        const walked = await reader.callers(identity('src/x.ts', 't', 'function'), { hops: 2 });
        assert.deepStrictEqual(
          walked.data.map((record) => [record.hops, record.caller.qualifiedName, record.callee.qualifiedName]),
          [[1, 'p', 't'], [1, 'q', 't'], [1, 'r', 't'], [2, 'top', 'q']],
        );
        writer.release();
      });
    });

    it('importers depth: a chain returns each importer at its own hop with per-edge confidence, a cycle terminates, and depth is clamped to 5', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const commit = async (filePath: string, n: number, imports: ImportSite[]): Promise<void> => {
          await writer.commitFile({ worktree: 'main', path: filePath, hash: H(n), facts: fileOf(filePath, n, { symbols: [definition('x')], imports }) });
        };
        await commit('src/a.ts', 1, []);
        await commit('src/b.ts', 2, [importOf('./a', 0)]);
        await commit('src/c.ts', 3, [importOf('./b', 0)]);
        const reader = fx.store.at('main');
        const two = await reader.importers('src/a.ts', { depth: 2 });
        assert.deepStrictEqual(
          two.data.map((record) => [record.importer, record.hops, record.confidence]),
          [['src/b.ts', 1, 'EXTRACTED'], ['src/c.ts', 2, 'EXTRACTED']],
        );
        assert.deepStrictEqual((await reader.importers('src/a.ts')).data, [two.data[0]], 'depth 1 is the default');
        assert.deepStrictEqual((await reader.importers('src/a.ts', { depth: 2, limit: 1 })).data, [two.data[0]], 'limit truncates after ordering');

        // p imports q and q imports p
        await commit('src/p.ts', 4, [importOf('./q', 0)]);
        await commit('src/q.ts', 5, [importOf('./p', 0)]);
        const cycle = await reader.importers('src/p.ts', { depth: 4 });
        assert.deepStrictEqual(cycle.data.map((record) => [record.importer, record.hops]), [['src/q.ts', 1]]);

        // l1 imports l0, l2 imports l1, ... l6 imports l5
        await commit('src/l0.ts', 10, []);
        for (let i = 1; i <= 6; i += 1) await commit(`src/l${i}.ts`, 10 + i, [importOf(`./l${i - 1}`, 0)]);
        const long = await reader.importers('src/l0.ts', { depth: 9 });
        assert.deepStrictEqual(
          long.data.map((record) => [record.importer, record.hops]),
          [['src/l1.ts', 1], ['src/l2.ts', 2], ['src/l3.ts', 3], ['src/l4.ts', 4], ['src/l5.ts', 5]],
        );
        writer.release();
      });
    });

    it('importers depth: a specifier that matches two files is INFERRED and the importer appears for each candidate target', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const commit = async (filePath: string, n: number, imports: ImportSite[]): Promise<void> => {
          await writer.commitFile({ worktree: 'main', path: filePath, hash: H(n), facts: fileOf(filePath, n, { symbols: [definition('x')], imports }) });
        };
        await commit('src/foo.cts', 1, []);
        await commit('src/foo.cjs', 2, []);
        await commit('src/user.cjs', 3, [importOf('./foo.cjs', 0)]);
        const reader = fx.store.at('main');
        for (const target of ['src/foo.cts', 'src/foo.cjs']) {
          const found = await reader.importers(target);
          assert.deepStrictEqual(found.data.map((record) => [record.importer, record.confidence]), [['src/user.cjs', 'INFERRED']], target);
        }
        writer.release();
      });
    });

    it('find fuzzy uses the trigram table: it matches substrings case-insensitively, answers nothing under three characters, and is filled once per interned name', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const configFacts = (filePath: string, n: number, symbolNames: string[]): FileFacts =>
          fileOf(filePath, n, { symbols: symbolNames.map((name, i) => definition(name, 1 + 2 * i)) });
        await writer.commitFile({
          worktree: 'main',
          path: 'src/config.ts',
          hash: H(1),
          facts: configFacts('src/config.ts', 1, ['getConfig', 'loadConfigFile', 'CONFIGURE', 'settings']),
        });
        const peek = await fx.peek();
        const fuzzy = async (query: string): Promise<string[]> =>
          (await fx.store.at('main').find(query, { mode: 'fuzzy' })).data.map((record) => record.identity.qualifiedName);
        assert.equal(peek.prepare("SELECT value FROM meta WHERE name = 'fuzzy_path'").get()?.value, 'trigram');
        assert.deepStrictEqual(await fuzzy('onfig'), ['getConfig', 'loadConfigFile', 'CONFIGURE']);
        assert.deepStrictEqual(await fuzzy('ONFIG'), ['getConfig', 'loadConfigFile', 'CONFIGURE']);
        assert.deepStrictEqual(await fuzzy('on'), [], 'under three characters nothing is answered');
        assert.deepStrictEqual(await fuzzy('nothing-like-it'), []);

        const ftsRows = (): number => Number(peek.prepare('SELECT count(*) AS n FROM names_fts').get()?.n);
        const nameRows = (): number => Number(peek.prepare('SELECT count(*) AS n FROM names').get()?.n);
        assert.equal(ftsRows(), nameRows(), 'one trigram row per interned name');
        const before = ftsRows();
        // The same facts again, then another file that reuses the names: no name is interned twice.
        await writer.commitFile({ worktree: 'main', path: 'src/config.ts', hash: H(1), facts: configFacts('src/config.ts', 1, ['getConfig', 'loadConfigFile', 'CONFIGURE', 'settings']) });
        await writer.commitFile({ worktree: 'main', path: 'src/copy.ts', hash: H(2), facts: configFacts('src/copy.ts', 2, ['getConfig', 'settings']) });
        assert.equal(ftsRows(), before);
        await writer.commitFile({ worktree: 'main', path: 'src/more.ts', hash: H(3), facts: configFacts('src/more.ts', 3, ['getConfig', 'brandNewName']) });
        assert.equal(ftsRows(), before + 1);
        assert.equal(ftsRows(), nameRows());
        assert.deepStrictEqual(await fuzzy('andnew'), ['brandNewName']);
        writer.release();
      });
    });

    it('find fuzzy treats FTS5 operators in the query as data, never as syntax', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({
          worktree: 'main',
          path: 'src/config.ts',
          hash: H(1),
          facts: fileOf('src/config.ts', 1, { symbols: [definition('getConfig', 1), definition('x', 5)] }),
        });
        const reader = fx.store.at('main');
        for (const query of ['"', 'onfig" OR "x', 'onfig*', 'NEAR(onfig onfig)', 'name:onfig', 'onfig AND x', '^onfig', '"" OR ""', "onfig'", 'onfig)']) {
          assert.deepStrictEqual((await reader.find(query, { mode: 'fuzzy' })).data, [], query);
        }
        assert.equal((await reader.find('onfig', { mode: 'fuzzy' })).data.length, 1);
        writer.release();
      });
    });

    it('find fuzzy capability: the trigram table drives the answer when the capability is on, the LIKE scan returns the same rows when it is forced off, and switching back repairs the table', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.commitFile({
          worktree: 'main',
          path: 'src/config.ts',
          hash: H(1),
          facts: fileOf('src/config.ts', 1, {
            symbols: [definition('getConfig', 1), definition('loadConfigFile', 5), definition('CONFIGURE', 9)],
          }),
        });
        writer.release();
        const fuzzy = async (): Promise<string[]> =>
          (await fx.store.at('main').find('onfig', { mode: 'fuzzy' })).data.map((record) => record.identity.qualifiedName);
        const all = ['getConfig', 'loadConfigFile', 'CONFIGURE'];
        assert.deepStrictEqual(await fuzzy(), all);

        // Remove one name from the trigram table behind the store's back: only the trigram path can notice.
        const capabilities = selfTest(await loadDriver(driver));
        if (capabilities.contentlessDelete) {
          const tamper = await fx.tamper();
          const id = tamper.prepare('SELECT id FROM names WHERE name = ?').get('loadConfigFile')?.id;
          tamper.prepare('DELETE FROM names_fts WHERE rowid = ?').run(id ?? null);
          assert.deepStrictEqual(await fuzzy(), ['getConfig', 'CONFIGURE'], 'the answer follows the trigram table');
        }

        // Forced off: the bounded LIKE scan over names finds every row, and the store records which path is active.
        await fx.reopen({ trigram: false });
        assert.deepStrictEqual(await fuzzy(), all);
        const peek = await fx.peek();
        assert.equal(peek.prepare("SELECT value FROM meta WHERE name = 'fuzzy_path'").get()?.value, 'like');

        // Back on: the table is rebuilt from the interned names, so the answer is complete again.
        await fx.reopen({});
        assert.equal(peek.prepare("SELECT value FROM meta WHERE name = 'fuzzy_path'").get()?.value, 'trigram');
        assert.deepStrictEqual(await fuzzy(), all);
        assert.equal(
          Number(peek.prepare('SELECT count(*) AS n FROM names_fts').get()?.n),
          Number(peek.prepare('SELECT count(*) AS n FROM names').get()?.n),
        );
      });
    });

    it('find bounds prefix and fuzzy results at 50 unless a limit is given, and treats query text as data, never as SQL', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        const many = Array.from({ length: 60 }, (_, i) => ({ name: `item${i}`, kind: 'function', span: span(i, 0, i, 5) }));
        await writer.commitFile({ worktree: 'main', path: 'src/many.ts', hash: H(21), facts: named('src/many.ts', 21, 'x', { symbols: many }) });
        const peek = await fx.peek();
        const before = counts(peek);
        const reader = fx.store.at('main');
        assert.equal((await reader.find('item', { mode: 'fuzzy' })).data.length, 50);
        assert.equal((await reader.find('item', { mode: 'prefix' })).data.length, 50);
        assert.equal((await reader.find('item', { mode: 'fuzzy', limit: 55 })).data.length, 55);
        assert.equal((await reader.find('item', { mode: 'prefix', limit: 200 })).data.length, 60);

        for (const mode of ['exact', 'prefix', 'fuzzy'] as const) {
          for (const query of ["'; DROP TABLE names; --", '%', '_', 'item1%', "x' OR '1'='1"]) {
            assert.deepStrictEqual((await reader.find(query, { mode })).data, [], `${mode} ${query}`);
          }
        }
        assert.deepStrictEqual(counts(peek), before);
        assert.equal((await reader.find('item7')).data.length, 1);
        writer.release();
      });
    });

    it('refs resolver: a precise edge supersedes the grammar candidate at its site, removes the site from other targets, and leaves unmentioned sites INFERRED', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const reader = fx.store.at('main');

          const cjs = await reader.refs(RUN_CJS);
          assert.equal(cjs.degraded, undefined);
          assert.deepStrictEqual(
            cjs.data.map((record) => [record.span.startLine, record.tier, record.confidence, record.candidates]),
            [[3, 'precise', 'EXTRACTED', undefined], [6, 'grammar', 'INFERRED', 2]],
          );
          assert.equal(cjs.data[0]?.extractor, 'precise:scripted');
          assert.deepStrictEqual(cjs.data[0]?.target, RUN_CJS);
          assert.deepStrictEqual(cjs.data[0]?.site, SITE_1);
          assert.match(cjs.data[0]?.debug ?? '', /^ref\/src%2Fc\.cjs\//, 'a precise record keeps the site debug handle');

          const cts = await reader.refs(RUN_CTS);
          assert.deepStrictEqual(
            cts.data.map((record) => [record.span.startLine, record.tier, record.confidence, record.candidates]),
            [[6, 'grammar', 'INFERRED', 2]],
            'the site the resolver bound to foo.cjs is gone from foo.cts',
          );
          writer.release();
        },
        {},
        scripted([{ site: SITE_1, target: RUN_CJS }], calls),
      );
    });

    it('refs snapshot: the first call writes edges keyed by the overlay snapshot id and context, the second reads them without the resolver, a content change misses', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const peek = await fx.peek();
          const reader = fx.store.at('main');
          const rows = (): number => Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n);

          const first = await reader.refs(RUN_CJS);
          assert.equal(calls.count, 1);
          assert.equal(rows(), 2);
          const expected = overlaySnapshotId(
            new Map([['src/c.cjs', H(3)], ['src/foo.cjs', H(2)], ['src/foo.cts', H(1)]]),
          );
          const stored = peek
            .prepare(
              'SELECT snapshot, context_id, site_path, start_line, name, target_path, target_kind, resolver FROM resolved_edges ORDER BY start_line',
            )
            .get();
          assert.equal(stored?.snapshot, expected, 'the key is the hash of the sorted (path, hash) pairs');
          assert.equal(stored?.site_path, 'src/c.cjs');
          assert.equal(stored?.start_line, 3);
          assert.equal(stored?.target_path, 'src/foo.cjs');
          assert.equal(stored?.resolver, 'scripted');
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolution_contexts').get()?.n), 1);

          const second = await reader.refs(RUN_CJS);
          assert.equal(calls.count, 1, 'the second call on an unchanged overlay does not invoke the resolver');
          assert.deepStrictEqual(second.data, first.data);

          await writer.commitFile({ worktree: 'main', path: 'src/extra.ts', hash: H(9), facts: named('src/extra.ts', 9, 'extra') });
          const third = await reader.refs(RUN_CJS);
          assert.equal(calls.count, 2, 'a content change changes the snapshot id, so the cache misses');
          assert.deepStrictEqual(third.data, first.data);
          const snapshots = peek.prepare('SELECT DISTINCT snapshot FROM resolved_edges').all();
          assert.equal(snapshots.length, 1, 'edges of the superseded snapshot are dropped');
          assert.notEqual(snapshots[0]?.snapshot, expected);
          writer.release();
        },
        {},
        scripted(BOTH_SITES, calls),
      );
    });

    it('[edge STO-04/adjacency] refs context: two overlays with identical contents and the same context share one cache slot, and another context gets its own', async () => {
      const calls: Calls = { count: 0 };
      let contextId = 'ctx-a';
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer, 'wt-a');
          await seedAmbiguous(writer, 'wt-b');
          const peek = await fx.peek();
          const rows = (): number => Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n);

          const inA = await fx.store.at('wt-a').refs(RUN_CJS);
          const inB = await fx.store.at('wt-b').refs(RUN_CJS);
          assert.equal(calls.count, 1, 'identical contents and context: the second overlay reads the first overlay\'s rows');
          assert.equal(rows(), 2);
          assert.deepStrictEqual(inA.data, inB.data);

          contextId = 'ctx-b';
          const other = await fx.store.at('wt-a').refs(RUN_CJS);
          assert.equal(calls.count, 2, 'the same overlay under another resolution context misses');
          assert.equal(rows(), 4);
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolution_contexts').get()?.n), 2);
          assert.deepStrictEqual(other.data, inA.data);
          writer.release();
        },
        { resolutionContext: () => ({ id: contextId, configHashes: ['h2', 'h1'] }) },
        scripted(BOTH_SITES, calls),
      );
    });

    it('[edge STO-04/empty] refs resolver: a resolver that yields nothing leaves refs equal to the grammar result, with no degraded code and no cache rows', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await seedAmbiguous(writer);
        const peek = await fx.peek();
        const refs = await fx.store.at('main').refs(RUN_CJS);
        assert.equal(refs.degraded, undefined);
        assert.deepStrictEqual(
          refs.data.map((record) => [record.span.startLine, record.tier, record.confidence, record.candidates]),
          [[3, 'grammar', 'INFERRED', 2], [6, 'grammar', 'INFERRED', 2]],
        );
        assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n), 0);
        writer.release();
      });
    });

    it('[edge STO-04/ordering] refs resolver: results are ordered by path then start line and column, the same on a cache miss and a cache hit', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          // a second importer in a file that sorts before c.cjs, whose site the resolver binds too
          await writer.commitFile({
            worktree: 'main',
            path: 'src/a.cjs',
            hash: H(4),
            facts: fileOf('src/a.cjs', 4, {
              symbols: [definition('start', 1)],
              imports: [importOf('./foo.cjs', 0, ['run', 'run'])],
              refSites: [{ name: 'run', span: span(2, 4, 2, 7), kind: 'call', enclosing: 0, importPath: './foo.cjs' }],
            }),
          });
          const reader = fx.store.at('main');
          const miss = await reader.refs(RUN_CJS);
          const hit = await reader.refs(RUN_CJS);
          assert.ok(calls.count >= 1);
          assert.deepStrictEqual(
            miss.data.map((record) => [record.source_path, record.span.startLine, record.span.startColumn, record.tier]),
            [['src/a.cjs', 2, 4, 'precise'], ['src/c.cjs', 3, 2, 'precise'], ['src/c.cjs', 6, 2, 'grammar']],
          );
          assert.deepStrictEqual(hit.data, miss.data);
          writer.release();
        },
        {},
        scripted(
          [
            { site: SITE_1, target: RUN_CJS },
            { site: { path: 'src/a.cjs', span: span(2, 4, 2, 7), name: 'run' }, target: RUN_CJS },
          ],
          calls,
        ),
      );
    });

    it('refs resolver_timeout: a slow resolver gives grammar edges and the degraded code while it finishes in the background and fills the cache', async () => {
      const calls: Calls = { count: 0 };
      const door = deferred();
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const peek = await fx.peek();
          const reader = fx.store.at('main');
          const pending = reader.refs(RUN_CJS, { timeoutMs: 50 });
          await fx.clock.advance(50);
          const slow = await pending;
          assert.deepStrictEqual(slow.degraded, ['resolver_timeout']);
          assert.deepStrictEqual(
            slow.data.map((record) => [record.span.startLine, record.tier, record.confidence]),
            [[3, 'grammar', 'INFERRED'], [6, 'grammar', 'INFERRED']],
          );
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n), 0);

          door.open();
          await until(() => Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n) === 2, 'the background fill');
          const warm = await reader.refs(RUN_CJS, { timeoutMs: 50 });
          assert.equal(warm.degraded, undefined);
          assert.deepStrictEqual(warm.data.map((record) => record.tier), ['precise', 'precise']);
          assert.equal(calls.count, 1, 'the later call is served from the cache the background run filled');
          writer.release();
        },
        {},
        gated(BOTH_SITES, calls, door.promise),
      );
    });

    it('refs resolver_failed: a resolver that throws, while iterating or on the call, gives the grammar edges and the degraded code, never an error', async () => {
      const calls: Calls = { count: 0 };
      const failures: Array<[string, Resolver]> = [
        [
          'iterating',
          async function* () {
            calls.count += 1;
            throw new Error('resolver exploded while iterating');
          },
        ],
        [
          'on the call',
          () => {
            calls.count += 1;
            throw new Error('resolver exploded on the call');
          },
        ],
      ];
      for (const [label, resolver] of failures) {
        await withStore(
          driver,
          async (fx) => {
            const writer = fx.store.writer();
            await seedAmbiguous(writer);
            const peek = await fx.peek();
            const refs = await fx.store.at('main').refs(RUN_CJS);
            assert.deepStrictEqual(refs.degraded, ['resolver_failed'], label);
            assert.deepStrictEqual(
              refs.data.map((record) => [record.span.startLine, record.tier, record.confidence]),
              [[3, 'grammar', 'INFERRED'], [6, 'grammar', 'INFERRED']],
              label,
            );
            assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n), 0, label);
            writer.release();
          },
          {},
          resolver,
        );
      }
      assert.equal(calls.count, 2);
    });

    it('refs cache_unavailable: a process that may not write the cache computes and returns precise edges, writes nothing and says so', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const peek = await fx.peek();
          const refs = await fx.store.at('main').refs(RUN_CJS);
          assert.deepStrictEqual(refs.degraded, ['cache_unavailable']);
          assert.deepStrictEqual(refs.data.map((record) => record.tier), ['precise', 'grammar']);
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n), 0);
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolution_contexts').get()?.n), 0);
          await fx.store.at('main').refs(RUN_CJS);
          assert.equal(calls.count, 2, 'nothing was cached, so the next call computes again');
          writer.release();
        },
        { canCache: () => false },
        scripted([{ site: SITE_1, target: RUN_CJS }], calls),
      );
    });

    it('[edge STO-04/concurrency] refs resolver: two simultaneous calls that both miss the cache return the same edges and the cache holds each edge once', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const peek = await fx.peek();
          const reader = fx.store.at('main');
          const [one, two] = await Promise.all([reader.refs(RUN_CJS), reader.refs(RUN_CJS)]);
          assert.deepStrictEqual(one.data, two.data);
          assert.deepStrictEqual(one.data.map((record) => record.tier), ['precise', 'grammar']);
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n), 1);
          writer.release();
        },
        {},
        scripted([{ site: SITE_1, target: RUN_CJS }], calls),
      );
    });

    it('refs resolver: edges for sites that were not asked about or for targets the overlay does not hold are dropped and never cached', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const peek = await fx.peek();
          const reader = fx.store.at('main');
          const refs = await reader.refs(RUN_CJS);
          assert.deepStrictEqual(
            refs.data.map((record) => [record.span.startLine, record.tier]),
            [[3, 'grammar'], [6, 'precise']],
            'only the valid edge for site 2 applies',
          );
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_edges').get()?.n), 1);
          const cts = await reader.refs(RUN_CTS);
          assert.deepStrictEqual(cts.data.map((record) => record.span.startLine), [3], 'site 2 now belongs to foo.cjs');
          writer.release();
        },
        {},
        scripted(
          [
            { site: SITE_1, target: identity('src/ghost.ts', 'run', 'function') },
            { site: { path: 'src/c.cjs', span: span(90, 0, 90, 3), name: 'run' }, target: RUN_CJS },
            { site: SITE_2, target: RUN_CJS },
          ],
          calls,
        ),
      );
    });

    it('refs negative marker: asking twice calls the resolver once for each distinct site, including the site that has no edge', async () => {
      const askedSites: number[] = [];
      const inner = createScriptedResolver({ id: 'scripted', edges: [{ site: SITE_1, target: RUN_CJS }] });
      const counting: Resolver = (sites, context) => {
        for (const site of sites) askedSites.push(site.span.startLine);
        return inner.resolve({ id: 'overlay', pathToHash: new Map() }, context, sites);
      };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const peek = await fx.peek();
          const reader = fx.store.at('main');
          const first = await reader.refs(RUN_CJS);
          assert.deepStrictEqual(askedSites.sort(), [3, 6], 'both call sites are asked on the first read');
          assert.equal(Number(peek.prepare('SELECT count(*) AS n FROM resolved_asked').get()?.n), 2);
          const second = await reader.refs(RUN_CJS);
          assert.deepStrictEqual(second.data, first.data);
          assert.deepStrictEqual(askedSites.sort(), [3, 6], 'the second read asks about nothing: the site with no edge is settled too');
          writer.release();
        },
        {},
        counting,
      );
    });

    it('callers resolver: precise edges mark the callers they bind and a caller reached only through a removed edge disappears with its own callers', async () => {
      const calls: Calls = { count: 0 };
      await withStore(
        driver,
        async (fx) => {
          const writer = fx.store.writer();
          await seedAmbiguous(writer);
          const reader = fx.store.at('main');
          const cjs = await reader.callers(RUN_CJS, { hops: 2 });
          assert.deepStrictEqual(
            cjs.data.map((record) => [record.hops, record.caller.qualifiedName, record.callee.qualifiedName, record.tier, record.confidence]),
            [[1, 'main', 'run', 'precise', 'EXTRACTED'], [1, 'main', 'run', 'precise', 'EXTRACTED'], [2, 'top', 'main', 'grammar', 'INFERRED']],
          );
          const cts = await reader.callers(RUN_CTS, { hops: 2 });
          assert.deepStrictEqual(cts.data, [], 'both sites bind to foo.cjs, so foo.cts has no callers and top is not reached');
          writer.release();
        },
        {},
        scripted(
          [
            { site: SITE_1, target: RUN_CJS },
            { site: SITE_2, target: RUN_CJS },
          ],
          calls,
        ),
      );
    });

    it('[edge STO-03/empty] an overlay with no files returns empty data for refs, callers and importers with the watermark and no error', async () => {
      await withStore(driver, async (fx) => {
        const writer = fx.store.writer();
        await writer.setOverlay('empty', 'refs/heads/e', new Map());
        const reader = fx.store.at('empty');
        const id = identity('src/a.ts', 'x', 'function');
        for (const answer of [await reader.refs(id), await reader.callers(id, { hops: 3 }), await reader.importers('src/a.ts', { depth: 3 })]) {
          assert.deepStrictEqual(answer.data, []);
          assert.deepStrictEqual(answer.watermark, { seq: 1, stalePaths: [] });
          assert.equal(answer.degraded, undefined);
        }
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
          { worktree: 'alpha', seq: 1, stalePaths: 1, files: 1 },
          { worktree: 'zeta', seq: 1, stalePaths: 0, files: 1 },
        ]);
        writer.release();
      });
    });
  });
}
