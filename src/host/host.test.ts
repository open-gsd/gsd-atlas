import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Envelope } from '../facts/index.ts';
import { systemClock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor, Job } from '../governor/index.ts';
import { createIndexer, createManualEventSource } from '../indexer/index.ts';
import type { Indexer, IndexerDeps } from '../indexer/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import { makeWorld, setupRunner, storeIdOf, toyModules, writeFiles } from './harness.test.ts';
import type { World } from './harness.test.ts';
import { loadUserConfig } from './index.ts';

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);

/** Poll until `check` holds; the work behind it runs on real I/O. */
async function eventually(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface FindData {
  readonly results: ReadonlyArray<{ readonly name: string; readonly path: string; readonly line: number; readonly citation: string }>;
}

async function built(world: World): Promise<void> {
  const reply = await world.ask('build', { repo: world.repo.dir });
  assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
}

describe('Host: build, then find', () => {
  it('a code_find before any build answers not_indexed naming gsd-atlas build, and indexes nothing', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['not_indexed']);
    assert.match(reply.diagnostics[0]?.message ?? '', /gsd-atlas build/);

    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
    assert.deepEqual((status.data as { worktrees: unknown[] }).worktrees, []);
    assert.equal(world.manual.subscriptions(), 0, 'nothing is watched before a build (D-11)');
  });

  it('fresh paths on a repository nobody built index nothing (D-11)', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir }, { fresh: ['b.toy'] });
    assert.deepEqual(codes(reply), ['not_indexed']);
    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.deepEqual((status.data as { worktrees: unknown[] }).worktrees, []);
    assert.equal((status.data as { indexer: unknown }).indexer, null, 'no Indexer was even created');
  });

  it('the build request is what makes find succeed; a second build parses nothing', async (t) => {
    const world = await makeWorld(t);
    const first = await world.ask('build', { repo: world.repo.dir });
    assert.equal(first.schema, 'gsd-atlas.build/1');
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    const data = first.data as { files: number; parsed: number };
    assert.equal(data.files, 3);
    assert.equal(data.parsed, 3);

    const found = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    const results = (found.data as FindData).results;
    assert.equal(results.length, 1);
    assert.equal(results[0]?.name, 'helper');
    assert.equal(results[0]?.path, 'b.toy');
    assert.equal(found.citations?.length, 1);
    assert.match(found.untrusted_text?.entries[0]?.text ?? '', /fn helper/);

    const second = await world.ask('build', { repo: world.repo.dir });
    assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
    assert.equal((second.data as { parsed: number }).parsed, 0);
  });

  it('code_refs and atlas_status are served; atlas_status shows this process as the lease holder and a watch mode', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const refs = await world.ask('code_refs', { name: 'boot', repo: world.repo.dir });
    assert.equal(refs.ok, true, JSON.stringify(refs.diagnostics));
    assert.equal(refs.schema, 'gsd-atlas.code-refs/1');

    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
    const data = status.data as {
      store: { writerLeaseHeld: boolean };
      indexer: { watchMode: string } | null;
      worktrees: unknown[];
    };
    assert.equal(data.store.writerLeaseHeld, true);
    assert.equal(data.indexer?.watchMode, 'native');
    assert.equal(data.worktrees.length, 1);
  });

  it('fresh paths reach ensureFresh: an edit is found without waiting for the watcher (IDX-04)', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    writeFiles(world.repo.dir, { 'b.toy': 'fn helper_two {\n}\n' });
    const reply = await world.ask('code_find', { name: 'helper_two', repo: world.repo.dir }, { fresh: ['b.toy'] });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as FindData).results[0]?.name, 'helper_two');
    assert.equal(reply.degraded?.includes('fresh_timeout') ?? false, false);
  });
});

