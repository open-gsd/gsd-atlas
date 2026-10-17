/**
 * Collection of retired versions and unused names (STO-05, D-16, plan 02-18). Real SQLite in a temp directory,
 * a fake clock and a fake `gitHas`, through the public FactStore interface; the only internals used are the
 * test hook that lets a commit land between `collect`'s selection and its delete, and a read-only connection
 * that counts rows.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { FileFacts, Span } from '../facts/index.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { WriterBusy } from './errors.ts';
import { lifecycleTestHooks, resetLifecycleTestHooks } from './lifecycle.ts';
import { DEFAULT_GC_GRACE_MS, openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import { STORE_FILE_NAME } from './schema.ts';
import type { FactStore, Resolver, StoreDeps, Writer } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

// IN-08: a hook one test set must not reach the stores of the next one, however that test ended.
afterEach(() => {
  resetLifecycleTestHooks();
});

/** A 40-hex blob id built from a number. */
const H = (n: number): string => n.toString(16).padStart(40, '0');

const span = (line: number): Span => ({ startLine: line, startColumn: 0, endLine: line + 1, endColumn: 1 });

/** A file whose symbols are `names` and whose first reference site is the first name. */
function facts(filePath: string, hash: string, names: readonly string[]): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: names.map((name, index) => ({ name, kind: 'function', span: span(index * 2), exported: true })),
    refSites: names.length === 0 ? [] : [{ name: names[0] ?? '', span: span(100), kind: 'call' as const }],
    imports: [],
    exports: [],
    parse: { errorBytes: 0, totalBytes: 100 },
  };
}

interface Rig {
  readonly clock: FakeClock;
  readonly dir: string;
  readonly file: string;
  /** Hashes `gitHas` answers true for. */
  readonly git: Set<string>;
  open(extra?: Partial<StoreOpenOptions>): Promise<FactStore>;
  /** The first column `n` of `sql`, read through a second, read-only connection. */
  count(sql: string): Promise<number>;
}

async function withRig(driver: DriverName, run: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const file = path.join(dir, STORE_FILE_NAME);
  const git = new Set<string>();
  const opened: FactStore[] = [];
  const rig: Rig = {
    clock,
    dir,
    file,
    git,
    async open(extra = {}) {
      const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async (hash) => git.has(hash) };
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
    resetLifecycleTestHooks();
    for (const store of opened) await store.close();
    tmp.cleanup();
  }
}

/** Commit `names` at `hash` to `a.ts` of worktree `main`. */
async function put(writer: Writer, hash: string, names: readonly string[], filePath = 'a.ts'): Promise<void> {
  const result = await writer.commitFile({ worktree: 'main', path: filePath, hash, facts: facts(filePath, hash, names) });
  assert.equal(result.status, 'committed');
}

