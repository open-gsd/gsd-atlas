/**
 * The read-only tools are read-only (WR-01, QRY-06, plan 02-41): only `build` may create a store. Every other
 * repo-scoped request is answered from a tenant that is open, or from a store that already holds an index, or with
 * `not_indexed` produced by the Host without touching the file system. The tests fingerprint whole directory trees
 * (path, size, content hash) before and after, so a created file, a rewritten file and a new directory all show.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openFactStore } from '../fact-store/index.ts';
import { PROTOCOL_VERSION } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { createTenant, notIndexedNoStore, storeUnavailableEnvelope } from '../tenant/index.ts';
import { makeWorld, storeIdOf } from './harness.test.ts';
import type { World } from './harness.test.ts';

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);

/** Every entry below `root` as `path|size|sha256` (directories as `path/`), sorted; a missing root is empty. */
export function fingerprint(root: string, skip: (relative: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (skip(relative)) continue;
      if (entry.isDirectory()) {
        out.push(`${relative}/`);
        walk(full);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        out.push(`${relative}|${String(bytes.length)}|${createHash('sha256').update(bytes).digest('hex')}`);
      } else {
        out.push(`${relative}|other`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The three places a request must not write: the repository (with its git directory), the cache and the user directory. */
function snapshot(world: World, skip?: (relative: string) => boolean): { repo: string[]; cache: string[]; user: string[] } {
  return {
    repo: fingerprint(world.repo.dir, skip),
    cache: fingerprint(path.join(world.tmp.path, 'cache')),
    user: fingerprint(path.join(world.tmp.path, 'user')),
  };
}

const gitStoreDir = (world: World): string => path.join(world.repo.dir, '.git', 'gsd-atlas');

interface FindData {
  readonly results: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

/** One valid request of every kind but `build`. */
const READ_REQUESTS: ReadonlyArray<readonly [string, (repo: string) => Record<string, unknown>]> = [
  ['code_find', (repo) => ({ name: 'helper', repo })],
  ['code_refs', (repo) => ({ name: 'boot', repo })],
  ['code_context', (repo) => ({ name: 'helper', repo })],
  ['code_impact', (repo) => ({ name: 'boot', repo })],
  ['atlas_status', (repo) => ({ repo })],
  ['maintain', (repo) => ({ repo })],
  ['status', (repo) => ({ repo })],
];

describe('Host: read tools never create a store (WR-01)', () => {
  it('unbuilt repository writes nothing', async (t) => {
    const world = await makeWorld(t);
    const before = snapshot(world);
    const expected = notIndexedNoStore();
    for (const [kind, args] of READ_REQUESTS) {
      const reply = await world.ask(kind, args(world.repo.dir));
      assert.equal(fs.existsSync(gitStoreDir(world)), false, `${kind}: a store directory appeared in .git`);
      assert.equal(reply.ok, false, kind);
      assert.deepEqual(codes(reply), ['not_indexed'], kind);
      assert.equal(reply.diagnostics[0]?.message, expected.diagnostics[0]?.message, `${kind}: the exact no-store text`);
      assert.match(reply.diagnostics[0]?.message ?? '', /gsd-atlas build/);
    }
    const fresh = await world.ask('code_find', { name: 'helper', repo: world.repo.dir }, { fresh: ['b.toy'] });
    assert.deepEqual(codes(fresh), ['not_indexed'], 'fresh paths index nothing either (D-11)');
    assert.deepEqual(snapshot(world), before, 'the repository, its .git, the cache and the user directory are byte-for-byte unchanged');
    assert.equal(fs.existsSync(gitStoreDir(world)), false, 'no gsd-atlas entry in the git common directory');
    assert.equal(world.manual.subscriptions(), 0, 'nothing is watched');
  });

  it('build creates the store', async (t) => {
    const world = await makeWorld(t);
    const outsideStore = (relative: string): boolean => relative === '.git/gsd-atlas' || relative.startsWith('.git/gsd-atlas/');
    const before = snapshot(world, outsideStore);

    const built = await world.ask('build', { repo: world.repo.dir });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal(fs.statSync(path.join(gitStoreDir(world), 'facts.db')).isFile(), true);

    for (const [kind, args] of READ_REQUESTS) {
      const reply = await world.ask(kind, args(world.repo.dir));
      assert.equal(reply.ok, true, `${kind}: ${JSON.stringify(reply.diagnostics)}`);
    }
    assert.deepEqual(snapshot(world, outsideStore), before, 'outside the gsd-atlas folder nothing changed');
  });

  it('existing store opens', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    // A restart: the first Host lets go of the repository, a second Host starts with an empty registry.
    await world.host.closeTenant(await storeIdOf(world.repo));
    const second = world.anotherHost();
    const found = await second.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name: 'helper', repo: world.repo.dir } });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results[0]?.path, 'b.toy');
  });

  it('store.dir and cache stores are found', async (t) => {
    // The store lives under the user's store.dir override.
    const override = await makeWorld(t, { host: {} });
    const storeDir = path.join(override.tmp.path, 'my-stores');
    const withDir = override.anotherHost({ config: { store: { dir: storeDir } } });
    const ask = (host: typeof withDir, kind: string, args: Record<string, unknown>): Promise<Envelope> =>
      host.handle({ protocol: PROTOCOL_VERSION, kind, args });
    assert.equal((await ask(withDir, 'build', { repo: override.repo.dir })).ok, true);
    assert.equal(fs.existsSync(gitStoreDir(override)), false, 'the override, not the git directory, holds the store');
    await withDir.closeTenant(await storeIdOf(override.repo));
    const restarted = override.anotherHost({ config: { store: { dir: storeDir } } });
    const viaOverride = await ask(restarted, 'code_find', { name: 'helper', repo: override.repo.dir });
    assert.equal(viaOverride.ok, true, JSON.stringify(viaOverride.diagnostics));
    assert.equal((viaOverride.data as FindData).results.length, 1);
    // A Host that does not know the override does not find that store, and creates nothing.
    const unaware = await ask(override.host, 'code_find', { name: 'helper', repo: override.repo.dir });
    assert.deepEqual(codes(unaware), ['not_indexed']);

    // The cache fallback: something that is not a directory sits where the git-directory store would go.
    const cached = await makeWorld(t);
    fs.writeFileSync(gitStoreDir(cached), 'in the way');
    assert.equal((await cached.ask('build', { repo: cached.repo.dir })).ok, true);
    assert.equal(fs.existsSync(path.join(cached.tmp.path, 'cache', 'gsd-atlas')), true, 'the store is in the cache directory');
    await cached.host.closeTenant(await storeIdOf(cached.repo));
    const again = cached.anotherHost();
    const viaCache = await ask(again, 'code_find', { name: 'helper', repo: cached.repo.dir });
    assert.equal(viaCache.ok, true, JSON.stringify(viaCache.diagnostics));
    assert.equal((viaCache.data as FindData).results.length, 1);
  });

  it('a store.dir override that is not absolute is the store_unavailable error a tenant gave before', async (t) => {
    const world = await makeWorld(t);
    const bad = world.anotherHost({ config: { store: { dir: 'relative/place' } } });
    const reply = await bad.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name: 'helper', repo: world.repo.dir } });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['store_unavailable']);
  });

  it('build races a find', async (t) => {
    const world = await makeWorld(t);
    const [built, found] = await Promise.all([
      world.ask('build', { repo: world.repo.dir }),
      world.ask('code_find', { name: 'helper', repo: world.repo.dir }),
    ]);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    if (found.ok) {
      assert.equal((found.data as FindData).results.length, 1);
    } else {
      assert.deepEqual(codes(found), ['not_indexed']);
    }
    assert.equal(fs.statSync(path.join(gitStoreDir(world), 'facts.db')).isFile(), true);
    assert.equal(fs.existsSync(path.join(world.tmp.path, 'cache', 'gsd-atlas')), false, 'exactly one store exists');
    const after = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(after.ok, true, JSON.stringify(after.diagnostics));
  });
});

