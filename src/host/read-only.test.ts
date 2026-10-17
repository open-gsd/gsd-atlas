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
import { PROTOCOL_VERSION } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { notIndexedNoStore } from '../tenant/index.ts';
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
