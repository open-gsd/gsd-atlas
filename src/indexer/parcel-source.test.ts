import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import { createManualEventSource, gitDirNameOf } from './index.ts';
import type { EventSource, GitSourceEvent, SourceEvent } from './index.ts';
import { eventually, makeWorld, THREE_FILES, writeFiles } from './harness.test.ts';
import { createParcelEventSource } from './parcel-source.ts';
import type { WatcherApi, WatcherEvent, WatcherOptions } from './parcel-source.ts';

/** A watcher whose events are delivered by the test, and which records what it was asked. */
function scriptedWatcher(): {
  readonly api: WatcherApi;
  readonly subscribed: Array<{ readonly dir: string; readonly options: WatcherOptions | undefined }>;
  readonly unsubscribed: string[];
  readonly snapshots: string[];
  /** Every subscribe and unsubscribe, in order: `subscribe N` and `unsubscribe N`, N counting the subscriptions from 1. */
  readonly log: string[];
  /** How many subscriptions are live right now. */
  live(): number;
  deliver(dir: string, error: Error | null, events: readonly WatcherEvent[]): void;
  failSubscribe: Error | undefined;
  /** While set, `subscribe` waits for it before it registers; the failure of a held subscribe is still `failSubscribe`. */
  hold: Promise<void> | undefined;
  eventsSince: readonly WatcherEvent[];
} {
  // One entry object per subscription, so two subscriptions that share a callback function stay two subscriptions.
  type Entry = { readonly fn: (error: Error | null, events: readonly WatcherEvent[]) => unknown };
  const callbacks = new Map<string, Set<Entry>>();
  const state = {
    subscribed: [] as Array<{ readonly dir: string; readonly options: WatcherOptions | undefined }>,
    unsubscribed: [] as string[],
    snapshots: [] as string[],
    log: [] as string[],
    failSubscribe: undefined as Error | undefined,
    hold: undefined as Promise<void> | undefined,
    eventsSince: [] as readonly WatcherEvent[],
  };
  let counter = 0;
  const api: WatcherApi = {
    subscribe: async (dir, fn, options) => {
      if (state.hold !== undefined) await state.hold;
      if (state.failSubscribe !== undefined) throw state.failSubscribe;
      state.subscribed.push({ dir, options });
      counter += 1;
      const number = counter;
      state.log.push(`subscribe ${String(number)}`);
      const live = callbacks.get(dir) ?? new Set<Entry>();
      const entry: Entry = { fn };
      live.add(entry);
      callbacks.set(dir, live);
      return {
        unsubscribe: () => {
          live.delete(entry);
          state.unsubscribed.push(dir);
          state.log.push(`unsubscribe ${String(number)}`);
          return Promise.resolve();
        },
      };
    },
    writeSnapshot: (dir, snapshot) => {
      state.snapshots.push(`${dir} -> ${snapshot}`);
      fs.writeFileSync(snapshot, 'snapshot');
      return Promise.resolve(snapshot);
    },
    getEventsSince: () => Promise.resolve(state.eventsSince),
  };
  return {
    api,
    get subscribed() {
      return state.subscribed;
    },
    get unsubscribed() {
      return state.unsubscribed;
    },
    get snapshots() {
      return state.snapshots;
    },
    get log() {
      return state.log;
    },
    live: () => [...callbacks.values()].reduce((total, set) => total + set.size, 0),
    get failSubscribe() {
      return state.failSubscribe;
    },
    set failSubscribe(value) {
      state.failSubscribe = value;
    },
    get hold() {
      return state.hold;
    },
    set hold(value) {
      state.hold = value;
    },
    get eventsSince() {
      return state.eventsSince;
    },
    set eventsSince(value) {
      state.eventsSince = value;
    },
    deliver: (dir, error, events) => {
      for (const entry of [...(callbacks.get(dir) ?? [])]) entry.fn(error, events);
    },
  };
}

const eventsOf = (root: string, ...rels: string[]): WatcherEvent[] =>
  rels.map((rel, n) => ({ path: path.join(root, ...rel.split('/')), type: (['create', 'update', 'delete'] as const)[n % 3] as string }));