/**
 * A store directory fingerprint that tolerates exactly what a read-only connection to a write-ahead-log database
 * leaves behind: the wal-index `facts.db-shm` and an empty `facts.db-wal` (see the probe's test).
 */
const storeFingerprint = (dir: string): string[] =>
  fingerprint(dir).filter((entry) => !entry.startsWith('facts.db-shm|') && !entry.startsWith('facts.db-wal|0|'));

/** Create a store in the directory the Host looks in, with the given schema version, and close it again. */
async function makeStoreFile(dir: string, schemaVersion?: number): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const store = await openFactStore(
    dir,
    { resolver: async function* () {}, clock: new FakeClock(1000), gitHas: async () => true },
    { repo: 'repo', ...(schemaVersion === undefined ? {} : { schemaVersion }) },
  );
  await store.close();
}

/** True when a process opening this directory with the lease becomes the leader, i.e. nothing else holds it. */
async function leaseIsFree(dir: string): Promise<boolean> {
  const store = await openFactStore(
    dir,
    { resolver: async function* () {}, clock: new FakeClock(1000), gitHas: async () => true },
    { repo: 'repo', lease: 'acquire' },
  );
  try {
    return (await store.status()).writerLeaseHeld;
  } finally {
    await store.close();
  }
}

describe('Host: containment and a tenant that lost its store (IN-03, plan 02-41)', () => {
  it('dot-dot directory name resolves: a directory called ..cache inside the worktree is a child, not a parent', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const sub = path.join(world.repo.dir, '..cache', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const found = await world.ask('code_find', { name: 'helper', cwd: sub });
    assert.deepEqual(codes(found).filter((code) => code === 'not_a_repo'), [], 'spurious not_a_repo');
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results.length, 1);
  });

  it('store_unavailable drops the tenant: the next request opens a fresh one', async (t) => {
    const world = await makeWorld(t);
    let created = 0;
    let closedFirst = false;
    const host = world.anotherHost({
      tenantFactory: async (deps) => {
        created += 1;
        const real = await createTenant(deps);
        if (created > 1) return real;
        // The first tenant's store "closes itself after a failed recovery": every code request is answered so.
        return {
          ...real,
          handle: () => Promise.resolve(storeUnavailableEnvelope()),
          close: async () => {
            closedFirst = true;
            await real.close();
          },
        };
      },
    });
    const ask = (kind: string, args: Record<string, unknown>): Promise<Envelope> =>
      host.handle({ protocol: PROTOCOL_VERSION, kind, args });

    assert.equal((await ask('build', { repo: world.repo.dir })).ok, true);
    const broken = await ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.deepEqual(codes(broken), ['store_unavailable']);
    await eventuallyTrue(() => closedFirst, 'the failed tenant to be closed');

    const again = await ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(again.ok, true, JSON.stringify(again.diagnostics));
    assert.equal((again.data as FindData).results.length, 1);
    assert.equal(created, 2, 'the second request created a new tenant');
  });
});