describe('Host: repository selection', () => {
  it('answers not_a_repo for a missing path, a file and a directory that is not in a git repository', async (t) => {
    const world = await makeWorld(t);
    const plain = fs.mkdtempSync(path.join(world.tmp.path, 'plain-'));
    for (const repo of [path.join(world.tmp.path, 'nosuch'), path.join(world.repo.dir, 'a.toy'), plain]) {
      const requests: Array<[string, Record<string, unknown>]> = [
        ['code_find', { name: 'x', repo }],
        ['build', { repo }],
        ['atlas_status', { repo }],
      ];
      for (const [kind, args] of requests) {
        const reply = await world.ask(kind, args);
        assert.equal(reply.ok, false, `${kind} ${repo}`);
        assert.deepEqual(codes(reply), ['not_a_repo'], `${kind} ${repo}`);
      }
    }
  });

  it('a cwd inside a subdirectory resolves to the repository, and the Host default is its own working directory', async (t) => {
    const world = await makeWorld(t);
    const sub = path.join(world.repo.dir, 'sub');
    fs.mkdirSync(sub);
    const reply = await world.ask('build', { cwd: sub });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as { files: number }).files, 3);
    const found = await world.ask('code_find', { name: 'helper' });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results.length, 1);
  });

  it('a cwd inside a linked worktree selects that worktree overlay', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const linked = await world.addWorktree('feature');
    const before = await world.ask('code_find', { name: 'helper', cwd: linked });
    assert.deepEqual(codes(before), ['not_indexed'], 'the linked worktree is not indexed until it is built');

    const reply = await world.ask('build', { cwd: linked });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const found = await world.ask('code_find', { name: 'helper', cwd: linked });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results[0]?.path, 'b.toy');

    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.equal((status.data as { worktrees: unknown[] }).worktrees.length, 2);
  });

  it('refuses arguments of the wrong type with invalid_args before opening anything', async (t) => {
    const world = await makeWorld(t);
    for (const args of [{ repo: 3 }, { cwd: '' }, { repo: [] }]) {
      const reply = await world.ask('build', args);
      assert.deepEqual(codes(reply), ['invalid_args'], JSON.stringify(args));
    }
    const unknownKey = await world.ask('build', { repo: world.repo.dir, surprise: true });
    assert.deepEqual(codes(unknownKey), ['invalid_args']);
  });
});

describe('Host: tenants', () => {
  it('closeTenant closes one tenant and the next request opens it again lazily', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    assert.equal(world.manual.subscriptions(), 1);
    const storeId = await storeIdOf(world.repo);

    await world.host.closeTenant(storeId);
    assert.equal(world.manual.subscriptions(), 0, 'closing the tenant stops its watcher');

    const found = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results.length, 1);
    await eventually(() => world.manual.subscriptions() === 1, 'the reopened tenant to watch the indexed worktree');
  });

  it('close closes everything and leaves no watcher; a closed Host answers host_closed', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    await world.host.close();
    assert.equal(world.manual.subscriptions(), 0);
    assert.deepEqual(world.manual.gitSubscriptions(), []);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.deepEqual(codes(reply), ['host_closed']);
    await world.host.close();
  });
});

describe('Host: lang kinds', () => {
  it('lang_list accepts the repo argument, which replaces roots.repoRoot for that call', async (t) => {
    const world = await makeWorld(t);
    const other = makeTempDir();
    t.after(() => {
      other.cleanup();
    });
    fs.cpSync(path.join(toyModules, 'toy'), path.join(other.path, '.gsd-atlas', 'languages', 'toy'), { recursive: true });
    const without = await world.ask('lang_list', {});
    assert.equal(without.ok, true);
    assert.equal((without.data as { modules: Array<{ source: string }> }).modules[0]?.source, 'builtin');
    const reply = await world.ask('lang_list', { repo: other.path });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as { modules: Array<{ source: string }> }).modules[0]?.source, 'repo');
    const bad = await world.ask('lang_list', { repo: 'relative/dir' });
    assert.deepEqual(codes(bad), ['invalid_args']);
  });
});

interface Spy {
  readonly governor: Governor;
  /** Every job the Host or an Indexer asked the Governor to run, in order. */
  readonly jobs: Job[];
  /** The jobs whose function started. */
  readonly started: Job[];
  /** The most jobs the real Governor reported running when a job started. */
  readonly maxRunning: () => number;
}

