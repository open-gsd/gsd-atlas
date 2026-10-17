/**
 * Open item 7 of plan 02-20: store creation must set `auto_vacuum=INCREMENTAL` and then run one `VACUUM` once the
 * file is in WAL mode, because the pragma alone is ignored until the file is rebuilt. `compact` relies on it: an
 * incremental vacuum can only return pages to a file that was created this way.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase } from '../sqlite/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { openFactStore } from './index.ts';
import type { Resolver } from './index.ts';

const noResolver: Resolver = async function* () {
  // resolves nothing
};

/** SQLite's value of `PRAGMA auto_vacuum` for INCREMENTAL. */
const INCREMENTAL = 2;

describe('a new store file', () => {
  for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
    it(`is created with incremental auto_vacuum in WAL mode (${driver})`, async (t) => {
      const tmp = makeTempDir();
      const dir = path.join(tmp.path, 'store');
      const store = await openFactStore(
        dir,
        { resolver: noResolver, clock: new FakeClock(0), gitHas: () => Promise.resolve(true) },
        { driver },
      );
      // One hook, in this order: `t.after` hooks run in the order they were registered, and Windows cannot remove a
      // directory that holds an open database (found by plan 02-26 on Windows CI: EPERM when the removal came first).
      t.after(async () => {
        await store.close();
        tmp.cleanup();
      });
      const db = await openDatabase(path.join(dir, 'facts.db'), { driver, readOnly: true });
      try {
        assert.equal(Number(db.pragma('auto_vacuum')), INCREMENTAL, 'the VACUUM after the WAL open made the setting take effect');
        assert.equal(String(db.pragma('journal_mode')).toLowerCase(), 'wal');
      } finally {
        db.close();
      }
    });
  }
});
