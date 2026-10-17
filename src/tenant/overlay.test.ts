import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createRealRunner } from '../command-runner/index.ts';
import type { FactStore, Reader } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import type { Clock, Envelope } from '../facts/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createModuleHost } from '../indexer/index.ts';
import type { ExtractOutcome, ModuleHost } from '../indexer/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { FakeClock } from '../test-kit/index.ts';
import { THREE_FILES, buildOk, captureStore, find, makeTenantWorld, toyModules } from './harness.test.ts';
import type { StoreCapture, TenantWorld } from './harness.test.ts';
import { createFollowerFresh } from './index.ts';
import type { Tenant } from './index.ts';

const has = (reply: { readonly degraded?: readonly string[] }, code: string): boolean => reply.degraded?.includes(code) ?? false;
const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);
const resultsOf = (reply: Envelope): Array<{ name: string; path: string; line: number; citation: string }> =>
  (reply.data as { results: Array<{ name: string; path: string; line: number; citation: string }> }).results;

/** A repository a leader has built, and a second tenant over it that is a follower. */
async function leaderAndFollower(t: TestContext): Promise<{ world: TenantWorld; leader: Tenant; follower: Tenant; capture: StoreCapture }> {
  const world = await makeTenantWorld(t);
  const leader = await world.open();
  await buildOk(leader, world.repo);
  const capture = captureStore();
  const follower = await world.open({ openStore: capture.open });
  assert.equal((await follower.status()).leader, false, 'the second tenant is a follower');
  return { world, leader, follower, capture };
}

/** Sizes and modification times of the store's files that a follower must never touch (not the Metrics database, not the wal-index). */
function storeSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.startsWith('metrics.db') && !entry.name.endsWith('-shm')) {
        const stat = fs.statSync(full);
        out[path.relative(dir, full)] = `${String(stat.size)}:${String(stat.mtimeMs)}`;
      }
    }
  };
  walk(dir);
  return out;
}

interface Direct {
  readonly store: FactStore;
  readonly tree: SourceTree;
  readonly modules: ModuleHost;
  readonly repoName: string;
  port(overrides?: Partial<Parameters<typeof createFollowerFresh>[0]>): ReturnType<typeof createFollowerFresh>;
}

/** The follower fresh port wired by hand, over the store of a real follower tenant, so a test can change one dependency. */
function direct(t: TestContext, world: TenantWorld, capture: StoreCapture): Direct {
  const store = capture.store();
  assert.ok(store, 'the follower opened a store');
  const engine = createGrammarEngine();
  t.after(async () => {
    await engine.dispose();
  });
  const modules = createModuleHost({
    engine,
    roots: { repoRoot: world.repo.dir, userDir: path.join(world.tmp.path, 'user'), builtinDir: toyModules, npmRoots: [] },
  });
  t.after(async () => {
    await modules.dispose();
  });
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: world.repo.dir, envOverlay: world.repo.envOverlay });
  const repoName = path.basename(path.resolve(world.storeDir));
  return {
    store,
    tree,
    modules,
    repoName,
    port: (overrides = {}) =>
      createFollowerFresh({ tree, modules, store, clock: systemClock, maxRaceRetries: 3, repo: repoName, ...overrides }),
  };
}

const write = (world: TenantWorld, rel: string, text: string): void => {
  fs.writeFileSync(path.join(world.repo.dir, rel), text);
};

