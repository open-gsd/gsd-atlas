/**
 * `index_state` (plan 02-44, IN-04): the internal request the CLI's `no index yet` hint asks the Host. It answers with
 * the predicate that gates every read request (a tenant is open, or the shared location rules find a store that holds
 * an index), so a store kept under `store.dir` or in the cache directory is seen. It opens no tenant, takes no lease
 * and writes nothing, and it is not an MCP tool (QRY-06).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openFactStore } from '../fact-store/index.ts';
import { PROTOCOL_VERSION } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { TOOL_NAMES } from '../query/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { makeWorld, storeIdOf } from './harness.test.ts';
import type { World } from './harness.test.ts';
import type { Host } from './index.ts';

const INDEX_STATE_SCHEMA = 'gsd-atlas.index-state/1';

interface IndexStateData {
  readonly repo: string;
  readonly indexed: boolean;
}

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);
const dataOf = (reply: Envelope): IndexStateData => reply.data as IndexStateData;
const gitStoreDir = (world: World): string => path.join(world.repo.dir, '.git', 'gsd-atlas');
const askOn = (host: Host, kind: string, args: Record<string, unknown>): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, args });

/** Every entry below `root` as `path|size|sha256` (directories as `path/`), sorted; a missing root is empty. */
function fingerprint(root: string): string[] {
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
      if (entry.isDirectory()) {
        out.push(`${relative}/`);
        walk(full);
      } else {
        const bytes = fs.readFileSync(full);
        out.push(`${relative}|${String(bytes.length)}|${createHash('sha256').update(bytes).digest('hex')}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The three places a request must not write: the repository (with its git directory), the cache and the user directory. */
const snapshot = (world: World): { repo: string[]; cache: string[]; user: string[] } => ({
  repo: fingerprint(world.repo.dir),
  cache: fingerprint(path.join(world.tmp.path, 'cache')),
  user: fingerprint(path.join(world.tmp.path, 'user')),
});

/** Create a store in `dir` with the given schema version and close it again: a store that holds no index. */
async function makeStoreFile(dir: string, schemaVersion?: number): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const store = await openFactStore(
    dir,
    { resolver: async function* () {}, clock: new FakeClock(1000), gitHas: async () => true },
    { repo: 'repo', ...(schemaVersion === undefined ? {} : { schemaVersion }) },
  );
  await store.close();
}

describe('Host: index_state answers whether the repository has an index, without opening anything', () => {
  it('built: ok, indexed true, with the repository root', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    // A restart, so the answer comes from the files and not from an open tenant.
    await world.host.closeTenant(await storeIdOf(world.repo));
    const restarted = world.anotherHost();

    const reply = await askOn(restarted, 'index_state', { repo: world.repo.dir });

    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal(reply.schema, INDEX_STATE_SCHEMA);
    assert.equal(dataOf(reply).indexed, true);
    assert.equal(fs.realpathSync(dataOf(reply).repo), fs.realpathSync(world.repo.dir));
  });

  it('built, tenant open: indexed true without a store file check', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const reply = await world.ask('index_state', { cwd: world.repo.dir });
    assert.equal(dataOf(reply).indexed, true);
  });

  it('unbuilt: ok, indexed false, with the repository root', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('index_state', { repo: world.repo.dir });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal(reply.schema, INDEX_STATE_SCHEMA);
    assert.equal(dataOf(reply).indexed, false);
    assert.equal(fs.realpathSync(dataOf(reply).repo), fs.realpathSync(world.repo.dir));
  });

  it('empty store: a store that was created and never built holds no index', async (t) => {
    const world = await makeWorld(t);
    await makeStoreFile(gitStoreDir(world));
    assert.equal(dataOf(await world.ask('index_state', { repo: world.repo.dir })).indexed, false);
  });

  it('older schema: a store of an older schema holds no index', async (t) => {
    const world = await makeWorld(t);
    await makeStoreFile(gitStoreDir(world), 0);
    assert.equal(dataOf(await world.ask('index_state', { repo: world.repo.dir })).indexed, false);
  });

  it('store.dir store is found: a store under the user override is indexed, and a Host that does not know the override says false', async (t) => {
    const world = await makeWorld(t);
    const storeDir = path.join(world.tmp.path, 'my-stores');
    const withDir = world.anotherHost({ config: { store: { dir: storeDir } } });
    assert.equal((await askOn(withDir, 'build', { repo: world.repo.dir })).ok, true);
    assert.equal(fs.existsSync(gitStoreDir(world)), false, 'the override, not the git directory, holds the store');
    await withDir.closeTenant(await storeIdOf(world.repo));

    const restarted = world.anotherHost({ config: { store: { dir: storeDir } } });
    assert.equal(dataOf(await askOn(restarted, 'index_state', { repo: world.repo.dir })).indexed, true);
    assert.equal(dataOf(await world.ask('index_state', { repo: world.repo.dir })).indexed, false, 'the same rules as the read gate');
  });

  it('cache store is found: a store the location rules put in the cache directory is indexed', async (t) => {
    const world = await makeWorld(t);
    // Something that is not a directory sits where the git-directory store would go, so the rules choose the cache.
    fs.writeFileSync(gitStoreDir(world), 'in the way');
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    assert.equal(fs.existsSync(path.join(world.tmp.path, 'cache', 'gsd-atlas')), true, 'the store is in the cache directory');
    await world.host.closeTenant(await storeIdOf(world.repo));

    const restarted = world.anotherHost();
    assert.equal(dataOf(await askOn(restarted, 'index_state', { repo: world.repo.dir })).indexed, true);
  });

  it('not a repository: not_a_repo', async (t) => {
    const world = await makeWorld(t);
    const outside = path.join(world.tmp.path, 'outside');
    fs.mkdirSync(outside);
    const reply = await world.ask('index_state', { repo: outside });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['not_a_repo']);
  });

  it('arguments are the selection only: an unknown argument is invalid_args', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('index_state', { repo: world.repo.dir, extra: 1 });
    assert.deepEqual(codes(reply), ['invalid_args']);
  });

  it('the same predicate as the read gate: for every store state, indexed is exactly whether code_find is not not_indexed', async (t) => {
    const states: ReadonlyArray<readonly [string, (world: World) => Promise<void>]> = [
      ['unbuilt', () => Promise.resolve()],
      ['empty', (world) => makeStoreFile(gitStoreDir(world))],
      ['older schema', (world) => makeStoreFile(gitStoreDir(world), 0)],
      [
        'built',
        async (world) => {
          assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
          await world.host.closeTenant(await storeIdOf(world.repo));
        },
      ],
    ];
    for (const [label, prepare] of states) {
      const world = await makeWorld(t);
      await prepare(world);
      const host = world.anotherHost();
      const state = await askOn(host, 'index_state', { repo: world.repo.dir });
      const find = await askOn(host, 'code_find', { name: 'helper', repo: world.repo.dir });
      assert.equal(dataOf(state).indexed, !codes(find).includes('not_indexed'), label);
    }
  });

  it('writes nothing: no tenant, no lease, no watcher, and the repository, the cache and the user directory are byte for byte unchanged', async (t) => {
    const unbuilt = await makeWorld(t);
    const before = snapshot(unbuilt);
    assert.equal((await unbuilt.ask('index_state', { repo: unbuilt.repo.dir })).ok, true);
    assert.deepEqual(snapshot(unbuilt), before);
    assert.equal(fs.existsSync(gitStoreDir(unbuilt)), false, 'no store directory appeared');

    const built = await makeWorld(t);
    assert.equal((await built.ask('build', { repo: built.repo.dir })).ok, true);
    await built.host.closeTenant(await storeIdOf(built.repo));
    const restarted = built.anotherHost();
    const storeBefore = fingerprint(gitStoreDir(built)).filter((entry) => !entry.startsWith('facts.db-shm|') && !entry.startsWith('facts.db-wal|0|'));
    const treeBefore = fingerprint(built.repo.dir).filter((entry) => !entry.startsWith('.git/gsd-atlas'));
    assert.equal(dataOf(await askOn(restarted, 'index_state', { repo: built.repo.dir })).indexed, true);
    assert.equal(fs.existsSync(path.join(gitStoreDir(built), 'lease.json')), false, 'no lease.json: nothing took the writer lease');
    assert.deepEqual(
      fingerprint(gitStoreDir(built)).filter((entry) => !entry.startsWith('facts.db-shm|') && !entry.startsWith('facts.db-wal|0|')),
      storeBefore,
      'the store is untouched',
    );
    assert.deepEqual(fingerprint(built.repo.dir).filter((entry) => !entry.startsWith('.git/gsd-atlas')), treeBefore);
    assert.equal(built.manual.subscriptions(), 0, 'nothing is watched');

    // No tenant holds the lease, so a Host that now builds is the leader.
    const rebuilt = await askOn(restarted, 'build', { repo: built.repo.dir });
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.diagnostics));
  });

  it('is not an MCP tool: the six-tool profile of QRY-06 does not list it', () => {
    assert.equal(TOOL_NAMES.length, 6);
    assert.ok(!(TOOL_NAMES as readonly string[]).includes('index_state'));
  });
});
