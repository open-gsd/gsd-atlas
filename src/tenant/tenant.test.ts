import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { Resolver } from '../fact-store/index.ts';
import { PROTOCOL_VERSION, ResolverFailure, diagnostic, systemClock } from '../facts/index.ts';
import type { Envelope, RefSiteKey } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import { CITATION_COMMENT_TOO_LONG, createGrammarEngine } from '../grammar-engine/index.ts';
import { createManualEventSource } from '../indexer/index.ts';
import type { BuildResult, Indexer, IndexerDeps, ManualEventSource } from '../indexer/index.ts';
import type { PreciseTier } from '../precise-resolver/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { scriptedIndexers } from './harness.test.ts';
import { createTenant } from './index.ts';
import type { Tenant, TenantDeps } from './index.ts';
import { BUILD_NOTE_CODES, buildNotes } from './messages.ts';

const toyModules = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

/** A store without a precise resolver: it resolves nothing. */
const noPreciseTier: Resolver = async function* () {
  // resolves nothing
};

const THREE_FILES: Readonly<Record<string, string>> = {
  'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'c.toy': 'type Widget {\n}\n',
  'README.md': '# toy repository\n',
};

interface Setup {
  readonly repo: TempGitRepo;
  readonly manual: ManualEventSource;
  /** Open one more tenant over the same repository (another process, for lease tests). */
  open(overrides?: Partial<TenantDeps>): Promise<Tenant>;
}

async function setup(t: TestContext, files: Readonly<Record<string, string>> = THREE_FILES): Promise<Setup> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: files } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  const manual = createManualEventSource();
  const tenants: Tenant[] = [];
  const open = async (overrides: Partial<TenantDeps> = {}): Promise<Tenant> => {
    const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
    const tenant = await createTenant({
      tree,
      identity: await tree.identity(),
      repoDir: repo.dir,
      roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: toyModules, npmRoots: [] },
      engine,
      governor: createGovernor({ clock: systemClock }),
      clock: systemClock,
      cacheRoot: path.join(tmp.path, 'cache'),
      eventSource: () => manual.source,
      ...overrides,
    });
    tenants.push(tenant);
    return tenant;
  };
  t.after(async () => {
    for (const each of tenants) await each.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  return { repo, manual, open };
}

const find = (name: string, repo: string) => ({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name, repo } });

describe('createTenant', () => {
  it('puts the store under the git common directory, keyed by the repository', async (t) => {
    const { repo, open } = await setup(t);
    const tenant = await open();
    assert.equal(tenant.location.kind, 'git-common');
    assert.equal(tenant.location.dir, path.join(repo.dir, '.git', 'gsd-atlas'));
    assert.match(tenant.storeId, /^[0-9a-f]{16}$/);
  });

  it('builds a worktree, then answers code_find from the store it built', async (t) => {
    const { repo, open } = await setup(t);
    const tenant = await open();
    const before = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.deepEqual(
      before.diagnostics.map((d) => d.code),
      ['not_indexed'],
    );

    const built = await tenant.build(repo.dir);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal((built.data as { parsed: number }).parsed, 3);

    const found = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as { results: unknown[] }).results.length, 1);
  });

  it('reports the lease and the Indexer in its status after a build', async (t) => {
    const { repo, open } = await setup(t);
    const tenant = await open();
    const idle = await tenant.status();
    assert.equal(idle.leader, true);
    assert.equal(idle.indexer, null, 'no Indexer exists before something needs one');

    await tenant.build(repo.dir);
    const after = await tenant.status();
    assert.equal(after.store.worktrees.length, 1);
    assert.equal(after.indexer?.watchMode, 'native');
  });

  it('close releases the lease: a tenant opened afterwards on the same repository is the leader', async (t) => {
    const { repo, open } = await setup(t);
    const first = await open();
    await first.build(repo.dir);
    assert.equal((await first.status()).leader, true);
    const second = await open();
    assert.equal((await second.status()).leader, false, 'the first tenant still holds the lease');
    await first.close();
    await first.close();
    const third = await open();
    assert.equal((await third.status()).leader, true);
  });
});