describe('parcel event source over a scripted watcher: what is delivered and what is ignored', () => {
  it('delivers repo-relative POSIX paths without the event type, and drops .git, node_modules and paths outside the root', async () => {
    const tmp = makeTempDir();
    try {
      const root = realPath(tmp.path);
      const watcher = scriptedWatcher();
      const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
      const seen: SourceEvent[] = [];
      const stop = await source.subscribe(root, (event) => seen.push(event));

      watcher.deliver(root, null, [
        ...eventsOf(root, 'src/a.ts', 'src/deep/b.ts', 'src/a.ts', '.git/HEAD', 'node_modules/x/index.js', 'src/node_modules/y.js', 'sub/.git/config'),
        { path: path.join(path.dirname(root), 'elsewhere', 'c.ts'), type: 'update' },
        { path: root, type: 'update' },
      ]);

      assert.deepEqual(seen, [
        { kind: 'change', path: 'src/a.ts' },
        { kind: 'change', path: 'src/deep/b.ts' },
      ]);
      await stop();
      assert.deepEqual(watcher.unsubscribed, [root]);
      watcher.deliver(root, null, eventsOf(root, 'src/late.ts'));
      assert.equal(seen.length, 2, 'nothing is delivered after unsubscribe');
    } finally {
      tmp.cleanup();
    }
  });

  it('gives both subscriptions an ignore list: .git and node_modules for a worktree, objects, logs, locks, hooks and info for the git directory', async () => {
    const tmp = makeTempDir();
    try {
      const root = realPath(tmp.path);
      fs.mkdirSync(path.join(root, 'git'));
      const watcher = scriptedWatcher();
      const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
      await source.subscribe(root, () => {});
      await source.subscribeGit(path.join(root, 'git'), () => {});

      const [files, git] = watcher.subscribed;
      for (const entry of ['.git', 'node_modules', '**/node_modules']) assert.ok(files?.options?.ignore?.includes(entry), `worktree ignores ${entry}`);
      for (const entry of ['objects', 'logs', 'hooks', 'info', '**/*.lock']) assert.ok(git?.options?.ignore?.includes(entry), `git directory ignores ${entry}`);
    } finally {
      tmp.cleanup();
    }
  });

  it('routes the watcher error argument to a problem event: overflow when the message says so, error otherwise', async () => {
    const tmp = makeTempDir();
    try {
      const root = realPath(tmp.path);
      fs.mkdirSync(path.join(root, 'git'));
      const watcher = scriptedWatcher();
      const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
      const files: SourceEvent[] = [];
      const git: GitSourceEvent[] = [];
      await source.subscribe(root, (event) => files.push(event));
      await source.subscribeGit(path.join(root, 'git'), (event) => git.push(event));

      watcher.deliver(root, new Error('Event queue overflow'), []);
      watcher.deliver(root, new Error('permission denied'), []);
      watcher.deliver(path.join(root, 'git'), new Error('events were dropped'), []);
      assert.deepEqual(files, [
        { kind: 'problem', problem: 'overflow' },
        { kind: 'problem', problem: 'error' },
      ]);
      assert.deepEqual(git, [{ kind: 'problem', problem: 'overflow' }]);
    } finally {
      tmp.cleanup();
    }
  });

  it('maps git directory events to head and worktrees, once per batch, and delivers nothing for anything else', async () => {
    const tmp = makeTempDir();
    try {
      const common = path.join(realPath(tmp.path), 'git');
      fs.mkdirSync(common);
      const watcher = scriptedWatcher();
      const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
      const seen: GitSourceEvent[] = [];
      await source.subscribeGit(common, (event) => seen.push(event));

      watcher.deliver(
        common,
        null,
        eventsOf(common, 'HEAD', 'HEAD', 'worktrees/w1/HEAD', 'worktrees/w1/gitdir', 'worktrees/w2', 'index', 'objects/ab/cd', 'refs/heads/x', 'worktrees/w1/index', 'COMMIT_EDITMSG', 'worktrees'),
      );
      assert.deepEqual(seen, [
        { kind: 'head', gitDirName: '' },
        { kind: 'head', gitDirName: 'w1' },
        { kind: 'worktrees' },
      ]);
    } finally {
      tmp.cleanup();
    }
  });

  it('refuses to watch a git directory that does not exist', async () => {
    const tmp = makeTempDir();
    try {
      const watcher = scriptedWatcher();
      const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
      await assert.rejects(source.subscribeGit(path.join(realPath(tmp.path), 'missing'), () => {}));
      assert.deepEqual(watcher.subscribed, []);
    } finally {
      tmp.cleanup();
    }
  });
});