/** A Governor that records every job and holds the interactive ones at the start until `hold` settles. */
function spyGovernor(real: Governor, hold?: Promise<void>): Spy {
  const jobs: Job[] = [];
  const started: Job[] = [];
  let maxRunning = 0;
  const governor: Governor = {
    run: (job, fn) => {
      jobs.push(job);
      return real.run(job, async (signal) => {
        started.push(job);
        maxRunning = Math.max(maxRunning, real.status().running);
        if (job.class === 'interactive') await hold;
        return fn(signal);
      });
    },
    lease: (key, estimatedBytes, onEvict) => real.lease(key, estimatedBytes, onEvict),
    status: () => real.status(),
  };
  return { governor, jobs, started, maxRunning: () => maxRunning };
}

describe('Host: busy and Governor classes (HST-03)', () => {
  it('fifty simultaneous code requests give a mix of ok and busy answers, never an exception, never more running than the concurrency', async (t) => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = spyGovernor(createGovernor({ clock: systemClock, concurrency: 1, maxQueue: { interactive: 2 } }), hold);
    const world = await makeWorld(t, { governor: spy.governor });
    await built(world);

    const replies: Envelope[] = [];
    const settled = Promise.allSettled(
      Array.from({ length: 50 }, async () => {
        const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
        replies.push(reply);
        return reply;
      }),
    );
    const busy = (): Envelope[] => replies.filter((reply) => reply.diagnostics[0]?.code === 'busy');
    await eventually(() => busy().length === 47, 'the 47 requests beyond one running and two queued to be answered busy');
    release();
    const results = await settled;

    assert.ok(results.every((result) => result.status === 'fulfilled'), 'no request rejects');
    assert.equal(replies.filter((reply) => reply.ok).length, 3, 'one ran and two waited for its slot');
    for (const reply of busy()) {
      assert.equal(reply.ok, false);
      assert.equal(reply.data, null);
      assert.ok(Number.isInteger(reply.retry_after) && (reply.retry_after ?? 0) > 0, `retry_after ${String(reply.retry_after)}`);
    }
    const interactive = spy.started.filter((job) => job.class === 'interactive');
    assert.equal(interactive.length, 3, 'a request answered busy never ran');
    assert.ok(spy.maxRunning() <= 1, 'never more running than the concurrency');
  });

  it('places build in the indexing class, maintain in the maintenance class and code tools in the interactive class', async (t) => {
    const spy = spyGovernor(createGovernor({ clock: systemClock }));
    const world = await makeWorld(t, { governor: spy.governor });
    await world.ask('build', { repo: world.repo.dir });
    assert.equal(spy.jobs[0]?.class, 'indexing');
    spy.jobs.length = 0;
    const kept = await world.ask('maintain', { repo: world.repo.dir, task: 'collect' });
    assert.equal(kept.ok, true, JSON.stringify(kept.diagnostics));
    assert.deepEqual(
      spy.jobs.map((job) => job.class),
      ['maintenance'],
    );
    spy.jobs.length = 0;
    await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    await world.ask('atlas_status', { repo: world.repo.dir });
    assert.deepEqual(
      spy.jobs.map((job) => job.class),
      ['interactive', 'interactive'],
    );
  });
});

describe('Host: follower and lease_held (STO-08)', () => {
  it('a second Host on the same repository reads, starts no Indexer and no watcher, and answers build and maintain with lease_held', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const followerManual = createManualEventSource();
    let indexers = 0;
    const follower = world.anotherHost({
      eventSource: () => followerManual.source,
      indexerFactory: (deps: IndexerDeps): Indexer => {
        indexers += 1;
        return createIndexer(deps);
      },
    });
    const ask = (kind: string, args: unknown, fresh?: readonly string[]): Promise<Envelope> =>
      follower.handle({ protocol: 1, kind, args, ...(fresh === undefined ? {} : { fresh }) });
    const repo = world.repo.dir;

    const found = await ask('code_find', { name: 'helper', repo });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results.length, 1);
    assert.ok(found.degraded?.includes('follower'), 'a follower says so in every answer');

    for (const [kind, args] of [
      ['build', { repo }],
      ['maintain', { repo, task: 'collect' }],
      ['maintain', { repo, task: 'all' }],
    ] as const) {
      const reply = await ask(kind, args);
      assert.deepEqual(codes(reply), ['lease_held'], `${kind} ${JSON.stringify(args)}`);
    }
    const resolve = await ask('maintain', { repo, task: 'resolve' });
    assert.equal(resolve.ok, true, 'a task that needs no writer still runs');

    const fresh = await ask('code_find', { name: 'helper', repo }, ['b.toy']);
    assert.equal(fresh.ok, true, JSON.stringify(fresh.diagnostics));
    assert.equal(fresh.degraded?.includes('fresh_timeout') ?? false, false, 'a follower completes fresh paths in its own overlay');
    assert.ok(fresh.degraded?.includes('follower'));

    writeFiles(world.repo.dir, { 'b.toy': 'fn helper_two {\n}\n' });
    const edited = await ask('code_find', { name: 'helper_two', repo }, ['b.toy']);
    assert.equal(edited.ok, true, JSON.stringify(edited.diagnostics));
    assert.equal((edited.data as FindData).results[0]?.name, 'helper_two', 'the follower sees its own edit without the leader');
    assert.equal(edited.degraded?.includes('fresh_timeout') ?? false, false);
    assert.ok(edited.degraded?.includes('follower'));

    const status = await ask('atlas_status', { repo });
    const data = status.data as { store: { writerLeaseHeld: boolean }; indexer: unknown };
    assert.equal(data.store.writerLeaseHeld, false);
    assert.equal(data.indexer, null);
    assert.equal(indexers, 0, 'no Indexer was created');
    assert.equal(followerManual.subscriptions(), 0);
    assert.deepEqual(followerManual.gitSubscriptions(), []);
  });
});