describe('follower overlay: find through fresh paths (D-03, STO-08, IDX-04)', () => {
  it('tracer: a definition added to a file the leader has not indexed is found, with a citation, fenced text and degraded follower', async (t) => {
    const { world, follower } = await leaderAndFollower(t);
    const dir = world.repo.dir;
    // One request first, so the follower's connections and the wal-index have settled before the snapshot.
    await follower.handle(find('helper', dir), dir);
    write(world, 'a.toy', `${THREE_FILES['a.toy'] ?? ''}fn freshFn {\n}\n`);
    const before = storeSnapshot(world.storeDir);

    const found = await follower.handle(find('freshFn', dir, { fresh: ['a.toy'] }), dir);

    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    const results = resultsOf(found);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.name, 'freshFn');
    assert.equal(results[0]?.path, 'a.toy');
    assert.equal(results[0]?.line, 6, 'the 1-based line of the new definition');
    assert.equal(found.citations?.length, 1);
    assert.match(found.untrusted_text?.entries[0]?.text ?? '', /fn freshFn/);
    assert.ok(has(found, 'follower'));
    assert.equal(has(found, 'fresh_timeout'), false);

    // The same files with the same sizes and times: the database, the wal, the lease, and no new sentinel appeared.
    assert.deepEqual(storeSnapshot(world.storeDir), before, 'the shared store was not touched');
    assert.ok(Object.keys(before).some((name) => name.endsWith('.db')), 'the snapshot covers the database file');
  });

  it('without fresh the store does not know the definition, and no overlay is kept for the next request', async (t) => {
    const { world, follower } = await leaderAndFollower(t);
    const dir = world.repo.dir;
    write(world, 'a.toy', `${THREE_FILES['a.toy'] ?? ''}fn freshFn {\n}\n`);

    assert.equal(resultsOf(await follower.handle(find('freshFn', dir), dir)).length, 0);
    assert.equal(resultsOf(await follower.handle(find('freshFn', dir, { fresh: ['a.toy'] }), dir)).length, 1);
    assert.equal(resultsOf(await follower.handle(find('freshFn', dir), dir)).length, 0, 'the overlay did not outlive its request');
  });

  it('a leader that indexed the same edit gives the same answer as the overlay did (no duplicate record)', async (t) => {
    const { world, leader, follower } = await leaderAndFollower(t);
    const dir = world.repo.dir;
    write(world, 'a.toy', `${THREE_FILES['a.toy'] ?? ''}fn freshFn {\n}\n`);
    const overlay = await follower.handle(find('freshFn', dir, { fresh: ['a.toy'] }), dir);
    assert.equal(resultsOf(overlay).length, 1);

    await buildOk(leader, world.repo);
    const stored = await follower.handle(find('freshFn', dir), dir);
    assert.deepEqual(resultsOf(stored), resultsOf(overlay));
    const both = await follower.handle(find('freshFn', dir, { fresh: ['a.toy'] }), dir);
    assert.deepEqual(resultsOf(both), resultsOf(overlay), 'asking fresh for what the store holds adds nothing');
  });

  it('a deleted file hides its symbols; an unclaimed or binary file hides nothing and reports no error', async (t) => {
    const { world, follower } = await leaderAndFollower(t);
    const dir = world.repo.dir;
    fs.rmSync(path.join(dir, 'c.toy'));

    assert.equal(resultsOf(await follower.handle(find('Widget', dir), dir)).length, 1, 'the store still has it');
    const hidden = await follower.handle(find('Widget', dir, { fresh: ['c.toy'] }), dir);
    assert.equal(hidden.ok, true, JSON.stringify(hidden.diagnostics));
    assert.equal(resultsOf(hidden).length, 0);
    assert.equal(has(hidden, 'fresh_timeout'), false);

    write(world, 'bin.toy', 'fn nope {\n\0\n}\n');
    const quiet = await follower.handle(find('helper', dir, { fresh: ['README.md', 'bin.toy', 'missing.toy'] }), dir);
    assert.equal(quiet.ok, true, JSON.stringify(quiet.diagnostics));
    assert.deepEqual(codes(quiet), []);
    assert.equal(resultsOf(quiet).length, 1);
    assert.equal(has(quiet, 'fresh_timeout'), false);
  });

  it('refuses absolute, dot-dot, NUL and symlink-escaping fresh paths without reading them', async (t) => {
    const { world, follower } = await leaderAndFollower(t);
    const dir = world.repo.dir;
    const outside = path.join(world.tmp.path, 'outside.toy');
    fs.writeFileSync(outside, 'fn leaked {\n}\n');
    fs.symlinkSync(outside, path.join(dir, 'link.toy'));

    for (const bad of [outside, '../outside.toy', 'a\0.toy', 'link.toy']) {
      const reply = await follower.handle(find('leaked', dir, { fresh: [bad] }), dir);
      assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
      assert.ok(codes(reply).includes('invalid_fresh_path'), JSON.stringify(bad));
      assert.equal(resultsOf(reply).length, 0, `${JSON.stringify(bad)} was not read`);
    }
  });
});