interface TaskData {
  readonly tasks: Record<string, { complete: boolean; processed: number }>;
}

describe('Tenant.maintain', () => {
  it('refresh re-extracts the files a grammar upgrade marked stale, through Indexer.refresh', async (t) => {
    const { repo, open } = await setup(t);
    const first = await open();
    await first.build(repo.dir);
    await first.close();

    // Another process upgrades the toy grammar: every toy file is now stale.
    const store = await openFactStore(
      first.location.dir,
      { resolver: noPreciseTier, clock: systemClock, gitHas: () => Promise.resolve(true) },
      { lease: 'acquire' },
    );
    const writer = store.writer();
    assert.equal(await writer.markStale({ module: 'toy', grammarVersion: 'upgraded' }), 3);
    writer.release();
    await store.close();

    const second = await open();
    const stale = await second.handle(find('helper', repo.dir), repo.dir);
    assert.deepEqual(stale.watermark?.stalePaths, ['a.toy', 'b.toy', 'c.toy']);
    assert.ok(stale.degraded?.includes('stale'));

    const refreshed = await second.maintain('refresh', { worktree: repo.dir });
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed.diagnostics));
    assert.equal((refreshed.data as TaskData).tasks['refresh']?.processed, 3);
    const clean = await second.handle(find('helper', repo.dir), repo.dir);
    assert.deepEqual(clean.watermark?.stalePaths, []);
    assert.equal(clean.degraded?.includes('stale') ?? false, false);
  });

  it('collect, compact and check run while the Indexer holds the writer, in slices of the approved size', async (t) => {
    const { repo, open } = await setup(t);
    const tenant = await open({ tuning: { maintenanceSliceMs: 5 } });
    await tenant.build(repo.dir);
    for (const task of ['collect', 'compact', 'check'] as const) {
      const reply = await tenant.maintain(task, { worktree: repo.dir });
      assert.equal(reply.ok, true, `${task}: ${JSON.stringify(reply.diagnostics)}`);
      assert.equal((reply.data as TaskData).tasks[task]?.complete, true, task);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// The eager pass (plan 03-29): `build` and `maintain resolve` fill the resolved-edge cache before a question asks.
// ---------------------------------------------------------------------------------------------------------

const refsOf = (name: string, repo: string) => ({ protocol: PROTOCOL_VERSION, kind: 'code_refs', args: { name, repo } });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface PreciseTaskData {
  readonly tasks: Record<string, { complete: boolean; processed: number; note?: string; precise?: { asked: number; answered: number; complete: boolean } }>;
}

/** The store's resolver as a test hook: it records every site it is asked about, per call, takes `delayMs` a call and binds nothing. */
function recordingResolver(delayMs = 0): { readonly resolver: NonNullable<TenantDeps['resolverFactory']>; readonly calls: RefSiteKey[][] } {
  const calls: RefSiteKey[][] = [];
  const resolver: NonNullable<TenantDeps['resolverFactory']> = () =>
    async function* (sites) {
      calls.push([...sites]);
      if (delayMs > 0) await sleep(delayMs);
    };
  return { resolver, calls };
}

describe('Tenant: the eager pass in build and maintain resolve', () => {
  it('first refs after build is a cache hit: the build asked about every site once and the read asks the resolver nothing', async (t) => {
    const { repo, open } = await setup(t);
    const { resolver, calls } = recordingResolver();
    const tenant = await open({ resolverFactory: resolver });
    const built = await tenant.build(repo.dir);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    const askedByBuild = calls.length;
    assert.ok(askedByBuild >= 1, 'the build ran the pass');
    const sites = calls.flat();
    assert.ok(sites.length >= 1);
    assert.equal(new Set(sites.map((site) => `${site.path}:${String(site.span.startLine)}:${String(site.span.startColumn)}:${site.name}`)).size, sites.length, 'each site once');

    const read = await tenant.handle(refsOf('boot', repo.dir), repo.dir);
    assert.equal(read.ok, true, JSON.stringify(read.diagnostics));
    assert.equal(calls.length, askedByBuild, 'the read at query time did not reach the resolver');
    assert.equal(read.degraded?.includes('resolver_timeout') ?? false, false);
  });

  it('maintain resolve after a build processes nothing: the build already did the pass', async (t) => {
    const { repo, open } = await setup(t);
    const { resolver, calls } = recordingResolver();
    const tenant = await open({ resolverFactory: resolver });
    await tenant.build(repo.dir);
    const asked = calls.length;
    const reply = await tenant.maintain('resolve', { worktree: repo.dir });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const report = (reply.data as PreciseTaskData).tasks['resolve'];
    assert.equal(report?.complete, true);
    assert.equal(report?.processed, 0);
    assert.equal(report?.precise?.asked, 0);
    assert.equal(report?.precise?.complete, true);
    assert.equal(calls.length, asked);
  });

  it('build with eager pass timeout: the build succeeds, says resolver_timeout in the diagnostics and maintain resolve finishes the pass', async (t) => {
    // Four call sites of `boot` in one file, so a batch of one site leaves work behind.
    const { repo, open } = await setup(t, { ...THREE_FILES, 'a.toy': 'fn main {\n  boot();\n  boot();\n  boot();\n  boot();\n}\nfn boot {\n}\n' });
    const { resolver, calls } = recordingResolver(5);
    // One site per batch and a bound of 1 ms: the first batch runs, the bound is then spent.
    const tenant = await open({ resolverFactory: resolver, tuning: { resolveBoundMs: 1, resolveBatchSites: 1 } });
    const built = await tenant.build(repo.dir);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal((built.data as { parsed: number }).parsed, 3, 'the worktree is indexed');
    const note = built.diagnostics.find((entry) => entry.code === 'resolver_timeout');
    assert.ok(note !== undefined, JSON.stringify(built.diagnostics));
    assert.equal(note.severity, 'info');
    assert.equal(note.subject, undefined);
    assert.equal(built.degraded, undefined, 'a build sets no degraded code');
    assert.equal(calls.length, 1, 'one batch was asked before the bound ran out');

    const found = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(found.ok, true);

    const reply = await tenant.maintain('resolve', { worktree: repo.dir });
    const report = (reply.data as PreciseTaskData).tasks['resolve'];
    assert.equal(report?.complete, true);
    assert.ok((report?.processed ?? 0) >= 1, 'the pass resumed and asked the rest');
    assert.equal(report?.precise?.complete, true);
    const all = calls.flat();
    assert.equal(new Set(all.map((site) => `${site.path}:${String(site.span.startLine)}:${String(site.span.startColumn)}:${site.name}`)).size, all.length, 'no site twice');
  });

  it('no tier keeps the note: maintain resolve on a repository with no precise tier is complete, processes nothing and says so, even from a follower', async (t) => {
    const { repo, open } = await setup(t);
    const leader = await open();
    await leader.build(repo.dir);
    const reply = await leader.maintain('resolve', { worktree: repo.dir });
    const report = (reply.data as PreciseTaskData).tasks['resolve'];
    assert.deepEqual({ complete: report?.complete, processed: report?.processed, note: report?.note }, { complete: true, processed: 0, note: 'no precise tier is active' });
    assert.equal(report?.precise, undefined);
    const follower = await open();
    assert.equal((await follower.status()).leader, false);
    const again = await follower.maintain('resolve', { worktree: repo.dir });
    assert.equal(again.ok, true, JSON.stringify(again.diagnostics));
    assert.equal((again.data as PreciseTaskData).tasks['resolve']?.note, 'no precise tier is active');
  });

  it('a follower whose repository has a resolver is refused with lease_held, like the other maintenance tasks', async (t) => {
    const { repo, open } = await setup(t);
    const { resolver } = recordingResolver();
    const leader = await open({ resolverFactory: resolver });
    await leader.build(repo.dir);
    const follower = await open({ resolverFactory: resolver });
    const reply = await follower.maintain('resolve', { worktree: repo.dir });
    assert.equal(reply.ok, false);
    assert.equal(reply.diagnostics[0]?.code, 'lease_held');
  });
});

describe('Tenant: a memory stop is forgotten by an explicit resolve', () => {
  const MODULES = path.resolve(import.meta.dirname, '..', '..', 'modules');
  const TS_REPO: Readonly<Record<string, string>> = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'es2022' }, include: ['src'] }),
    'src/lib.ts': 'export function compute(n: number): number {\n  return n + 1;\n}\n',
    'src/user.ts': "import { compute } from './lib';\nexport const answer = compute(1);\n",
  };

  /** A tier that answers `memory_budget` while latched; `clearMemoryStop` lifts the latch, as the real pool's does. */
  function latchedTier(): { readonly tier: PreciseTier; readonly state: { latched: boolean; cleared: number; asked: number } } {
    const state = { latched: true, cleared: 0, asked: 0 };
    const tier = {
      id: 'typescript',
      active: true,
      memory: {} as never,
      resolver: async function* (sites: readonly RefSiteKey[]) {
        state.asked += sites.length;
        if (state.latched) throw new ResolverFailure('memory_budget', 'stopped for memory');
      },
      explain: () => undefined,
      stats: () => ({ sites: { asked: 0, answered: 0 }, edges: 0, dropped: {}, byKind: {} }),
      relationStats: () => ({ files: { asked: 0, answered: 0 }, kept: 0, dropped: 0 }),
      info: () => [],
      clearMemoryStop() {
        state.cleared += 1;
        state.latched = false;
      },
      close: async () => {},
    } as unknown as PreciseTier;
    return { tier, state };
  }

  it('maintain resolve and build call clearMemoryStop; other tasks do not', async (t) => {
    const { repo, open } = await setup(t, TS_REPO);
    const { tier, state } = latchedTier();
    const tenant = await open({
      roots: { repoRoot: repo.dir, userDir: path.join(repo.dir, '..', 'no-user'), builtinDir: MODULES, npmRoots: [] },
      tiers: (id) => (id === 'typescript' ? tier : undefined),
      knownAdapters: ['typescript'],
    });
    // The build starts a new attempt: the latch is lifted once, and the pass then completes.
    const built = await tenant.build(repo.dir);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal(state.cleared, 1);
    assert.ok(state.asked > 0, 'the pass asked the resolver after the latch was lifted');
    assert.equal(built.diagnostics.some((entry) => entry.code === 'resolver_timeout'), false);

    // A new stop is lifted by the next explicit resolve, also when that pass has nothing left to ask.
    state.latched = true;
    const reply = await tenant.maintain('resolve', { worktree: repo.dir });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal(state.cleared, 2);
    assert.equal(state.latched, false);
    assert.equal((reply.data as PreciseTaskData).tasks['resolve']?.complete, true);

    state.latched = true;
    await tenant.maintain('reconcile', { worktree: repo.dir });
    await tenant.maintain('check', { worktree: repo.dir });
    assert.equal(state.cleared, 2, 'only resolve forgets a memory stop');
  });
});