interface TaskData {
  readonly tasks: Record<string, { complete: boolean; spentMs: number; processed: number; note?: string; ok?: boolean }>;
}

describe('Host: maintain tasks (STO-10)', () => {
  it('maintain runs reconcile, refresh, collect, compact and check and reports complete, spentMs and processed for each', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    for (const task of ['reconcile', 'refresh', 'collect', 'compact', 'check']) {
      const reply = await world.ask('maintain', { repo: world.repo.dir, task });
      assert.equal(reply.schema, 'gsd-atlas.maintain/1');
      assert.equal(reply.ok, true, `${task}: ${JSON.stringify(reply.diagnostics)}`);
      const report = (reply.data as TaskData).tasks[task];
      assert.equal(report?.complete, true, task);
      assert.equal(typeof report?.spentMs, 'number', task);
      assert.equal(typeof report?.processed, 'number', task);
    }
  });

  it('maintain resolve is a no-op while no precise tier is active, and all runs every task in order', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const resolve = await world.ask('maintain', { repo: world.repo.dir, task: 'resolve' });
    const report = (resolve.data as TaskData).tasks['resolve'];
    assert.equal(report?.processed, 0);
    assert.match(report?.note ?? '', /no precise tier is active/);

    const all = await world.ask('maintain', { repo: world.repo.dir });
    assert.equal(all.ok, true, JSON.stringify(all.diagnostics));
    assert.deepEqual(Object.keys((all.data as TaskData).tasks), ['reconcile', 'resolve', 'refresh', 'collect', 'compact', 'check']);
    assert.equal((all.data as TaskData).tasks['check']?.ok, true);
  });

  it('maintain refuses an unknown task with invalid_args and a repository nobody built with not_indexed', async (t) => {
    const world = await makeWorld(t);
    const unknown = await world.ask('maintain', { repo: world.repo.dir, task: 'frobnicate' });
    assert.deepEqual(codes(unknown), ['invalid_args']);
    for (const task of ['reconcile', 'refresh']) {
      const reply = await world.ask('maintain', { repo: world.repo.dir, task });
      assert.deepEqual(codes(reply), ['not_indexed'], task);
    }
    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.deepEqual((status.data as { worktrees: unknown[] }).worktrees, [], 'maintenance indexed nothing (D-11)');
  });
});

describe('Host: status panels', () => {
  it('status returns the Metrics report and the status snapshot for a window; a window it cannot read is invalid_args', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const reply = await world.ask('status', { repo: world.repo.dir, since: '30m' });
    assert.equal(reply.schema, 'gsd-atlas.status/1');
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const data = reply.data as {
      range: { since: number; until: number };
      report: { answers: { total: number } };
      tenant: { leader: boolean; location: { kind: string } };
    };
    assert.equal(data.range.until - data.range.since, 30 * 60_000);
    assert.equal(typeof data.report.answers.total, 'number');
    assert.equal(data.tenant.leader, true);
    assert.equal(data.tenant.location.kind, 'git-common');

    const weekly = await world.ask('status', { repo: world.repo.dir });
    const week = (weekly.data as { range: { since: number; until: number } }).range;
    assert.equal(week.until - week.since, 7 * 86_400_000, 'the default window is 7 days');
    for (const since of ['soon', '0d', '7', '-3d']) {
      assert.deepEqual(codes(await world.ask('status', { repo: world.repo.dir, since })), ['invalid_args'], since);
    }
  });
});

