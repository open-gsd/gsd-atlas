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

/** The facts of {@link citedFacts} with a citation gap recorded on them. */
function gapped(filePath: string, hash: string, citationGaps: NonNullable<FileFacts['citationGaps']>): FileFacts {
  return { ...citedFacts(filePath, hash), citationGaps };
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

    it('cit handle: provenance explains a citation from the grammar tier with no resolution, a changed file is stale and an unknown ordinal is null', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        const reader = store.at('main');
        const handles = (await reader.citations({ number: 2143 })).data.map((record) => record.debug);
        assert.equal(handles.length, 1);
        const explained = (await reader.provenance(handles[0] as string)).data;
        assert.ok(explained !== null && explained !== 'stale');
        assert.equal(explained.kind, 'citation');
        assert.equal(explained.handle, handles[0]);
        assert.deepStrictEqual(
          { extractor: explained.fact.extractor, tier: explained.fact.tier, confidence: explained.fact.confidence, path: explained.fact.path, contentHash: explained.fact.contentHash, span: explained.fact.span },
          { extractor: 'grammar:typescript@0.23.2', tier: 'grammar', confidence: 'EXTRACTED', path: 'src/a.ts', contentHash: H(1), span: span(0, 20, 0, 31) },
        );
        assert.equal(explained.resolution, null);
        assert.deepStrictEqual(explained.citation, { number: 2143, detail: '§3' });
        const plain = (await reader.provenance(`cit/${encodeURIComponent('src/a.ts')}/${H(1)}/1`)).data;
        assert.ok(plain !== null && plain !== 'stale');
        assert.deepStrictEqual(plain.citation, { number: 3473 });

        assert.equal((await reader.provenance(`cit/${encodeURIComponent('src/a.ts')}/${H(1)}/3`)).data, null, 'the file has three citations: ordinal 3 is none');
        assert.equal((await reader.provenance(`cit/${encodeURIComponent('src/none.ts')}/${H(1)}/0`)).data, null);
        assert.equal((await reader.provenance(`cit/${encodeURIComponent('src/a.ts')}/${H(1)}/00`)).data, null, 'a non-canonical ordinal is not a handle');

        const next: FileFacts = { ...citedFacts('src/a.ts', H(2)), citations: [{ number: 9, span: span(1, 3, 1, 8) }] };
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(2), facts: next });
        assert.equal((await reader.provenance(handles[0] as string)).data, 'stale', 'the file changed since the handle was issued');
        writer.release();
      });
    });

    // -----------------------------------------------------------------------------------------
    // Citation gaps (plan 03-28, amendment of 2026-10-18): the schema stays at version 2, the table is additive derived data

    it('gap round trip: both fields are committed in the file transaction and read back deep-equal by fileFacts', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        for (const [index, gap] of [{ skippedComments: 1, capped: false }, { skippedComments: 0, capped: true }, { skippedComments: 4, capped: true }].entries()) {
          const facts = gapped(`src/g${String(index)}.ts`, H(10 + index), gap);
          const committed = await writer.commitFile({ worktree: 'main', path: facts.path, hash: facts.contentHash, facts });
          assert.equal(committed.status, 'committed');
          assert.deepStrictEqual((await store.at('main').fileFacts(facts.path)).data, facts);
        }
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 3);
        assert.equal(SCHEMA_VERSION, 2, 'the table is additive: the store schema version does not move');
        writer.release();
      });
    });

    it('no gap has no key: a file without a gap reads back as it was written and has no row', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const facts = citedFacts('src/a.ts', H(1));
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts });
        const read = (await store.at('main').fileFacts('src/a.ts')).data;
        assert.deepStrictEqual(read, facts);
        assert.equal(read !== null && 'citationGaps' in read, false);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 0);
        assert.deepStrictEqual((await store.at('main').citationGaps()).data, { files: 0 });
        writer.release();
      });
    });

    it('a re-extracted stale file clears and rewrites its gap', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const first = gapped('src/a.ts', H(1), { skippedComments: 2, capped: true });
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: first });
        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '0.24.0' }), 1);
        // The newer grammar reads the file without a gap: the row goes.
        const clean: FileFacts = { ...citedFacts('src/a.ts', H(1)), grammarVersion: '0.24.0' };
        assert.equal((await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: clean })).status, 'committed');
        assert.deepStrictEqual((await store.at('main').fileFacts('src/a.ts')).data, clean);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 0);
        // And a later stale pass that finds another gap writes that one.
        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '0.25.0' }), 1);
        const again: FileFacts = { ...gapped('src/a.ts', H(1), { skippedComments: 5, capped: false }), grammarVersion: '0.25.0' };
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: again });
        assert.deepStrictEqual((await store.at('main').fileFacts('src/a.ts')).data, again);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 1);
        writer.release();
      });
    });

    it('linked path shares the gap: every path that links to the same hash reads it', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const facts = gapped('src/a.ts', H(1), { skippedComments: 1, capped: true });
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts });
        assert.equal((await writer.link('main', 'lib/b.ts', H(1))).status, 'committed');
        const linked = (await store.at('main').fileFacts('lib/b.ts')).data;
        assert.deepStrictEqual(linked?.citationGaps, { skippedComments: 1, capped: true });
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 1, 'stored once, with the file version');
        // A second worktree that links the same hash has it too.
        await writer.setOverlay('other', 'refs/heads/other', new Map([['x/c.ts', H(1)]]));
        assert.deepStrictEqual((await store.at('other').fileFacts('x/c.ts')).data?.citationGaps, { skippedComments: 1, capped: true });
        writer.release();
      });
    });

    it('collect removes the gap with its version', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: gapped('src/a.ts', H(1), { skippedComments: 1, capped: false }) });
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: null });
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 1, 'the retired version still waits for collection');
        assert.deepStrictEqual((await store.at('main').citationGaps()).data, { files: 0 }, 'the path left the overlay, so it no longer counts');
        assert.equal((await store.collect({ budgetMs: 1000 })).processed, 1);
        assert.equal(await rig.count('SELECT count(*) AS n FROM citation_gaps'), 0);
        writer.release();
      });
    });

    it('gap count by overlay: a version linked from two paths counts for each path, one path can be asked about, and the status says the same', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: gapped('src/a.ts', H(1), { skippedComments: 1, capped: false }) });
        await writer.commitFile({ worktree: 'main', path: 'src/b.ts', hash: H(2), facts: citedFacts('src/b.ts', H(2)) });
        await writer.commitFile({ worktree: 'main', path: 'src/c.ts', hash: H(3), facts: gapped('src/c.ts', H(3), { skippedComments: 0, capped: true }) });
        await writer.link('main', 'src/d.ts', H(1));
        await writer.commitFile({ worktree: 'quiet', path: 'only.ts', hash: H(2), facts: citedFacts('only.ts', H(2)) });
        const reader = store.at('main');
        const all = await reader.citationGaps();
        assert.deepStrictEqual(all.data, { files: 3 });
        assert.equal(all.watermark.stalePaths.length, 0);
        for (const [filePath, files] of [['src/a.ts', 1], ['src/b.ts', 0], ['src/c.ts', 1], ['src/d.ts', 1], ['src/none.ts', 0]] as const) {
          assert.deepStrictEqual((await reader.citationGaps({ path: filePath })).data, { files }, filePath);
        }
        assert.deepStrictEqual((await store.at('quiet').citationGaps()).data, { files: 0 });
        await assert.rejects(store.at('nowhere').citationGaps(), UnknownWorktree);
        const status = await store.status();
        assert.deepStrictEqual(
          status.worktrees.map((entry) => [entry.worktree, entry.citationGapFiles]),
          [['main', 3], ['quiet', 0]],
        );
        writer.release();
      });
    });

    it('existing version 2 store gains the table: opening a store made before the table existed creates it without recreating the store', async () => {
      await withRig(driver, async (rig) => {
        const old = await rig.open();
        const writer = old.writer();
        await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: citedFacts('src/a.ts', H(1)) });
        writer.release();
        await old.close();
        // Make the store look like one written before this plan: version 2, no citation_gaps table.
        const raw = await openDatabase(rig.file, { driver });
        try {
          raw.exec('DROP TABLE citation_gaps');
        } finally {
          raw.close();
        }

        const fresh = await rig.open();
        const status = await fresh.status();
        assert.equal(status.schemaVersion, 2);
        assert.deepStrictEqual(status.worktrees.map((entry) => [entry.worktree, entry.files, entry.citationGapFiles]), [['main', 1, 0]], 'the overlay survived: the store was not recreated');
        assert.deepStrictEqual((await fresh.at('main').fileFacts('src/a.ts')).data, citedFacts('src/a.ts', H(1)));
        assert.deepStrictEqual((await fresh.at('main').citationGaps()).data, { files: 0 }, 'a store built before the table reports no gap until it is rebuilt');
        const again = fresh.writer();
        await again.commitFile({ worktree: 'main', path: 'src/n.ts', hash: H(5), facts: gapped('src/n.ts', H(5), { skippedComments: 1, capped: false }) });
        assert.deepStrictEqual((await fresh.at('main').citationGaps()).data, { files: 1 });
        again.release();
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