for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
  describe(`collect retired versions (${driver})`, () => {
    it('tracer: a retired version is collected once git has it, and a second pass is idempotent', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await put(writer, H(1), ['old']);
        await put(writer, H(2), ['keep']);
        rig.git.add(H(1));
        assert.equal(await rig.count('SELECT count(*) AS n FROM files'), 2);

        const first = await store.collect({ budgetMs: 1000 });
        assert.equal(first.processed, 1);
        assert.equal(first.complete, true);
        assert.equal(await rig.count('SELECT count(*) AS n FROM files'), 1, 'the retired version and its files row are gone');
        assert.equal(await rig.count('SELECT count(*) AS n FROM symbols'), 1, 'only the live version keeps fact rows');

        const live = await store.at('main').find('keep');
        assert.equal(live.data.length, 1);
        assert.equal((await store.at('main').find('old')).data.length, 0);
        const link = await writer.link('main', 'b.ts', H(1));
        assert.equal(link.status, 'rejected');
        assert.equal(link.diagnostics[0]?.code, 'hash_unknown');

        const sizeBefore = (await store.status()).sizeBytes;
        const second = await store.collect({ budgetMs: 1000 });
        assert.equal(second.processed, 0, 'idempotent: a second pass over a collected store processes nothing');
        assert.equal(second.complete, true);
        assert.equal((await store.status()).sizeBytes, sizeBefore, 'and leaves the file the same size');
        writer.release();
      });
    });

    it('grace: without git a retired version waits for the approved grace period, and the period is configurable', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await put(writer, H(1), ['old']);
        await put(writer, H(2), ['keep']);

        assert.equal((await store.collect({ budgetMs: 1000 })).processed, 0, 'git does not have it and no time has passed');
        await rig.clock.advance(DEFAULT_GC_GRACE_MS - 1);
        assert.equal((await store.collect({ budgetMs: 1000 })).processed, 0, 'one millisecond before the grace ends');
        await rig.clock.advance(1);
        const result = await store.collect({ budgetMs: 1000 });
        assert.equal(result.processed, 1, 'at the end of the grace period the version goes');
        assert.equal(result.complete, true);
        writer.release();
      });
    });

    it('grace: a configured grace period replaces the default', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open({ graceMs: 5000 });
        const writer = store.writer();
        await put(writer, H(1), ['old']);
        await put(writer, H(2), ['keep']);
        await rig.clock.advance(4999);
        assert.equal((await store.collect({ budgetMs: 1000 })).processed, 0);
        await rig.clock.advance(1);
        assert.equal((await store.collect({ budgetMs: 1000 })).processed, 1);
        writer.release();
      });
    });

    it('referenced: a version another worktree still maps is never retired, so it is never collected', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await writer.commitFile({ worktree: 'main', path: 'a.ts', hash: H(1), facts: facts('a.ts', H(1), ['shared']) });
        const attach = await writer.link('other', 'a.ts', H(1));
        assert.equal(attach.status, 'committed');
        await put(writer, H(2), ['moved']);
        rig.git.add(H(1));

        const kept = await store.collect({ budgetMs: 1000 });
        assert.equal(kept.processed, 0, 'worktree other still maps H1');
        assert.equal((await store.at('other').find('shared')).data.length, 1);

        await writer.commitFile({ worktree: 'other', path: 'a.ts', hash: H(2), facts: facts('a.ts', H(2), ['moved']) });
        const freed = await store.collect({ budgetMs: 1000 });
        assert.equal(freed.processed, 1, 'once nothing maps it the version is collected');
        writer.release();
      });
    });

    it('revival: a version recommitted between selection and delete survives, because the delete is guarded by the retired state', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await put(writer, H(1), ['revived']);
        await put(writer, H(2), ['current']);
        rig.git.add(H(1));

        let selected: readonly string[] = [];
        lifecycleTestHooks.onSelected = async (hashes) => {
          selected = hashes;
          await put(writer, H(1), ['revived']); // the old content comes back before the delete transaction
        };
        const result = await store.collect({ budgetMs: 1000 });
        delete lifecycleTestHooks.onSelected;

        assert.deepStrictEqual(selected, [H(1)], 'the revived version was the one selected');
        assert.equal(result.processed, 0, 'nothing was deleted');
        assert.equal((await store.at('main').find('revived')).data.length, 1, 'the revived version serves');
        assert.equal(await rig.count(`SELECT count(*) AS n FROM files WHERE hash = '${H(1)}' AND state = 'live'`), 1);
        assert.equal(await rig.count('SELECT count(*) AS n FROM symbols'), 2, 'its fact rows are intact, beside the now retired current version');
        writer.release();
      });
    });

    it('chunk: a call collects at most one chunk past its budget, always at least one, and repeated calls finish the rest', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open({ chunkSize: 50 });
        const writer = store.writer();
        for (let index = 0; index < 120; index += 1) {
          const filePath = `src/f${index}.ts`;
          await put(writer, H(index + 1), [`name${index}`], filePath);
          await put(writer, H(1000 + index), [`next${index}`], filePath);
          rig.git.add(H(index + 1));
        }
        assert.equal(await rig.count("SELECT count(*) AS n FROM files WHERE state = 'retired'"), 120);

        const first = await store.collect({ budgetMs: 0 });
        assert.equal(first.processed, 50, 'a budget of zero still processes exactly one chunk');
        assert.equal(first.complete, false);
        const second = await store.collect({ budgetMs: 0 });
        assert.equal(second.processed, 50);
        assert.equal(second.complete, false);
        const third = await store.collect({ budgetMs: 0 });
        assert.equal(third.processed, 20);
        assert.equal(third.complete, true);
        assert.equal(first.processed + second.processed + third.processed, 120);
        assert.equal(await rig.count("SELECT count(*) AS n FROM files WHERE state = 'retired'"), 0);
        assert.equal(await rig.count('SELECT count(*) AS n FROM files'), 120, 'every live version is untouched');
        assert.equal((await store.collect({ budgetMs: 0 })).processed, 0);
        writer.release();
      });
    });

    it('chunk: retired versions git does not have yet do not block those behind them', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open({ chunkSize: 2 });
        const writer = store.writer();
        for (let index = 0; index < 6; index += 1) {
          const filePath = `src/f${index}.ts`;
          await put(writer, H(index + 1), [`name${index}`], filePath);
          await put(writer, H(100 + index), [`next${index}`], filePath);
        }
        // Only the last two retired versions are in git: the first four wait for the grace period.
        rig.git.add(H(5));
        rig.git.add(H(6));
        let processed = 0;
        for (let call = 0; call < 5 && processed < 2; call += 1) processed += (await store.collect({ budgetMs: 0 })).processed;
        assert.equal(processed, 2, 'repeated calls reach the collectable versions behind the waiting ones');
        assert.equal(await rig.count("SELECT count(*) AS n FROM files WHERE state = 'retired'"), 4);
        writer.release();
      });
    });

    const nameVariants = [
      { label: 'trigram on', trigram: true, contentlessDelete: true },
      { label: 'trigram on, no contentless delete', trigram: true, contentlessDelete: false },
      { label: 'trigram off', trigram: false, contentlessDelete: true },
    ] as const;
    for (const { label, trigram, contentlessDelete } of nameVariants) {
      it(`names: identifiers no fact uses any more are deleted with their trigram rows (${label})`, async () => {
        await withRig(driver, async (rig) => {
          const store = await rig.open({ trigram, contentlessDelete });
          const writer = store.writer();
          await put(writer, H(1), ['alphaOnly', 'shared']);
          await put(writer, H(2), ['betaOnly', 'shared']);
          rig.git.add(H(1));
          assert.equal(await rig.count('SELECT count(*) AS n FROM names'), 3);
          if (trigram) {
            assert.equal(await rig.count(`SELECT count(*) AS n FROM names_fts WHERE names_fts MATCH '"alphaOnly"'`), 1);
          }

          assert.equal((await store.collect({ budgetMs: 1000 })).processed, 1);
          assert.equal(await rig.count('SELECT count(*) AS n FROM names'), 2, 'alphaOnly is gone, shared and betaOnly stay');
          assert.equal(
            await rig.count(
              'SELECT count(*) AS n FROM (SELECT name_id FROM symbols UNION SELECT name_id FROM refs UNION SELECT name_id FROM exports)',
            ),
            2,
            'names equals the distinct names the live facts use',
          );
          if (trigram) {
            assert.equal(await rig.count(`SELECT count(*) AS n FROM names_fts WHERE names_fts MATCH '"alphaOnly"'`), 0);
            assert.equal(await rig.count(`SELECT count(*) AS n FROM names_fts WHERE names_fts MATCH '"betaOnly"'`), 1);
          }
          assert.equal((await store.at('main').find('alphaOnly', { mode: 'fuzzy' })).data.length, 0);
          assert.equal((await store.at('main').find('betaOnly', { mode: 'fuzzy' })).data.length, 1);

          // The writer still works right after the trigram rows went: its first statement is an UPDATE, whose
          // result the kit reads together with the connection's last-insert rowid.
          const attach = await writer.link('main', 'b.ts', H(2));
          assert.equal(attach.status, 'committed');
          assert.equal((await writer.commitFile({ worktree: 'main', path: 'a.ts', hash: H(3), facts: facts('a.ts', H(3), ['gamma']) })).status, 'committed');
          writer.release();
        });
      });
    }

    it('names: a name freed and then used again by a new file is indexed again', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await put(writer, H(1), ['recycled']);
        await put(writer, H(2), ['other']);
        rig.git.add(H(1));
        await store.collect({ budgetMs: 1000 });
        await put(writer, H(3), ['recycled', 'fresh']);
        assert.equal((await store.at('main').find('recycled', { mode: 'fuzzy' })).data.length, 1);
        assert.equal((await store.at('main').find('fresh', { mode: 'fuzzy' })).data.length, 1);
        writer.release();
      });
    });

    it('empty name: a live fact named with the empty string does not make collect fail after it deleted rows (WR-05)', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open(); // the trigram index is on, which is what the rowid reset is for
        const writer = store.writer();
        await put(writer, H(1), ['old']);
        await put(writer, H(2), ['keep']);
        rig.git.add(H(1));
        // The extractors never write this name; raw SQL stands in for a fact that does.
        const raw = await openDatabase(rig.file, { driver });
        try {
          raw.exec("INSERT INTO names (name) VALUES ('')");
          raw.exec(
            `INSERT INTO symbols (file_id, ord, name_id, kind, start_line, start_col, end_line, end_col)
             SELECT f.id, 99, n.id, 'function', 0, 0, 1, 1 FROM files f, names n WHERE f.hash = '${H(2)}' AND n.name = ''`,
          );
          raw.exec("INSERT INTO names_fts (rowid, name) SELECT id, name FROM names WHERE name = ''");
        } finally {
          raw.close();
        }

        const result = await store.collect({ budgetMs: 1000 });
        assert.equal(result.processed, 1);
        assert.equal(result.complete, true);
        assert.equal(await rig.count("SELECT count(*) AS n FROM files WHERE hash = '" + H(1) + "'"), 0, 'the retired version is gone');
        assert.equal(await rig.count("SELECT count(*) AS n FROM names WHERE name = ''"), 1, 'and the live empty name is still there');
        assert.equal(
          await rig.count(
            `SELECT count(*) AS n FROM names WHERE id NOT IN (SELECT name_id FROM symbols UNION SELECT name_id FROM refs UNION SELECT name_id FROM exports)`,
          ),
          0,
          'no sentinel row remains',
        );
        assert.equal((await writer.link('main', 'b.ts', H(2))).status, 'committed', 'the writer still works afterwards');
        writer.release();
      });
    });

    it('collect on a follower, which does not hold the writer lease, throws WriterBusy', async () => {
      await withRig(driver, async (rig) => {
        const leader = await rig.open({ lease: 'acquire' });
        const follower = await rig.open({ lease: 'acquire' });
        assert.equal((await leader.status()).writerLeaseHeld, true);
        assert.equal((await follower.status()).writerLeaseHeld, false);
        await assert.rejects(follower.collect({ budgetMs: 1000 }), WriterBusy);
        assert.deepStrictEqual(await leader.collect({ budgetMs: 1000 }), { complete: true, spentMs: 0, processed: 0 });
      });
    });

    it('the status of a store is the same before and after a collection except for its size', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        await put(writer, H(1), ['old']);
        await put(writer, H(2), ['keep']);
        rig.git.add(H(1));
        const before = await store.status();
        await store.collect({ budgetMs: 1000 });
        const after = await store.status();
        assert.deepStrictEqual({ ...after, sizeBytes: 0 }, { ...before, sizeBytes: 0 });
        writer.release();
      });
    });
  });
}

describe('test hygiene (IN-08)', () => {
  it('no lifecycle hook is set when the last test of the file starts', () => {
    assert.deepStrictEqual(Object.values(lifecycleTestHooks).filter((hook) => hook !== undefined), []);
  });
});