async function eventuallyTrue(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('Host: a store that holds no index is not opened by a read request (WR-02)', () => {
  const states: ReadonlyArray<readonly [string, (dir: string) => Promise<void>]> = [
    ['created and never built', (dir) => makeStoreFile(dir)],
    ['older schema', (dir) => makeStoreFile(dir, 0)],
    [
      'not a database',
      (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'facts.db'), 'this is not a database, it is text'.repeat(50));
        return Promise.resolve();
      },
    ],
  ];

  for (const [label, make] of states) {
    it(`${label}: not_indexed, no tenant, the lease stays free and the store is untouched`, async (t) => {
      const world = await makeWorld(t);
      const dir = gitStoreDir(world);
      await make(dir);
      const before = storeFingerprint(dir);
      for (const [kind, args] of READ_REQUESTS) {
        const reply = await world.ask(kind, args(world.repo.dir));
        assert.deepEqual(codes(reply), ['not_indexed'], `${kind}: ${JSON.stringify(reply.diagnostics)}`);
        assert.equal(reply.diagnostics[0]?.message, notIndexedNoStore().diagnostics[0]?.message, kind);
      }
      assert.deepEqual(storeFingerprint(dir), before, 'the read moved nothing aside and rewrote nothing');
      for (const created of ['lease.json', 'lease.db', 'metrics.db']) {
        assert.equal(fs.existsSync(path.join(dir, created)), false, `${created} was created`);
      }
      assert.equal(world.manual.subscriptions(), 0);
      if (label !== 'not a database') assert.equal(await leaseIsFree(dir), true, 'nothing holds the writer lease');
    });
  }

  it('a newer-schema store reaches the tenant and answers the ratified schema_too_new error', async (t) => {
    const world = await makeWorld(t);
    await makeStoreFile(gitStoreDir(world), 2);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.deepEqual(codes(reply), ['schema_too_new']);
  });

  it('after a build the same store is opened by the next read, and an open tenant is not probed again', { skip: process.platform === 'win32' }, async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const file = path.join(gitStoreDir(world), 'facts.db');
    // The file is moved away while the tenant keeps its connections: a probe or a location check would now say
    // "no store", so a normal answer proves the open tenant is used without consulting either (the tenant is open
    // by then, so this holds on a POSIX file system where a rename does not close the file).
    fs.renameSync(file, `${file}.moved`);
    try {
      const found = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
      assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    } finally {
      fs.renameSync(`${file}.moved`, file);
    }
  });
});