describe('Host: tenant isolation (T-02-68)', () => {
  it('a repository whose store cannot open gets its own error while the other tenant keeps answering', async (t) => {
    const stores = makeTempDir();
    t.after(() => {
      stores.cleanup();
    });
    const world = await makeWorld(t, { host: { config: { store: { dir: stores.path } } } });
    const other = await createTempGitRepo({ runner: setupRunner, world: { committed: { 'b.toy': 'fn betaOnly {\n}\n' } } });
    t.after(() => {
      other.cleanup();
    });
    const otherId = await storeIdOf(other);
    fs.writeFileSync(path.join(stores.path, otherId), 'a file where the store directory should be');

    await built(world);
    const broken = await world.ask('build', { repo: other.dir });
    assert.equal(broken.ok, false);
    assert.deepEqual(codes(broken), ['store_unavailable']);
    const stillServing = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(stillServing.ok, true, JSON.stringify(stillServing.diagnostics));
    assert.equal((stillServing.data as FindData).results.length, 1);

    fs.rmSync(path.join(stores.path, otherId));
    const recovered = await world.ask('build', { repo: other.dir });
    assert.equal(recovered.ok, true, 'a failed creation is forgotten, so the next request tries again');
    await world.host.closeTenant(otherId);
  });
});

describe('loadUserConfig: user-level configuration only (T-02-67)', () => {
  const writeConfig = (dir: string, content: string | Uint8Array): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), content);
  };
  const absolute = (name: string): string => path.join(path.parse(process.cwd()).root, name);

  it('a missing file gives the defaults and no diagnostics', (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    assert.deepEqual(loadUserConfig(path.join(tmp.path, 'nosuch'), {}), { config: {}, diagnostics: [] });
  });

  it('a valid file is read: store.dir, indexer settings, gc.graceMs and permissions', (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const given = {
      store: { dir: absolute('atlas-stores') },
      indexer: { debounceMs: 50, maxWaitMs: 400 },
      gc: { graceMs: 3600000 },
      permissions: { allow: [{ repo: absolute('repo'), executable: 'tsc', argsPrefix: ['--noEmit'] }] },
    };
    writeConfig(tmp.path, JSON.stringify(given));
    assert.deepEqual(loadUserConfig(tmp.path, {}), { config: given, diagnostics: [] });
  });

  it('a file with an unknown key, a relative store.dir, a fractional number, bad JSON, a wait below the debounce or over 64 KiB is ignored whole with one warning', (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const bad: Array<[string, string]> = [
      ['an unknown key', JSON.stringify({ gc: { graceMs: 1 }, surprise: true })],
      ['an unknown nested key', JSON.stringify({ indexer: { speed: 3 } })],
      ['a relative store.dir', JSON.stringify({ store: { dir: 'relative/stores' } })],
      ['a fractional number', JSON.stringify({ indexer: { debounceMs: 1.5 } })],
      ['a wait below the debounce', JSON.stringify({ indexer: { debounceMs: 300, maxWaitMs: 200 } })],
      ['a debounce above the default wait', JSON.stringify({ indexer: { debounceMs: 900 } })],
      ['invalid JSON', '{ "gc": '],
      ['a file over 64 KiB', JSON.stringify({ gc: { graceMs: 1 }, pad: 'x'.repeat(70 * 1024) })],
    ];
    for (const [what, content] of bad) {
      const dir = path.join(tmp.path, what.replaceAll(' ', '-'));
      writeConfig(dir, content);
      const loaded = loadUserConfig(dir, {});
      assert.deepEqual(loaded.config, {}, what);
      assert.equal(loaded.diagnostics.length, 1, what);
      assert.equal(loaded.diagnostics[0]?.severity, 'warning', what);
      assert.equal(loaded.diagnostics[0]?.code, 'user_config_ignored', what);
    }
  });

  it('GSD_ATLAS_STORE_DIR overrides store.dir when it is absolute and is ignored with a warning when it is not', (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    writeConfig(tmp.path, JSON.stringify({ store: { dir: absolute('from-file') }, gc: { graceMs: 5 } }));
    const overridden = loadUserConfig(tmp.path, { GSD_ATLAS_STORE_DIR: absolute('from-env') });
    assert.deepEqual(overridden, { config: { store: { dir: absolute('from-env') }, gc: { graceMs: 5 } }, diagnostics: [] });

    const alone = loadUserConfig(path.join(tmp.path, 'nosuch'), { GSD_ATLAS_STORE_DIR: absolute('only-env') });
    assert.deepEqual(alone.config, { store: { dir: absolute('only-env') } });

    const relative = loadUserConfig(tmp.path, { GSD_ATLAS_STORE_DIR: 'relative/dir' });
    assert.deepEqual(relative.config, { store: { dir: absolute('from-file') }, gc: { graceMs: 5 } });
    assert.equal(relative.diagnostics.length, 1);
    assert.equal(relative.diagnostics[0]?.code, 'user_config_ignored');
  });

  it('an unreadable path (a directory where the file should be) is one warning, not a crash', (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    fs.mkdirSync(path.join(tmp.path, 'config.json'));
    const loaded = loadUserConfig(tmp.path, {});
    assert.deepEqual(loaded.config, {});
    assert.equal(loaded.diagnostics.length, 1);
  });
});

