/**
 * The additive `files` count of `WorktreeStatus` (STO-10, plan 02-28): how many paths a worktree's overlay holds,
 * which the index-health gauge reports as its file count. Real SQLite in a temp directory, through the public
 * FactStore interface, for both drivers.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { generatedFacts, generatedHash, generatedPath } from '../../scripts/test-helpers/store-facts.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { openFactStore } from './open.ts';
import type { FactStore, Resolver, StoreDeps, Writer } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

async function withStore(driver: DriverName, run: (store: FactStore) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  const deps: StoreDeps = { resolver: noResolver, clock: new FakeClock(1000), gitHas: async () => true };
  const store = await openFactStore(path.join(realPath(tmp.path), 'store'), deps, { driver, repo: 'repo', version: '9.9.9' });
  try {
    await run(store);
  } finally {
    await store.close();
    tmp.cleanup();
  }
}

async function commit(writer: Writer, worktree: string, index: number): Promise<void> {
  await writer.commitFile({ worktree, path: generatedPath(index), hash: generatedHash(index), facts: generatedFacts(index) });
}

const filesOf = async (store: FactStore, worktree: string): Promise<number | undefined> =>
  (await store.status()).worktrees.find((entry) => entry.worktree === worktree)?.files;

for (const driver of ['node:sqlite', 'better-sqlite3'] as const) {
  describe(`WorktreeStatus.files (${driver})`, () => {
    it('is zero for an empty worktree', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await writer.setOverlay('empty', 'refs/heads/e', new Map());
        assert.equal(await filesOf(store, 'empty'), 0);
        writer.release();
      });
    });

    it('counts the overlay paths after commits and drops by one after a delete', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        for (let index = 0; index < 3; index += 1) await commit(writer, 'main', index);
        await commit(writer, 'other', 0);
        assert.equal(await filesOf(store, 'main'), 3);
        assert.equal(await filesOf(store, 'other'), 1, 'another worktree is counted on its own');

        await writer.commitFile({ worktree: 'main', path: generatedPath(1), hash: generatedHash(1), facts: null });
        assert.equal(await filesOf(store, 'main'), 2);
        assert.equal(await filesOf(store, 'other'), 1);
        writer.release();
      });
    });

    it('counts a pending path (no facts yet) and leaves every existing field unchanged', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await commit(writer, 'main', 0);
        await writer.setOverlay('main', 'refs/heads/main', new Map([[generatedPath(0), generatedHash(0)], ['pending.ts', generatedHash(9)]]));
        const status = await store.status();
        assert.deepStrictEqual(status.worktrees, [{ worktree: 'main', seq: 2, stalePaths: 1, files: 2, citationGapFiles: 0 }]);
        assert.equal(typeof status.sizeBytes, 'number');
        assert.equal(status.writerLeaseHeld, true);
        writer.release();
      });
    });
  });
}
