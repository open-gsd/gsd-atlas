import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { FactStore, Reader, Resolver } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import type { Clock, Envelope, FileFacts, ImportBinding, RefKind } from '../facts/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createModuleHost } from '../indexer/index.ts';
import type { ExtractOutcome, ModuleHost } from '../indexer/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { THREE_FILES, buildOk, captureStore, find, makeTenantWorld, toyModules } from './harness.test.ts';
import type { StoreCapture, TenantWorld } from './harness.test.ts';
import { createFollowerFresh, createOverlayReader } from './index.ts';
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
    // The clock moves only once the parse is the thing still outstanding, and the test waits for the abandoned parse to
    // finish before it ends. Without both, the hashing git process of a slow Windows runner was still running in the
    // repository when the test removed it (EPERM, found by plan 02-26 on Windows CI).
    let reached: () => void = () => {};
    const extractReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let finished: () => void = () => {};
    const extractFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const slow: ModuleHost = {
      extensions: () => d.modules.extensions(),
      extract: async (rel, text, hash) => {
        reached();
        await hold;
        try {
          return await d.modules.extract(rel, text, hash);
        } finally {
          finished();
        }
      },
      dispose: () => Promise.resolve(),
    };
    const clock: Clock = fake;

    const pending = d.port({ modules: slow, clock }).ensureFresh(world.repo.dir, ['a.toy'], 2000);
    await extractReached;
    await fake.advance(2000);
    const outcome = await pending;
    release();
    await extractFinished;
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

// ---------------------------------------------------------------------------------------------------------
// The merge itself, over a real store holding hand-made facts.
// ---------------------------------------------------------------------------------------------------------

interface SymbolSpec {
  readonly name: string;
  readonly line: number;
  readonly exported?: boolean;
  readonly parent?: number;
}
interface RefSpec {
  readonly name: string;
  readonly line: number;
  readonly kind?: RefKind;
  readonly enclosing?: number;
}
interface ImportSpec {
  readonly path: string;
  readonly line: number;
  readonly bindings?: readonly ImportBinding[];
}
interface FactsSpec {
  readonly symbols?: readonly SymbolSpec[];
  readonly refs?: readonly RefSpec[];
  readonly imports?: readonly ImportSpec[];
}

const noResolver: Resolver = async function* () {
  // resolves nothing
};

/** Hand-made facts of `filePath` (module `typescript`, as the store's own tests make them); the hash is `hash`. */
function factsOf(filePath: string, hash: string, spec: FactsSpec = {}): FileFacts {
  return {
    path: filePath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: (spec.symbols ?? []).map((symbol) => ({
      name: symbol.name,
      kind: 'function',
      span: { startLine: symbol.line, startColumn: 0, endLine: symbol.line, endColumn: symbol.name.length },
      ...(symbol.exported === undefined ? {} : { exported: symbol.exported }),
      ...(symbol.parent === undefined ? {} : { parent: symbol.parent }),
    })),
    refSites: (spec.refs ?? []).map((ref) => ({
      name: ref.name,
      span: { startLine: ref.line, startColumn: 2, endLine: ref.line, endColumn: 2 + ref.name.length },
      ...(ref.kind === undefined ? {} : { kind: ref.kind }),
      ...(ref.enclosing === undefined ? {} : { enclosing: ref.enclosing }),
    })),
    imports: (spec.imports ?? []).map((imp) => ({
      path: imp.path,
      span: { startLine: imp.line, startColumn: 0, endLine: imp.line, endColumn: 20 },
      style: 'es' as const,
      ...(imp.bindings === undefined ? {} : { bindings: imp.bindings }),
    })),
    exports: [],
    parse: { errorBytes: 0, totalBytes: 0 },
  };
}

const WT = '/worktree';
const CLAIMED = ['.ts'];

interface Seeded {
  readonly store: FactStore;
  readonly base: Reader;
  readonly clock: FakeClock;
  /** An overlay Reader over the seeded store with `patch` laid over it. */
  overlay(patch: ReadonlyMap<string, FileFacts | null>): Reader;
}

async function seeded(t: TestContext, files: readonly FileFacts[]): Promise<Seeded> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const store = await openFactStore(
    path.join(tmp.path, 'store'),
    { resolver: noResolver, clock, gitHas: () => Promise.resolve(true) },
    { repo: 'toy', version: 'test' },
  );
  const writer = store.writer();
  t.after(async () => {
    writer.release();
    await store.close();
    tmp.cleanup();
  });
  for (const facts of files) {
    const committed = await writer.commitFile({ worktree: WT, path: facts.path, hash: facts.contentHash, facts });
    assert.notEqual(committed.status, 'rejected', facts.path);
  }
  const base = store.at(WT);
  return {
    store,
    base,
    clock,
    overlay: (patch) => createOverlayReader(base, patch, { repo: 'toy', clock: new FakeClock(5000), extensions: CLAIMED }),
  };
}