describe('Host: configuration reaches the tenant (T-02-67)', () => {
  it('repository config is ignored: a config.json and a .gsd-atlas/config.json in the repository change nothing', async (t) => {
    const hostile = JSON.stringify({
      store: { dir: path.join(path.parse(process.cwd()).root, 'hijacked') },
      indexer: { debounceMs: 1, maxWaitMs: 2 },
      permissions: { allow: [{ repo: '/', executable: 'sh' }] },
    });
    let seen: Partial<{ debounceMs: number; maxWaitMs: number }> | undefined;
    const world = await makeWorld(t, {
      files: { 'a.toy': 'fn main {\n}\n', 'config.json': hostile, '.gsd-atlas/config.json': hostile },
      host: {
        indexerFactory: (deps: IndexerDeps): Indexer => {
          seen = deps.config;
          return createIndexer(deps);
        },
      },
    });
    // The loader takes only the user directory and the environment, so nothing in a repository can reach it.
    assert.deepEqual(loadUserConfig(world.options.userDir ?? '', {}), { config: {}, diagnostics: [] });
    await built(world);
    const panel = await world.ask('status', { repo: world.repo.dir });
    const location = (panel.data as { tenant: { location: { kind: string; dir: string } } }).tenant.location;
    assert.equal(location.kind, 'git-common');
    assert.ok(location.dir.startsWith(path.join(world.repo.dir, '.git')), location.dir);
    assert.equal(seen, undefined, 'the Indexer got no settings from the repository');
  });

  it('config.store.dir places the store at that directory plus the store id', async (t) => {
    const stores = makeTempDir();
    t.after(() => {
      stores.cleanup();
    });
    const world = await makeWorld(t, { host: { config: { store: { dir: stores.path } } } });
    await built(world);
    const panel = await world.ask('status', { repo: world.repo.dir });
    const location = (panel.data as { tenant: { location: { kind: string; dir: string } } }).tenant.location;
    assert.equal(location.kind, 'override');
    assert.equal(location.dir, path.join(stores.path, await storeIdOf(world.repo)));
    assert.ok(fs.existsSync(path.join(location.dir, 'facts.db')));
  });

  it('the indexer debounce and max wait from the user config reach the Indexer', async (t) => {
    let seen: Partial<{ debounceMs: number; maxWaitMs: number }> | undefined;
    const world = await makeWorld(t, {
      host: {
        config: { indexer: { debounceMs: 40, maxWaitMs: 300 } },
        indexerFactory: (deps: IndexerDeps): Indexer => {
          seen = deps.config;
          return createIndexer(deps);
        },
      },
    });
    await built(world);
    assert.deepEqual(seen, { debounceMs: 40, maxWaitMs: 300 });
  });
});