/** Let the promises a renewal chains on run to their end. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('parcel event source: the git watch is renewed when a worktree appears (found by plan 02-26 on Linux CI)', () => {
  // Found on Linux: when `git worktree add` creates `worktrees/` and `worktrees/NAME/` back to back, inotify can report the
  // first and miss the second, so the new directory is never watched and its HEAD changes are never delivered. A new
  // subscription starts from a scan of what exists, so it covers the directory the old one missed.
  async function withGitWatch(
    body: (world: { common: string; watcher: ReturnType<typeof scriptedWatcher>; seen: GitSourceEvent[]; stop: () => Promise<void> }) => Promise<void>,
  ): Promise<void> {
    const tmp = makeTempDir();
    try {
      const common = path.join(realPath(tmp.path), 'git');
      fs.mkdirSync(common);
      const watcher = scriptedWatcher();
      const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
      const seen: GitSourceEvent[] = [];
      const stop = await source.subscribeGit(common, (event) => seen.push(event));
      await body({ common, watcher, seen, stop });
    } finally {
      tmp.cleanup();
    }
  }

  it('subscribes again after a worktrees event and only then drops the old subscription, so no event falls in between', async () => {
    await withGitWatch(async ({ common, watcher, seen, stop }) => {
      assert.deepEqual(watcher.log, ['subscribe 1']);
      watcher.deliver(common, null, eventsOf(common, 'worktrees'));
      assert.deepEqual(seen, [{ kind: 'worktrees' }]);
      await settle();
      assert.deepEqual(watcher.log, ['subscribe 1', 'subscribe 2', 'unsubscribe 1']);
      assert.equal(watcher.live(), 1);

      // The renewed subscription delivers; the first no longer does.
      watcher.deliver(common, null, eventsOf(common, 'worktrees/w1/HEAD'));
      assert.deepEqual(seen, [{ kind: 'worktrees' }, { kind: 'head', gitDirName: 'w1' }]);

      await stop();
      assert.equal(watcher.live(), 0, 'stop drops the renewed subscription too');
      assert.deepEqual(watcher.log, ['subscribe 1', 'subscribe 2', 'unsubscribe 1', 'unsubscribe 2']);
      watcher.deliver(common, null, eventsOf(common, 'HEAD'));
      assert.equal(seen.length, 2, 'nothing is delivered after stop');
    });
  });

  it('a HEAD change alone does not renew the watch, and worktrees events that arrive during a renewal cost one more renewal, not one each', async () => {
    await withGitWatch(async ({ common, watcher }) => {
      watcher.deliver(common, null, eventsOf(common, 'HEAD'));
      await settle();
      assert.deepEqual(watcher.log, ['subscribe 1'], 'a head event does not renew');

      let release: () => void = () => {};
      watcher.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (let batch = 0; batch < 5; batch += 1) watcher.deliver(common, null, eventsOf(common, 'worktrees'));
      await settle();
      assert.deepEqual(watcher.log, ['subscribe 1'], 'the first renewal is waiting for the watcher');
      watcher.hold = undefined;
      release();
      await settle();
      assert.deepEqual(watcher.log, ['subscribe 1', 'subscribe 2', 'unsubscribe 1', 'subscribe 3', 'unsubscribe 2']);
      assert.equal(watcher.live(), 1);
    });
  });

  it('a renewal that fails is reported as a problem so the Indexer reconciles, and the old subscription keeps serving', async () => {
    await withGitWatch(async ({ common, watcher, seen }) => {
      watcher.failSubscribe = new Error('no inotify watches left');
      watcher.deliver(common, null, eventsOf(common, 'worktrees'));
      await settle();
      assert.deepEqual(seen, [{ kind: 'worktrees' }, { kind: 'problem', problem: 'error' }]);
      assert.equal(watcher.live(), 1);
      watcher.failSubscribe = undefined;
      watcher.deliver(common, null, eventsOf(common, 'HEAD'));
      assert.deepEqual(seen.at(-1), { kind: 'head', gitDirName: '' });
    });
  });

  it('stop while a renewal is waiting leaves no subscription open and no event delivered afterwards', async () => {
    await withGitWatch(async ({ common, watcher, seen, stop }) => {
      let release: () => void = () => {};
      watcher.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      watcher.deliver(common, null, eventsOf(common, 'worktrees'));
      await settle();
      const stopping = stop();
      watcher.hold = undefined;
      release();
      await stopping;
      await settle();
      assert.equal(watcher.live(), 0);
      watcher.deliver(common, null, eventsOf(common, 'HEAD'));
      assert.deepEqual(seen, [{ kind: 'worktrees' }]);
    });
  });
});

describe('parcel event source when the native watcher cannot start', () => {
  it('watchMode becomes reconcile-only when subscribe throws, and the Indexer still starts and stays fresh through Reconcile', async (t) => {
    const watcher = scriptedWatcher();
    watcher.failSubscribe = new Error('no inotify watches left');
    const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api) });
    assert.equal(source.watchMode(), 'native');
    const world = await makeWorld(t, { files: THREE_FILES, source });

    await world.indexer.start();

    assert.equal(source.watchMode(), 'reconcile-only');
    assert.equal(world.indexer.status().watchMode, 'reconcile-only');
    assert.equal(world.indexer.status().lastReconcile?.changed, 3, 'the start-up Reconcile still indexed the files');
    writeFiles(world.dir, { 'b.toy': 'fn helper {\n}\nfn without_a_watcher {\n}\n' });
    await world.indexer.reconcile(world.dir);
    assert.equal((await world.reader.find('without_a_watcher')).data.length, 1);
  });

  it('watchMode is reconcile-only when the watcher package cannot be loaded', async () => {
    const source = createParcelEventSource({ watcher: () => Promise.reject(new Error('no prebuilt binary for this platform')) });
    await assert.rejects(source.subscribe(process.cwd(), () => {}), /no prebuilt binary/);
    assert.equal(source.watchMode(), 'reconcile-only');
  });
});

describe('start-up hints: an optional hint to index recently changed paths first, never an error', () => {
  it('writes a snapshot when the Indexer stops and asks for events since it when it starts; the hinted path is indexed', async (t) => {
    const snapshotDir = makeTempDir();
    t.after(() => snapshotDir.cleanup());
    const watcher = scriptedWatcher();
    const source = createParcelEventSource({ watcher: () => Promise.resolve(watcher.api), snapshotDir: snapshotDir.path });
    const world = await makeWorld(t, { files: THREE_FILES, source });
    await world.indexer.start();
    await world.indexer.stop();
    assert.equal(watcher.snapshots.length, 1);
    assert.ok(watcher.snapshots[0]?.startsWith(`${world.dir} -> `), 'the snapshot is of the worktree root');

    writeFiles(world.dir, { 'b.toy': 'fn helper {\n}\nfn offline_edit {\n}\n' });
    watcher.eventsSince = eventsOf(world.dir, 'b.toy');
    const second = world.another();
    await second.start();
    assert.equal((await world.reader.find('offline_edit')).data.length, 1, 'Reconcile and the hint agree on the end state');
  });

  it('ignores every failure of the hints: the end state is still the working tree', async (t) => {
    const manual = createManualEventSource();
    const calls: string[] = [];
    const failing: EventSource = {
      ...manual.source,
      writeSnapshot: () => {
        calls.push('write');
        return Promise.reject(new Error('snapshot failed'));
      },
      eventsSince: () => {
        calls.push('since');
        return Promise.reject(new Error('the call lagged and failed'));
      },
    };
    const world = await makeWorld(t, { files: THREE_FILES, source: failing });
    await world.indexer.start();
    await world.indexer.stop();
    writeFiles(world.dir, { 'a.toy': 'fn main {\n}\nfn after_failed_hint {\n}\n' });
    const second = world.another();
    await second.start();

    assert.deepEqual(calls, ['since', 'write', 'since']);
    assert.equal((await world.reader.find('after_failed_hint')).data.length, 1);
  });
});

/** Wait for `check` on events a real watcher delivers; the operating system decides how soon. */
const arrived = (check: () => boolean, what: string): Promise<void> => eventually(() => Promise.resolve(check()), what, 15000);

