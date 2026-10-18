import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { FileFacts, Span } from '../facts/index.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { defineFactStoreContract } from './contract.ts';
import { UnknownWorktree } from './errors.ts';
import { openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import { SCHEMA_VERSION, STORE_FILE_NAME } from './schema.ts';
import type { FactStore, Resolver, StoreDeps } from './types.ts';

defineFactStoreContract('node:sqlite', 'node:sqlite');
defineFactStoreContract('better-sqlite3', 'better-sqlite3');

// ---------------------------------------------------------------------------------------------
// ADR citations stored as local facts (plan 03-24, D-19; schema version 2)

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number): Span => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

const H = (n: number): string => n.toString(16).padStart(40, '0');

/** One exported function `load` and three citations: file level, attached to `load`, and one with no detail. */
function citedFacts(filePath: string, hash: string): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: [{ name: 'load', kind: 'function', qualifiedName: 'load', span: span(5, 7, 10, 1), exported: true }],
    refSites: [],
    imports: [],
    exports: [],
    citations: [
      { number: 2143, detail: '§3', span: span(0, 20, 0, 31) },
      { number: 3473, span: span(3, 23, 3, 32), enclosing: 0 },
      { number: 8, span: span(13, 13, 13, 18) },
    ],
    parse: { errorBytes: 0, totalBytes: 200 },
  };
}

interface Rig {
  readonly file: string;
  open(extra?: Partial<StoreOpenOptions>): Promise<FactStore>;
  /** The first column `n` of `sql`, read through a second, read-only connection. */
  count(sql: string): Promise<number>;
}

async function withRig(driver: DriverName, run: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const file = path.join(dir, STORE_FILE_NAME);
  const opened: FactStore[] = [];
  const rig: Rig = {
    file,
    async open(extra = {}) {
      const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async () => true };
      const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9', ...extra });
      opened.push(store);
      return store;
    },
    async count(sql) {
      const db = await openDatabase(file, { readOnly: true, driver });
      try {
        return Number(db.prepare(sql).get()?.n);
      } finally {
        db.close();
      }
    },
  };
  try {
    await run(rig);
  } finally {
    for (const store of opened) await store.close();
    tmp.cleanup();
  }
}

