/**
 * Facts the writer refuses to store, and what a collected hash really does (WR-05, IN-02, plan 02-32).
 * Real SQLite in a temp directory, a fake clock and a fake `gitHas`, through the public FactStore interface.
 * `deleteRetired` deletes the `files` row of a collected version, so a `collected` file state never existed.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FileFacts, Span } from '../facts/index.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { openFactStore } from './open.ts';
import { FILE_STATES, STORE_FILE_NAME } from './schema.ts';
import type { FactStore, Resolver, StoreDeps } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

/** A 40-hex blob id built from a number. */
const H = (n: number): string => n.toString(16).padStart(40, '0');

const span = (line: number): Span => ({ startLine: line, startColumn: 0, endLine: line + 1, endColumn: 1 });

function facts(filePath: string, hash: string, names: readonly string[]): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: names.map((name, index) => ({ name, kind: 'function', span: span(index * 2), exported: true })),
    refSites: [],
    imports: [],
    exports: [],
    parse: { errorBytes: 0, totalBytes: 100 },
  };
}

interface Rig {
  readonly git: Set<string>;
  open(): Promise<FactStore>;
  /** Rows of `sql` through a second connection. */
  rows(sql: string, write?: boolean): Promise<Record<string, unknown>[]>;
  /** Run `sql` on a second, writable connection. */
  exec(sql: string): Promise<void>;
}

async function withRig(driver: DriverName, run: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const dir = path.join(realPath(tmp.path), 'store');
  const file = path.join(dir, STORE_FILE_NAME);
  const git = new Set<string>();
  const opened: FactStore[] = [];
  const rig: Rig = {
    git,
    async open() {
      const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async (hash) => git.has(hash) };
      const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9' });
      opened.push(store);
      return store;
    },
    async rows(sql) {
      const db = await openDatabase(file, { readOnly: true, driver });
      try {
        return db.prepare(sql).all().map((row) => ({ ...row }));
      } finally {
        db.close();
      }
    },
    async exec(sql) {
      const db = await openDatabase(file, { driver });
      try {
        db.exec(sql);
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
  describe(`fact text validation at commit (${driver})`, () => {
    it('tracer: a non-string, empty or NUL name is rejected, not thrown, and nothing is written', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const writer = store.writer();
        const cases: readonly unknown[] = [42, '', 'a\0b'];
        for (const bad of cases) {
          const good = facts('a.ts', H(1), ['x']);
          const corrupt = { ...good, symbols: [{ ...good.symbols[0], name: bad }] } as unknown as FileFacts;
          const result = await writer.commitFile({ worktree: 'main', path: 'a.ts', hash: H(1), facts: corrupt });
          assert.equal(result.status, 'rejected', `name ${JSON.stringify(bad)}`);
          assert.equal(result.diagnostics[0]?.code, 'facts_invalid');
          assert.match(result.diagnostics[0]?.message ?? '', /symbol at index 0/);
        }
        assert.deepEqual(await rig.rows('SELECT id FROM files'), [], 'no files row');
        assert.deepEqual(await rig.rows('SELECT worktree FROM overlays'), [], 'no overlay');
        assert.deepEqual(await rig.rows('SELECT ord FROM symbols'), [], 'no symbol rows');
        writer.release();
      });
    });
  });

  describe(`collected hashes (${driver})`, () => {
    /** Commit H(1) at a.ts, replace it by H(2), collect H(1): its `files` row is gone. */
    async function collectFirst(rig: Rig, store: FactStore): Promise<number> {
      const writer = store.writer();
      const first = await writer.commitFile({ worktree: 'main', path: 'a.ts', hash: H(1), facts: facts('a.ts', H(1), ['old']) });
      assert.equal(first.status, 'committed');
      const firstId = Number((await rig.rows(`SELECT id FROM files WHERE hash = '${H(1)}'`))[0]?.id);
      await writer.commitFile({ worktree: 'main', path: 'a.ts', hash: H(2), facts: facts('a.ts', H(2), ['keep']) });
      rig.git.add(H(1));
      assert.equal((await store.collect({ budgetMs: 1000 })).processed, 1);
      assert.deepEqual(await rig.rows(`SELECT id FROM files WHERE hash = '${H(1)}'`), [], 'the row is deleted');
      writer.release();
      return firstId;
    }

    it('re-commit after collect: a new files.id, facts readable, then unchanged', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const firstId = await collectFirst(rig, store);
        const writer = store.writer();
        const again = await writer.commitFile({ worktree: 'main', path: 'b.ts', hash: H(1), facts: facts('b.ts', H(1), ['old']) });
        assert.equal(again.status, 'committed');
        const secondId = Number((await rig.rows(`SELECT id FROM files WHERE hash = '${H(1)}'`))[0]?.id);
        assert.notEqual(secondId, firstId, 'a collected hash gets a new files.id');
        assert.equal((await store.at('main').find('old')).data.length, 1);
        const repeat = await writer.commitFile({ worktree: 'main', path: 'b.ts', hash: H(1), facts: facts('b.ts', H(1), ['old']) });
        assert.equal(repeat.status, 'unchanged');
        writer.release();
      });
    });

    it('link of a collected hash answers hash_unknown', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await collectFirst(rig, store);
        const writer = store.writer();
        const link = await writer.link('main', 'c.ts', H(1));
        assert.equal(link.status, 'rejected');
        assert.equal(link.diagnostics[0]?.code, 'hash_unknown');
        writer.release();
      });
    });

    it('setOverlay of a collected hash stores a pending path', async () => {
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        await collectFirst(rig, store);
        const writer = store.writer();
        await writer.setOverlay('main', 'HEAD', new Map([['a.ts', H(2)], ['d.ts', H(1)]]));
        const pending = await rig.rows("SELECT path, file_id FROM overlay_files WHERE path = 'd.ts'");
        assert.equal(pending.length, 1);
        assert.equal(pending[0]?.file_id, null, 'file id is null: pending');
        const main = (await store.status()).worktrees.find((entry) => entry.worktree === 'main');
        assert.equal(main?.stalePaths, 1);
        writer.release();
      });
    });

    it('CHECK: the files table accepts only live and retired', async () => {
      assert.deepEqual([...FILE_STATES], ['live', 'retired']);
      await withRig(driver, async (rig) => {
        const store = await rig.open();
        const insert = (state: string): string =>
          `INSERT INTO files (hash, module, grammar_version, nsym, nref, error_bytes, total_bytes, state, first_seen, last_seen) VALUES ('${H(9)}', 'm', 'g', 0, 0, 0, 0, '${state}', 1, 1)`;
        await assert.rejects(rig.exec(insert('collected')), /CHECK|constraint/i);
        await rig.exec(insert('retired'));
        assert.equal((await rig.rows(`SELECT state FROM files WHERE hash = '${H(9)}'`))[0]?.state, 'retired');
        await store.close();
      });
    });
  });
}
