import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { Resolver } from '../fact-store/index.ts';
import { PROTOCOL_VERSION, systemClock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createManualEventSource } from '../indexer/index.ts';
import type { ManualEventSource } from '../indexer/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { createTenant } from './index.ts';
import type { Tenant, TenantDeps } from './index.ts';

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