const idOf = (filePath: string, name: string) => ({ repo: 'toy', path: filePath, qualifiedName: name, kind: 'function' });
const run = [{ imported: 'run', local: 'run' }] as const;

/** Provenance times are the clock's at read time and differ between the store and the overlay; everything else must not. */
const plain = <T extends { readonly first_seen: number; readonly last_seen: number }>(record: T): Omit<T, 'first_seen' | 'last_seen'> => {
  const { first_seen: _first, last_seen: _last, ...rest } = record;
  return rest;
};

/** The store: `main` and `other` import `run` from `./b` and call it; `deep` calls `other`. */
const storeFiles = (): FileFacts[] => [
  factsOf('src/b.ts', 'b1', { symbols: [{ name: 'run', line: 0, exported: true }, { name: 'helper', line: 4, exported: true }] }),
  factsOf('src/main.ts', 'm1', {
    symbols: [{ name: 'main', line: 2 }],
    imports: [{ path: './b', line: 0, bindings: run }],
    refs: [{ name: 'run', line: 5, kind: 'call', enclosing: 0 }],
  }),
  factsOf('src/other.ts', 'o1', {
    symbols: [{ name: 'other', line: 2 }],
    imports: [{ path: './b', line: 0, bindings: run }],
    refs: [{ name: 'run', line: 3, kind: 'call', enclosing: 0 }],
  }),
  factsOf('src/deep.ts', 'd1', {
    symbols: [{ name: 'deep', line: 2 }],
    imports: [{ path: './other', line: 0, bindings: [{ imported: 'other', local: 'other' }] }],
    refs: [{ name: 'other', line: 3, kind: 'call', enclosing: 0 }],
  }),
];

describe('follower overlay: merged refs', () => {
  it('merged refs: the patched file\'s new site joins the store\'s other sites and its old sites are gone', async (t) => {
    const s = await seeded(t, storeFiles());
    const patched = factsOf('src/main.ts', 'm2', {
      symbols: [{ name: 'main', line: 2 }, { name: 'loader', line: 8 }],
      imports: [{ path: './b', line: 0, bindings: run }],
      refs: [
        { name: 'run', line: 9, kind: 'call', enclosing: 1 },
        { name: 'run', line: 12, kind: 'call', enclosing: 0 },
      ],
    });
    const reader = s.overlay(new Map([['src/main.ts', patched]]));
    const target = idOf('src/b.ts', 'run');

    const stored = (await s.base.refs(target)).data;
    assert.deepEqual(stored.map((r) => [r.source_path, r.span.startLine]), [['src/main.ts', 5], ['src/other.ts', 3]]);

    const merged = (await reader.refs(target)).data;
    assert.deepEqual(merged.map((r) => [r.source_path, r.span.startLine]), [['src/main.ts', 9], ['src/main.ts', 12], ['src/other.ts', 3]]);
    const added = merged[0];
    assert.ok(added);
    assert.equal(added.tier, 'grammar');
    assert.equal(added.confidence, 'INFERRED');
    assert.equal(added.kind, 'call');
    assert.equal(added.extractor, 'grammar:typescript@0.23.2');
    assert.equal(added.content_hash, 'm2');
    assert.equal(added.first_seen, 5000);
    assert.equal(added.last_seen, 5000);
    assert.equal(added.debug, 'ref/src%2Fmain.ts/m2/0');
    assert.deepEqual(added.target, target);
    assert.deepEqual(added.site, { path: 'src/main.ts', span: added.span, name: 'run' });
    assert.deepEqual(added.enclosing, idOf('src/main.ts', 'loader'));
    assert.deepEqual(merged[1]?.enclosing, idOf('src/main.ts', 'main'));
    assert.equal(merged[2]?.debug, stored[1]?.debug, 'the store\'s own records pass through unchanged');
    const answer = await reader.refs(target);
    assert.ok(answer.degraded?.includes('follower'));
  });

  it('a patched same-file definition and reference pair works with no import', async (t) => {
    const s = await seeded(t, storeFiles());
    const solo = factsOf('src/solo.ts', 's1', {
      symbols: [{ name: 'solo', line: 0 }, { name: 'caller', line: 3 }],
      refs: [{ name: 'solo', line: 4, kind: 'call', enclosing: 1 }],
    });
    const reader = s.overlay(new Map([['src/solo.ts', solo]]));

    const refs = (await reader.refs(idOf('src/solo.ts', 'solo'))).data;
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.span.startLine, 4);
    assert.deepEqual(refs[0]?.enclosing, idOf('src/solo.ts', 'caller'));
    assert.equal((await s.base.refs(idOf('src/solo.ts', 'solo'))).data.length, 0, 'the store alone knows nothing of it');
  });

  it('not in scope: a name with no import, and a binding from a path that exists nowhere, yield no record', async (t) => {
    const s = await seeded(t, storeFiles());
    const noimport = factsOf('src/noimport.ts', 'n1', {
      symbols: [{ name: 'f', line: 0 }],
      refs: [{ name: 'run', line: 1, kind: 'call', enclosing: 0 }],
    });
    const ghost = factsOf('src/ghost.ts', 'g1', {
      symbols: [{ name: 'g', line: 1 }],
      imports: [{ path: './nowhere', line: 0, bindings: run }],
      refs: [{ name: 'run', line: 2, kind: 'call', enclosing: 0 }],
    });
    const reader = s.overlay(new Map([['src/noimport.ts', noimport], ['src/ghost.ts', ghost]]));

    const refs = (await reader.refs(idOf('src/b.ts', 'run'))).data;
    assert.deepEqual(refs.map((r) => r.source_path), ['src/main.ts', 'src/other.ts']);
  });

  it('a deleted file\'s sites disappear, and the references to a definition the patch removed are gone', async (t) => {
    const s = await seeded(t, storeFiles());
    const reader = s.overlay(new Map<string, FileFacts | null>([['src/other.ts', null]]));
    assert.deepEqual((await reader.refs(idOf('src/b.ts', 'run'))).data.map((r) => r.source_path), ['src/main.ts']);
    assert.deepEqual((await reader.refs(idOf('src/other.ts', 'other'))).data, []);
    assert.equal((await reader.find('other')).data.length, 0);
    assert.equal((await reader.symbol(idOf('src/other.ts', 'other'))).data, null);
    assert.equal((await reader.fileFacts('src/other.ts')).data, null);
  });
});