// ---------------------------------------------------------------------------------------------------------
// The build envelope (amendment 2026-10-18): the pathless notes of `BuildResult.skipped` reach `diagnostics`; the data of
// `gsd-atlas.build/1` does not change.
// ---------------------------------------------------------------------------------------------------------

describe('Tenant: the build envelope tells what the build could not index', () => {
  const EMIT = diagnostic('emit_output_not_indexed', 'info', '2 files are the emit output of an included source and are not indexed');
  const COMMENT = diagnostic('citation_comment_too_long', 'info', '1 file has comments that mention an ADR but are over the comment size bound; their citations are not indexed');
  const UNCLAIMED = diagnostic('source_unclaimed', 'info', '3 files have an extension no language module claims');

  /** A tenant whose Indexer builds nothing and answers `result`; the Tenant's own part of the build is what is observed. */
  async function buildWith(t: TestContext, result: Partial<BuildResult>): Promise<Envelope> {
    const { repo, open } = await setup(t);
    const scripted = scriptedIndexers({ start: 'now' });
    const full: BuildResult = { files: 4, parsed: 2, linked: 1, removed: 0, skipped: [], failed: [], ...result };
    const indexerFactory = (deps: IndexerDeps): Indexer => ({ ...scripted.factory(deps), build: () => Promise.resolve(full) });
    const tenant = await open({ indexerFactory });
    return tenant.build(repo.dir);
  }

  it('build envelope carries the pathless notes: the two allow-listed codes, in the order the build reported them, and nothing else', async (t) => {
    const reply = await buildWith(t, { skipped: [UNCLAIMED, COMMENT, EMIT] });
    assert.equal(reply.ok, true);
    assert.deepEqual(
      reply.diagnostics.map((entry) => [entry.code, entry.severity, entry.message]),
      [
        ['citation_comment_too_long', 'info', COMMENT.message],
        ['emit_output_not_indexed', 'info', EMIT.message],
      ],
    );
    assert.equal(reply.degraded, undefined);
    assert.equal((reply.data as { skipped: number }).skipped, 3, 'skipped is still a count of everything the build collected');
  });

  it('build envelope drops a note with a subject: a path or text never reaches the envelope through the notes of a build', async (t) => {
    const withSubject = diagnostic('emit_output_not_indexed', 'info', 'MARKER-MESSAGE-ONE', 'src/MARKER-SUBJECT/secret.ts');
    const unlisted = diagnostic('some_other_note', 'info', 'MARKER-MESSAGE-TWO /abs/MARKER-PATH/file.ts');
    const reply = await buildWith(t, { skipped: [withSubject, unlisted, EMIT] });
    assert.deepEqual(reply.diagnostics.map((entry) => entry.code), ['emit_output_not_indexed']);
    const text = JSON.stringify(reply);
    assert.equal(text.includes('MARKER'), false, text);
    assert.equal((reply.data as { skipped: number }).skipped, 3);
  });

  it('clean build envelope is empty: a build that left nothing out has diagnostics equal to []', async (t) => {
    const reply = await buildWith(t, { skipped: [] });
    assert.deepEqual(reply.diagnostics, []);
    const other = await buildWith(t, { skipped: [UNCLAIMED] });
    assert.deepEqual(other.diagnostics, [], 'a note that is only counted adds nothing');
  });

  it('build that parses nothing keeps the note: the envelope is derived from BuildResult.skipped alone', async (t) => {
    const reply = await buildWith(t, { parsed: 0, linked: 4, skipped: [COMMENT] });
    assert.deepEqual(reply.diagnostics.map((entry) => entry.code), ['citation_comment_too_long']);
    assert.equal((reply.data as { parsed: number }).parsed, 0);
  });

  it('the allow-list is exactly the two aggregated notes the Indexer makes, and nothing a source-tree diagnostic can be', () => {
    assert.deepEqual([...BUILD_NOTE_CODES], ['emit_output_not_indexed', CITATION_COMMENT_TOO_LONG]);
    assert.deepEqual(buildNotes([], false), []);
    assert.deepEqual(
      buildNotes([], true).map((note) => [note.code, note.severity, note.subject]),
      [['resolver_timeout', 'info', undefined]],
    );
  });

  it('build data keys unchanged: the documented keys of gsd-atlas.build/1 and their types, whatever the notes', async (t) => {
    const reply = await buildWith(t, { skipped: [EMIT, COMMENT], failed: [{ worktree: 'w', path: 'a.ts', code: 'parse_failed' }] });
    const data = reply.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ['failed', 'failedCodes', 'files', 'linked', 'parsed', 'removed', 'skipped', 'worktree']);
    assert.equal(typeof data['worktree'], 'string');
    for (const key of ['files', 'parsed', 'linked', 'removed', 'skipped', 'failed']) assert.equal(typeof data[key], 'number', key);
    assert.deepEqual(data['failedCodes'], { parse_failed: 1 });
    assert.equal(reply.schema, 'gsd-atlas.build/1');
  });
});