describe('follower overlay: the fresh port', () => {
  it('fileFacts equals the extractor output for the on-disk text; symbol returns the new record; old symbols are gone', async (t) => {
    const { world, capture } = await leaderAndFollower(t);
    const d = direct(t, world, capture);
    write(world, 'a.toy', 'fn renamed {\n}\nfn freshFn {\n}\n');
    const hashed = await d.tree.hashPaths(world.repo.dir, ['a.toy']);
    const hash = hashed.files.get('a.toy') ?? '';
    const expected = await d.modules.extract('a.toy', 'fn renamed {\n}\nfn freshFn {\n}\n', hash);
    assert.equal(expected.kind, 'facts');

    const outcome = await d.port().ensureFresh(world.repo.dir, ['a.toy'], 2000);
    assert.equal(outcome.complete, true);
    assert.deepEqual(outcome.stalePaths, []);
    const reader = outcome.reader;
    assert.ok(reader, 'a patched path yields an overlay Reader');

    const facts = (await reader.fileFacts('a.toy')).data;
    assert.deepEqual(facts, expected.kind === 'facts' ? expected.facts : null);
    assert.deepEqual((await reader.fileFacts('b.toy')).data?.path, 'b.toy', 'unpatched paths read through to the store');

    const found = (await reader.find('freshFn')).data;
    assert.equal(found.length, 1);
    const record = found[0];
    assert.ok(record);
    assert.deepEqual((await reader.symbol(record.identity)).data, record);
    assert.equal(record.identity.repo, d.repoName);
    assert.equal(record.confidence, 'EXTRACTED');
    assert.match(record.debug, /^sym\/a\.toy\/[0-9a-f]+\/1$/);

    // The store's old definitions of the patched file no longer appear, in any mode.
    assert.equal((await reader.find('main')).data.length, 0);
    assert.equal((await reader.find('mai', { mode: 'prefix' })).data.length, 0);
    assert.equal((await reader.find('boo', { mode: 'fuzzy' })).data.length, 0);
    assert.equal((await reader.find('renamed')).data.length, 1);
    assert.deepEqual((await reader.find('fresh', { mode: 'prefix' })).data.map((r) => r.identity.qualifiedName), ['freshFn']);
    assert.deepEqual((await reader.find('RESHF', { mode: 'fuzzy' })).data.map((r) => r.identity.qualifiedName), ['freshFn']);
    assert.deepEqual((await reader.find('helper')).data.map((r) => r.source_path), ['b.toy'], 'other files are the store\'s');
    assert.equal((await reader.find('')).data.length, 0);
  });

  it('a parse failure leaves that path stale and the other path in the overlay', async (t) => {
    const { world, capture } = await leaderAndFollower(t);
    const d = direct(t, world, capture);
    write(world, 'x.toy', 'fn xx {\n}\n');
    write(world, 'y.toy', 'fn yy {\n}\n');
    const failing: ModuleHost = {
      extensions: () => d.modules.extensions(),
      extract: (rel, text, hash): Promise<ExtractOutcome> =>
        rel === 'x.toy' ? Promise.resolve({ kind: 'failed', code: 'parse_timeout' }) : d.modules.extract(rel, text, hash),
      dispose: () => Promise.resolve(),
    };

    const outcome = await d.port({ modules: failing }).ensureFresh(world.repo.dir, ['x.toy', 'y.toy'], 2000);

    assert.equal(outcome.complete, false);
    assert.deepEqual(outcome.stalePaths, ['x.toy']);
    assert.deepEqual(outcome.invalid, []);
    assert.equal((await outcome.reader?.find('yy'))?.data.length, 1);
    assert.equal((await outcome.reader?.find('xx'))?.data.length, 0);
  });

  it('a file that changes while it is read is read again; one that never settles is stale and left out', async (t) => {
    const { world, capture } = await leaderAndFollower(t);
    const d = direct(t, world, capture);
    write(world, 'a.toy', 'fn first {\n}\n');
    let changes = 0;
    const changing = (times: number): SourceTree => ({
      ...d.tree,
      readText: async (worktree, rel, options) => {
        const read = await d.tree.readText(worktree, rel, options);
        if (rel === 'a.toy' && changes < times) {
          changes += 1;
          fs.appendFileSync(path.join(worktree, rel), `// edit ${String(changes)}\n`);
        }
        return read;
      },
    });

    const settles = await d.port({ tree: changing(2), maxRaceRetries: 3 }).ensureFresh(world.repo.dir, ['a.toy'], 2000);
    assert.equal(settles.complete, true, 'settled within the configured attempts');
    assert.equal(changes, 2);
    assert.equal((await settles.reader?.find('first'))?.data.length, 1);

    const never = await d.port({ tree: changing(Number.POSITIVE_INFINITY), maxRaceRetries: 2 }).ensureFresh(world.repo.dir, ['a.toy'], 2000);
    assert.equal(never.complete, false);
    assert.deepEqual(never.stalePaths, ['a.toy']);
    assert.equal(never.reader, undefined, 'a path that never settled is left out of the overlay');
  });

  it('a parse that does not finish within the wait is reported stale; the work that follows cannot change the answer', async (t) => {
    const { world, capture } = await leaderAndFollower(t);
    const d = direct(t, world, capture);
    write(world, 'a.toy', 'fn slow {\n}\n');
    const fake = new FakeClock(1_000_000);
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ModuleHost = {
      extensions: () => d.modules.extensions(),
      extract: async (rel, text, hash) => {
        await hold;
        return d.modules.extract(rel, text, hash);
      },
      dispose: () => Promise.resolve(),
    };
    const clock: Clock = fake;

    const pending = d.port({ modules: slow, clock }).ensureFresh(world.repo.dir, ['a.toy'], 2000);
    await new Promise((resolve) => setImmediate(resolve));
    await fake.advance(2000);
    const outcome = await pending;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(outcome.complete, false);
    assert.deepEqual(outcome.stalePaths, ['a.toy']);
    assert.equal(outcome.reader, undefined);
  });

  it('is read only: it asks the store for readers and nothing else', async (t) => {
    const { world, capture } = await leaderAndFollower(t);
    const d = direct(t, world, capture);
    write(world, 'a.toy', 'fn freshFn {\n}\n');
    const asked: string[] = [];
    const readOnly: Pick<FactStore, 'at'> = {
      at: (worktree): Reader => {
        asked.push(worktree);
        return d.store.at(worktree);
      },
    };
    const outcome = await d.port({ store: readOnly }).ensureFresh(world.repo.dir, ['a.toy'], 2000);
    assert.equal(outcome.complete, true);
    assert.deepEqual([...new Set(asked)], [world.repo.dir]);
  });
});