for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
  describe(`citations in the fact store (${driver})`, () => {
    it('the store schema version is 2, the single bump of Phase 3', () => {
      assert.equal(SCHEMA_VERSION, 2);
    });

    it('citations round trip: committed in the file transaction and rebuilt by fileFacts, with find unaffected', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const facts = citedFacts('src/a.ts', H(1));
        const committed = await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts });
        assert.equal(committed.status, 'committed');
        const reader = store.at('main');
        assert.deepStrictEqual((await reader.fileFacts('src/a.ts')).data, facts);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citations'), 3);
        const found = await reader.find('load');
        assert.equal(found.data.length, 1);
        assert.equal(found.data[0]?.identity.qualifiedName, 'load');
        writer.release();
      });
    });

    it('a file without citations reads back without the field, as a Phase 2 value', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const { citations: _omitted, ...plain } = citedFacts('src/p.ts', H(2));
        void _omitted;
        await writer.commitFile({ worktree: 'main', path: 'src/p.ts', hash: H(2), facts: plain });
        const read = (await store.at('main').fileFacts('src/p.ts')).data;
        assert.deepStrictEqual(read, plain);
        assert.equal(read !== null && 'citations' in read, false);
        writer.release();
      });
    });

    it('identical bytes at two paths each return the citations, stored once', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        await writer.commitFile({ worktree: 'main', path: 'lib/b.ts', hash: H(1), facts: citedFacts('lib/b.ts', H(1)) });
        const reader = store.at('main');
        assert.deepStrictEqual((await reader.fileFacts('src/a.ts')).data, citedFacts('src/a.ts', H(1)));
        assert.deepStrictEqual((await reader.fileFacts('lib/b.ts')).data, citedFacts('lib/b.ts', H(1)));
        assert.equal(await rig.count('SELECT count(*) AS n FROM citations'), 3, 'one file version, three rows');
        writer.release();
      });
    });

    it('deleting the file removes the rows: the path goes at once and a later collect removes them with the version', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: null });
        assert.equal((await store.at('main').fileFacts('src/a.ts')).data, null);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citations'), 3, 'the retired version still waits for collection');
        const collected = await store.collect({ budgetMs: 1000 });
        assert.equal(collected.processed, 1);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citations'), 0);
        writer.release();
      });
    });

    it('a changed file replaces its citations with the new version', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        const next: FileFacts = { ...citedFacts('src/a.ts', H(2)), citations: [{ number: 9, span: span(1, 3, 1, 8) }] };
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(2), facts: next });
        assert.deepStrictEqual((await store.at('main').fileFacts('src/a.ts')).data, next);
        writer.release();
      });
    });

    it('a commit with an invalid citation is rejected and changes nothing', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const bad = { ...citedFacts('src/a.ts', H(1)), citations: [{ number: 0, span: span(0, 0, 0, 5) }] };
        const result = await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: bad });
        assert.equal(result.status, 'rejected');
        assert.equal(await rig.count('SELECT count(*) AS n FROM citations'), 0);
        writer.release();
      });
    });

    it('Reader.citations by number: ordered by path, line and column, with provenance, the cit handle and the enclosing identity', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        // The same bytes at a second path, and another file that cites 3473 too, to prove the order is by path.
        await writer.commitFile({ worktree: 'main', path: 'lib/b.ts', hash: H(1), facts: citedFacts('lib/b.ts', H(1)) });
        const extra: FileFacts = { ...citedFacts('app/c.ts', H(3)), citations: [{ number: 3473, detail: '§1.2', span: span(7, 4, 7, 20) }] };
        await writer.commitFile({ worktree: 'main', path: 'app/c.ts', hash: H(3), facts: extra });

        const answer = await store.at('main').citations({ number: 3473 });
        assert.deepStrictEqual(
          answer.data.map((record) => [record.source_path, record.span.startLine, record.span.startColumn]),
          [
            ['app/c.ts', 7, 4],
            ['lib/b.ts', 3, 23],
            ['src/a.ts', 3, 23],
          ],
        );
        const [first, second] = answer.data;
        assert.ok(first !== undefined && second !== undefined);
        assert.equal(first.number, 3473);
        assert.equal(first.detail, '§1.2');
        assert.equal(first.enclosing, null, 'a file-level mention has no enclosing symbol');
        assert.equal(first.confidence, 'EXTRACTED');
        assert.equal(first.extractor, 'grammar:typescript@0.23.2');
        assert.equal(first.content_hash, H(3));
        assert.equal(first.debug, `cit/${encodeURIComponent('app/c.ts')}/${H(3)}/0`);
        assert.equal(second.detail, undefined);
        assert.deepStrictEqual(second.enclosing, { repo: 'repo', path: 'lib/b.ts', qualifiedName: 'load', kind: 'function' });
        assert.equal(second.debug, `cit/${encodeURIComponent('lib/b.ts')}/${H(1)}/1`, 'the handle names the overlay path, not the first path that stored the bytes');
        assert.equal(answer.watermark.stalePaths.length, 0);
        writer.release();
      });
    });

    it('Reader.citations by symbol: the citations attached to that definition, and none for another or an unknown one', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        const reader = store.at('main');
        const load = { repo: 'repo', path: 'src/a.ts', qualifiedName: 'load', kind: 'function' };
        const attached = await reader.citations({ symbol: load });
        assert.deepStrictEqual(attached.data.map((record) => record.number), [3473]);
        assert.deepStrictEqual(attached.data[0]?.enclosing, load);
        assert.deepStrictEqual((await reader.citations({ symbol: { ...load, qualifiedName: 'other' } })).data, []);
        assert.deepStrictEqual((await reader.citations({ symbol: { ...load, path: 'src/none.ts' } })).data, []);
        assert.deepStrictEqual((await reader.citations({ number: 999 })).data, []);
        assert.deepStrictEqual((await reader.citations({})).data, [], 'a query that names neither a number nor a symbol asks for nothing');
        writer.release();
      });
    });

    it('Reader.citations limit: the first rows in order, and an unknown worktree is UnknownWorktree', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const many: FileFacts = {
          ...citedFacts('src/m.ts', H(4)),
          citations: [1, 2, 3, 4].map((line) => ({ number: 5, span: span(line, 0, line, 5) })),
        };
        await writer.commitFile({ worktree: 'main', path: 'src/m.ts', hash: H(4), facts: many });
        const cut = await store.at('main').citations({ number: 5 }, { limit: 2 });
        assert.deepStrictEqual(cut.data.map((record) => record.span.startLine), [1, 2]);
        await assert.rejects(store.at('nowhere').citations({ number: 5 }), UnknownWorktree);
        writer.release();
      });
    });

    it('version 1 store is recreated: the derived data of the old schema is dropped, reported as not built, and the new store works', async () => {
      await withRig(driver, async (rig) => {
        const old = await rig.open({ schemaVersion: SCHEMA_VERSION - 1 });
        const writer = old.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        writer.release();
        assert.equal((await old.status()).schemaVersion, SCHEMA_VERSION - 1);
        await old.close();

        const fresh = await rig.open();
        const status = await fresh.status();
        assert.equal(status.schemaVersion, SCHEMA_VERSION);
        assert.deepStrictEqual(status.worktrees, []);
        assert.equal(await rig.count('SELECT count(*) AS n FROM files'), 0, 'the old rows are gone');
        await assert.rejects(fresh.at('main').fileFacts('src/a.ts'), UnknownWorktree);

        const again = fresh.writer();
        const facts = citedFacts('src/a.ts', H(1));
        await again.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts });
        assert.deepStrictEqual((await fresh.at('main').fileFacts('src/a.ts')).data, facts);
        again.release();
      });
    });
  });
}