describe('parcel event source over the real watcher', () => {
  it('delivers a change for a created, modified, renamed-over and deleted file, never for .git or node_modules, and stops on unsubscribe', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const root = realPath(tmp.path);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    const source = createParcelEventSource();
    assert.equal(source.watchMode(), 'native');
    const seen: SourceEvent[] = [];
    const stop = await source.subscribe(root, (event) => seen.push(event));
    const paths = (): string[] => seen.flatMap((event) => (event.kind === 'change' ? [event.path] : []));
    const reset = (): void => {
      seen.length = 0;
    };

    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await arrived(() => paths().includes('src/a.ts'), 'a created file');
    reset();
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    await arrived(() => paths().includes('src/a.ts'), 'a modified file');
    reset();
    fs.writeFileSync(path.join(root, 'src', 'a.ts.tmp'), 'export const a = 3;\n');
    fs.renameSync(path.join(root, 'src', 'a.ts.tmp'), path.join(root, 'src', 'a.ts'));
    await arrived(() => paths().includes('src/a.ts'), 'a file renamed over another');
    reset();
    fs.rmSync(path.join(root, 'src', 'a.ts'));
    await arrived(() => paths().includes('src/a.ts'), 'a deleted file');

    fs.writeFileSync(path.join(root, '.git', 'objects', 'x'), 'noise');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'noise');
    fs.writeFileSync(path.join(root, 'src', 'sentinel.ts'), 'export const s = 1;\n');
    await arrived(() => paths().includes('src/sentinel.ts'), 'the sentinel file');
    assert.ok(
      paths().every((each) => !each.split('/').some((segment) => segment === '.git' || segment === 'node_modules')),
      `no path under .git or node_modules: ${paths().join(', ')}`,
    );
    assert.ok(seen.every((event) => Object.keys(event).sort().join() === 'kind,path'), 'an event carries no type');

    await stop();
    reset();
    fs.writeFileSync(path.join(root, 'src', 'after.ts'), 'export const z = 1;\n');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(seen, [], 'nothing is delivered after unsubscribe');
  });

  it('delivers head for a checkout in the main and in a linked worktree, worktrees for git worktree add, and nothing for object writes', async (t) => {
    const repo = await createTempGitRepo({
      runner: createRealRunner({ decide: allowAll }),
      world: { committed: { 'a.txt': 'one\n' } },
    });
    t.after(() => repo.cleanup());
    const common = realPath(path.join(repo.dir, '.git'));
    const source = createParcelEventSource();
    const seen: GitSourceEvent[] = [];
    const stop = await source.subscribeGit(common, (event) => seen.push(event));
    t.after(() => stop());
    const has = (wanted: GitSourceEvent): boolean => seen.some((event) => JSON.stringify(event) === JSON.stringify(wanted));

    await repo.git(['checkout', '--quiet', '-b', 'topic']);
    await arrived(() => has({ kind: 'head', gitDirName: '' }), 'HEAD of the main worktree');

    const linked = path.join(path.dirname(repo.dir), 'linked-wt');
    await repo.git(['worktree', 'add', '--quiet', '-b', 'side', linked]);
    await arrived(() => has({ kind: 'worktrees' }), 'a worktree to be added');
    const name = gitDirNameOf(linked, common);
    assert.ok(name !== null && name !== '');
    await repo.git(['-C', linked, 'checkout', '--quiet', '-b', 'side-two']);
    await arrived(() => has({ kind: 'head', gitDirName: name }), 'HEAD of the linked worktree');

    // Let the operating system finish reporting the checkouts above before the quiet period is measured.
    await new Promise((resolve) => setTimeout(resolve, 700));
    seen.length = 0;
    repo.write('b.txt', 'two\n');
    await repo.git(['add', 'b.txt']);
    await repo.git(['commit', '--quiet', '--no-verify', '-m', 'noise']);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(seen, [], 'objects, index, refs, logs and lock files produce no event');
  });

  it('after a stop that writes a snapshot, an offline edit is indexed by the next start (the end state is the working tree)', async (t) => {
    const snapshotDir = makeTempDir();
    t.after(() => snapshotDir.cleanup());
    const source = createParcelEventSource({ snapshotDir: snapshotDir.path });
    const world = await makeWorld(t, { files: THREE_FILES, source });
    await world.indexer.start();
    assert.equal(world.indexer.status().watchMode, 'native');
    await world.indexer.stop();
    assert.equal(fs.readdirSync(snapshotDir.path).length, 1, 'one snapshot file for the one worktree');

    writeFiles(world.dir, { 'c.toy': 'type Widget {\n}\nfn made_while_stopped {\n}\n' });
    const second = world.another();
    await second.start();
    assert.equal((await world.reader.find('made_while_stopped')).data.length, 1);
    await second.stop();
  });
});