describe('follower overlay: merged callers', () => {
  /** `parse` is called by nobody in the store; `boot` (app.ts) calls `load` (l.ts), which `parse` (p.ts) calls back. */
  const files = (): FileFacts[] => [
    factsOf('src/p.ts', 'p1', {
      symbols: [{ name: 'parse', line: 0, exported: true }],
      imports: [{ path: './l', line: 1, bindings: [{ imported: 'load', local: 'load' }] }],
      refs: [{ name: 'load', line: 2, kind: 'call', enclosing: 0 }],
    }),
    factsOf('src/l.ts', 'l1', { symbols: [{ name: 'load', line: 0, exported: true }] }),
    factsOf('src/app.ts', 'a1', {
      symbols: [{ name: 'boot', line: 3 }],
      imports: [{ path: './l', line: 0, bindings: [{ imported: 'load', local: 'load' }] }],
      refs: [{ name: 'load', line: 4, kind: 'call', enclosing: 0 }],
    }),
  ];
  const patchedLoader = (): FileFacts =>
    factsOf('src/l.ts', 'l2', {
      symbols: [{ name: 'load', line: 0, exported: true }],
      imports: [{ path: './p', line: 1, bindings: [{ imported: 'parse', local: 'parse' }] }],
      refs: [{ name: 'parse', line: 2, kind: 'call', enclosing: 0 }],
    });

  it('merged callers: a new caller is hop 1, the store\'s caller of it is hop 2, and the cycle ends', async (t) => {
    const s = await seeded(t, files());
    const reader = s.overlay(new Map([['src/l.ts', patchedLoader()]]));
    const parse = idOf('src/p.ts', 'parse');

    assert.deepEqual((await s.base.callers(parse, { hops: 3 })).data, [], 'the store alone has no caller of parse');

    const callers = (await reader.callers(parse, { hops: 3 })).data;
    assert.deepEqual(
      callers.map((c) => [c.hops, c.caller.qualifiedName, c.callee.qualifiedName, c.source_path]),
      [
        [1, 'load', 'parse', 'src/l.ts'],
        [2, 'boot', 'load', 'src/app.ts'],
      ],
    );
    assert.equal(callers[0]?.tier, 'grammar');
    assert.equal(callers[0]?.confidence, 'INFERRED');
    assert.equal(callers[0]?.debug, 'ref/src%2Fl.ts/l2/0');
    assert.equal(callers[1]?.debug, (await s.base.refs(idOf('src/l.ts', 'load'))).data.find((r) => r.source_path === 'src/app.ts')?.debug);

    const oneHop = (await reader.callers(parse)).data;
    assert.deepEqual(oneHop.map((c) => c.caller.qualifiedName), ['load']);
  });

  it('walks no deeper than the store does, and a chain gives the same callers as the store when nothing is patched', async (t) => {
    const names = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    const chain = factsOf('src/chain.ts', 'ch1', {
      symbols: names.map((name, line) => ({ name, line: line * 2 })),
      refs: names.slice(1).map((name, index) => ({ name: names[index] ?? '', line: index * 2 + 3, kind: 'call' as const, enclosing: index + 1 })),
    });
    const s = await seeded(t, [chain]);
    const reader = s.overlay(new Map([['src/unrelated.ts', factsOf('src/unrelated.ts', 'u1', { symbols: [{ name: 'u', line: 0 }] })]]));
    const target = idOf('src/chain.ts', 'c0');

    const stored = (await s.base.callers(target, { hops: 99 })).data;
    const merged = (await reader.callers(target, { hops: 99 })).data;
    assert.equal(Math.max(...stored.map((c) => c.hops)), 5, 'the store stops at five hops');
    assert.deepEqual(merged.map(plain), stored.map(plain));
    assert.deepEqual((await reader.callers(target, { hops: 0 })).data.map((c) => c.hops), [1], 'a hop count below one is one');
    assert.deepEqual((await reader.callers(target, { hops: Number.NaN })).data.map((c) => c.hops), [1]);
  });
});

