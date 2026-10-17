/**
 * The store probe (WR-02, plan 02-41): a read-only, side-effect-free classification of the store a read request
 * would otherwise open. Real stores on a temp directory made by `openFactStore`; the only double is a driver whose
 * open reports a busy database.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DbError, loadDriver, openDatabase } from '../sqlite/index.ts';
import type { DriverModule } from '../sqlite/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import { probeStore } from './probe.ts';
import type { Resolver, StoreDeps } from './types.ts';

const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

const FILE = 'facts.db';

interface Place {
  readonly dir: string;
  readonly file: string;
  readonly location: { readonly dir: string; readonly kind: 'git-common' };
}

/** A fresh store directory under a temp tree, removed (after every connection is closed) when `run` ends. */
async function inPlace(run: (place: Place) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  try {
    const dir = path.join(realPath(tmp.path), 'store');
    fs.mkdirSync(dir);
    await run({ dir, file: path.join(dir, FILE), location: { dir, kind: 'git-common' } });
  } finally {
    tmp.cleanup();
  }
}

/** Create a real store with the given extra options, then close it (it leaves a clean database file). */
async function makeStore(place: Place, extra: Partial<StoreOpenOptions> = {}): Promise<void> {
  const deps: StoreDeps = { resolver: noResolver, clock: new FakeClock(1000), gitHas: async () => true };
  const store = await openFactStore(place.dir, deps, { repo: 'repo', ...extra });
  await store.close();
}

/** Put overlay rows straight into the file: `[worktree, dropped]`. */
async function addOverlays(place: Place, rows: ReadonlyArray<readonly [string, number]>): Promise<void> {
  const db = await openDatabase(place.file, { timeoutMs: 1000 });
  try {
    const insert = db.prepare('INSERT INTO overlays (worktree, ref, seq, dropped) VALUES (?, ?, ?, ?)');
    rows.forEach(([worktree, dropped], index) => {
      insert.run(worktree, 'HEAD', index + 1, dropped);
    });
    db.pragma('wal_checkpoint', 'TRUNCATE');
  } finally {
    db.close();
  }
}

/**
 * Every file in the directory: name, size and content hash, except the two names a read-only connection to a
 * write-ahead-log database leaves behind: the wal-index `facts.db-shm`, and an EMPTY `facts.db-wal`. Those exact
 * names, and an empty log, are the only tolerance; a log with content is a write and shows.
 */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const bytes = name.endsWith('-shm') ? Buffer.alloc(0) : fs.readFileSync(path.join(dir, name));
    if (name === `${FILE}-shm`) continue;
    if (name === `${FILE}-wal` && bytes.length === 0) continue;
    out.push(`${name}:${String(bytes.length)}:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  return out;
}

describe('probeStore', () => {
  it('indexed: a current-schema store with a live overlay', async () => {
    await inPlace(async (place) => {
      await makeStore(place);
      await addOverlays(place, [['/work/main', 0]]);
      assert.equal(await probeStore(place.location), 'indexed');
    });
  });

  it('empty: a current-schema store with no overlay, or only dropped overlays', async () => {
    await inPlace(async (place) => {
      await makeStore(place);
      assert.equal(await probeStore(place.location), 'empty', 'created and never built');
      await addOverlays(place, [['/work/gone', 1]]);
      assert.equal(await probeStore(place.location), 'empty', 'every overlay was dropped');
      await addOverlays(place, [['/work/main', 0]]);
      assert.equal(await probeStore(place.location), 'indexed', 'one live overlay among the dropped ones');
    });
  });

  it('older schema: nothing to read, with or without an overlay', async () => {
    await inPlace(async (place) => {
      await makeStore(place, { schemaVersion: 0 });
      assert.equal(await probeStore(place.location), 'older_schema');
      await addOverlays(place, [['/work/main', 0]]);
      assert.equal(await probeStore(place.location), 'older_schema');
    });
  });

  it('newer schema: reported so the tenant can answer schema_too_new', async () => {
    await inPlace(async (place) => {
      await makeStore(place, { schemaVersion: 2 });
      assert.equal(await probeStore(place.location), 'newer_schema');
    });
  });

  it('unreadable: a file that is not a database, a zero-byte file, and a database without a meta table', async () => {
    await inPlace(async (place) => {
      fs.writeFileSync(place.file, 'this is not a database file at all, it is just text'.repeat(40));
      assert.equal(await probeStore(place.location), 'unreadable', 'not a database');
      fs.writeFileSync(place.file, '');
      assert.equal(await probeStore(place.location), 'unreadable', 'zero bytes');
      fs.rmSync(place.file);
      const db = await openDatabase(place.file, { timeoutMs: 1000 });
      db.exec('CREATE TABLE unrelated (x INTEGER)');
      db.close();
      assert.equal(await probeStore(place.location), 'unreadable', 'no meta table');
      fs.rmSync(place.file, { force: true });
      assert.equal(await probeStore(place.location), 'unreadable', 'the file vanished');
    });
  });

  it('a store whose lease is held by a leader that is open and writing still gives indexed, without waiting', async () => {
    await inPlace(async (place) => {
      await makeStore(place);
      await addOverlays(place, [['/work/main', 0]]);
      const deps: StoreDeps = { resolver: noResolver, clock: new FakeClock(1000), gitHas: async () => true };
      const leader = await openFactStore(place.dir, deps, { repo: 'repo', lease: 'acquire' });
      try {
        assert.equal((await leader.status()).writerLeaseHeld, true);
        const started = Date.now();
        assert.equal(await probeStore(place.location), 'indexed');
        assert.ok(Date.now() - started < 2000, 'a probe never waits on the writer');
      } finally {
        await leader.close();
      }
    });
  });

  it('busy counts as indexed: an indeterminate probe never withholds a tenant', async () => {
    await inPlace(async (place) => {
      await makeStore(place);
      const real = await loadDriver('node:sqlite');
      const busy: DriverModule = {
        name: real.name,
        open() {
          throw new DbError('busy', 'database is locked', 5);
        },
      };
      assert.equal(await probeStore(place.location, { kit: { driver: busy } }), 'indexed');
      const odd: DriverModule = {
        name: real.name,
        open() {
          throw new Error('something nobody expected');
        },
      };
      assert.equal(await probeStore(place.location, { kit: { driver: odd } }), 'indexed', 'any other indeterminate error counts too');
    });
  });

  it('changes nothing: the store directory is identical before and after, and no lease or metrics file appears', async () => {
    await inPlace(async (place) => {
      await makeStore(place);
      await addOverlays(place, [['/work/main', 0]]);
      const before = fingerprint(place.dir);
      for (let round = 0; round < 3; round += 1) assert.equal(await probeStore(place.location), 'indexed');
      assert.deepEqual(fingerprint(place.dir), before);
      const names = fs.readdirSync(place.dir);
      for (const created of ['lease.db', 'lease.json', 'metrics.db']) assert.equal(names.includes(created), false, created);
    });
  });
});