describe('follower overlay: merged importers', () => {
  /** x and y import a; z imports x; q imports w, which imports nothing yet. */
  const files = (): FileFacts[] => [
    factsOf('src/a.ts', 'a1', { symbols: [{ name: 'a', line: 0 }] }),
    factsOf('src/x.ts', 'x1', { symbols: [{ name: 'x', line: 1 }], imports: [{ path: './a', line: 0 }] }),
    factsOf('src/y.ts', 'y1', { symbols: [{ name: 'y', line: 1 }], imports: [{ path: './a', line: 0 }] }),
    factsOf('src/z.ts', 'z1', { symbols: [{ name: 'z', line: 1 }], imports: [{ path: './x', line: 0 }] }),
    factsOf('src/w.ts', 'w1', { symbols: [{ name: 'w', line: 1 }] }),
    factsOf('src/q.ts', 'q1', { symbols: [{ name: 'q', line: 1 }], imports: [{ path: './w', line: 0 }] }),
  ];

  it('merged importers: a file that newly imports the target is hop 1, one that no longer does is gone, the store\'s others stay', async (t) => {
    const s = await seeded(t, files());
    const w = factsOf('src/w.ts', 'w2', { symbols: [{ name: 'w', line: 1 }], imports: [{ path: './a', line: 0 }] });
    const x = factsOf('src/x.ts', 'x2', { symbols: [{ name: 'x', line: 1 }], imports: [{ path: './elsewhere', line: 0 }] });
    const reader = s.overlay(new Map([['src/w.ts', w], ['src/x.ts', x]]));

    const stored = (await s.base.importers('src/a.ts')).data;
    assert.deepEqual(stored.map((r) => r.importer), ['src/x.ts', 'src/y.ts']);

    const merged = (await reader.importers('src/a.ts')).data;
    assert.deepEqual(merged.map((r) => [r.importer, r.hops]), [['src/w.ts', 1], ['src/y.ts', 1]]);
    const added = merged[0];
    assert.ok(added);
    assert.equal(added.confidence, 'EXTRACTED', 'one candidate names the target');
    assert.equal(added.specifier, './a');
    assert.equal(added.style, 'es');
    assert.equal(added.debug, 'imp/src%2Fw.ts/w2/0');
    assert.equal(added.extractor, 'grammar:typescript@0.23.2');
    assert.equal(added.first_seen, 5000);
    assert.deepEqual(plain(merged[1] as NonNullable<(typeof merged)[number]>), plain(stored[1] as NonNullable<(typeof stored)[number]>));

    // The file that newly imports it brings the store's importers of that file along at hop 2; x is no hop-1 file.
    const deep = (await reader.importers('src/a.ts', { depth: 2 })).data;
    assert.deepEqual(deep.map((r) => [r.importer, r.hops]), [['src/w.ts', 1], ['src/y.ts', 1], ['src/q.ts', 2]]);
    assert.deepEqual((await reader.importers('src/a.ts', { depth: 2, limit: 1 })).data.map((r) => r.importer), ['src/w.ts']);
  });

  it('a specifier that names several files is INFERRED for the patched importer, EXTRACTED when written with its extension', async (t) => {
    const s = await seeded(t, [...files(), factsOf('src/a/index.ts', 'ai1', { symbols: [{ name: 'idx', line: 0 }] })]);
    const w = factsOf('src/w.ts', 'w2', { imports: [{ path: './a', line: 0 }] });
    const v = factsOf('src/v.ts', 'v1', { imports: [{ path: './a.ts', line: 0 }] });
    const reader = s.overlay(new Map([['src/w.ts', w], ['src/v.ts', v]]));

    const merged = (await reader.importers('src/a.ts')).data;
    assert.deepEqual(
      merged.map((r) => [r.importer, r.confidence]),
      [['src/v.ts', 'EXTRACTED'], ['src/w.ts', 'INFERRED'], ['src/x.ts', 'INFERRED'], ['src/y.ts', 'INFERRED']],
    );
  });

  it('a deleted importer is gone', async (t) => {
    const s = await seeded(t, files());
    const reader = s.overlay(new Map<string, FileFacts | null>([['src/y.ts', null]]));
    assert.deepEqual((await reader.importers('src/a.ts')).data.map((r) => r.importer), ['src/x.ts']);
  });
});

describe('follower overlay: adjacency', () => {
  it('adjacency: when the store already holds the edit, find, refs and importers return each record once, as the store does', async (t) => {
    const files = storeFiles();
    const s = await seeded(t, files);
    const sameMain = files.find((facts) => facts.path === 'src/main.ts');
    assert.ok(sameMain);
    const reader = s.overlay(new Map([['src/main.ts', sameMain]]));
    const target = idOf('src/b.ts', 'run');

    assert.deepEqual((await reader.find('main')).data.map(plain), (await s.base.find('main')).data.map(plain));
    assert.deepEqual((await reader.refs(target)).data.map(plain), (await s.base.refs(target)).data.map(plain));
    assert.deepEqual((await reader.importers('src/b.ts')).data.map(plain), (await s.base.importers('src/b.ts')).data.map(plain));
    assert.deepEqual((await reader.callers(idOf('src/b.ts', 'run'))).data.map(plain), (await s.base.callers(idOf('src/b.ts', 'run'))).data.map(plain));
    assert.deepEqual((await reader.fileFacts('src/main.ts')).data, (await s.base.fileFacts('src/main.ts')).data);
    assert.deepEqual((await reader.symbol(idOf('src/main.ts', 'main'))).data?.debug, (await s.base.symbol(idOf('src/main.ts', 'main'))).data?.debug);
  });

  it('every merged record has the store\'s provenance fields and a debug handle in the store\'s format', async (t) => {
    const s = await seeded(t, storeFiles());
    const patched = factsOf('src/main.ts', 'm2', {
      symbols: [{ name: 'main', line: 2 }],
      imports: [{ path: './b', line: 0, bindings: run }],
      refs: [{ name: 'run', line: 9, kind: 'call', enclosing: 0 }],
    });
    const reader = s.overlay(new Map([['src/main.ts', patched]]));
    const records = [
      ...(await reader.find('main')).data,
      ...(await reader.refs(idOf('src/b.ts', 'run'))).data,
      ...(await reader.importers('src/b.ts')).data,
    ];
    const stored = [
      ...(await s.base.find('helper')).data,
      ...(await s.base.refs(idOf('src/b.ts', 'run'))).data,
      ...(await s.base.importers('src/b.ts')).data,
    ];
    for (const record of [...records, ...stored]) {
      assert.deepEqual(Object.keys(record).filter((key) => key === 'debug' || key === 'extractor' || key === 'content_hash' || key === 'first_seen' || key === 'last_seen' || key === 'confidence' || key === 'span' || key === 'source_path').sort(),
        ['confidence', 'content_hash', 'debug', 'extractor', 'first_seen', 'last_seen', 'source_path', 'span']);
      assert.match(record.debug, /^(sym|ref|imp)\/[^/]+\/[0-9a-z]+\/\d+$/);
    }
  });
});
