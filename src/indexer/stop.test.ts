import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import type { EventSource } from './index.ts';
import { THREE_FILES, eventually, makeWorld } from './harness.test.ts';

/** How many loaded grammars the module host disposed: the observable trace of `host.dispose()`. */
interface DisposeLog {
  loaded: number;
  disposed: number;
  /** When set, called before every parse; it may wait. */
  onRun?: (source: string) => Promise<void> | void;
}

function disposeCountingEngine(log: DisposeLog): (real: GrammarEngine) => GrammarEngine {
  return (real) => ({
    load: async (input) => {
      const grammar = await real.load(input);
      log.loaded += 1;
      return {
        name: grammar.name,
        abi: grammar.abi,
        run: async (source) => {
          await log.onRun?.(source);
          return grammar.run(source);
        },
        dispose: () => {
          log.disposed += 1;
          return grammar.dispose();
        },
      };
    },
    dispose: () => real.dispose(),
  });
}

/** An event source whose subscriptions all fail to stop. */
function failingSource(options: { readonly files?: boolean; readonly git?: boolean }): EventSource {
  const failing = (): Promise<() => Promise<void>> =>
    Promise.resolve(() => Promise.reject(new Error('the watcher would not stop')));
  const quiet = (): Promise<() => Promise<void>> => Promise.resolve(() => Promise.resolve());
  return {
    subscribe: options.files === false ? quiet : failing,
    subscribeGit: options.git === false ? quiet : failing,
    watchMode: () => 'native',
  };
}

describe('Indexer.stop always finishes its teardown (WR-13)', () => {
  it('legacy unsubscribe fails: stop resolves, the module host is disposed and the writer slot is free', async (t) => {
    const log: DisposeLog = { loaded: 0, disposed: 0 };
    const world = await makeWorld(t, { files: THREE_FILES, engine: disposeCountingEngine(log) });
    await world.indexer.build(world.dir);
    assert.ok(log.loaded > 0, 'the build loaded a grammar, so there is something to dispose');
    await world.indexer.attach(failingSource({ git: false }), [world.dir]);

    const first = world.indexer.stop();
    await assert.doesNotReject(first);
    assert.equal(log.disposed, log.loaded, 'every loaded grammar was disposed');

    const writer = world.store.writer();
    writer.release();

    const again = world.indexer.stop();
    assert.equal(again, first, 'a second stop returns the same settled promise');
    await again;
    assert.equal(log.disposed, log.loaded, 'the teardown did not run again');
  });

  it('git and per-worktree unsubscribes failing: stop resolves and releases everything (regression guard)', async (t) => {
    const log: DisposeLog = { loaded: 0, disposed: 0 };
    const world = await makeWorld(t, {
      files: THREE_FILES,
      engine: disposeCountingEngine(log),
      source: failingSource({}),
    });
    await world.indexer.start();
    assert.ok(log.loaded > 0);

    await assert.doesNotReject(world.indexer.stop());
    assert.equal(log.disposed, log.loaded);
    world.store.writer().release();
  });

  it('active job: stop waits for the job in flight, then still disposes and releases', async (t) => {
    const log: DisposeLog = { loaded: 0, disposed: 0 };
    const world = await makeWorld(t, { files: THREE_FILES, engine: disposeCountingEngine(log) });
    await world.indexer.build(world.dir);

    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    log.onRun = async () => {
      entered = true;
      await gate;
    };
    world.repo.write('a.toy', 'fn main {\n}\nfn edited {\n}\n');
    const fresh = world.indexer.ensureFresh(world.dir, ['a.toy']).catch(() => undefined);
    await eventually(() => Promise.resolve(entered), 'the job to reach the parser');

    let settled = false;
    const stopping = world.indexer.stop().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, 'stop is still waiting for the active job');
    assert.equal(log.disposed, 0, 'nothing is disposed under a running job');

    open();
    await stopping;
    await fresh;
    assert.equal(log.disposed, log.loaded);
    world.store.writer().release();
  });

  it('concurrent stops: two calls started together run the teardown once', async (t) => {
    const log: DisposeLog = { loaded: 0, disposed: 0 };
    const world = await makeWorld(t, { files: THREE_FILES, engine: disposeCountingEngine(log) });
    await world.indexer.build(world.dir);
    const loaded = log.loaded;
    assert.ok(loaded > 0);

    const a = world.indexer.stop();
    const b = world.indexer.stop();
    assert.equal(a, b);
    await Promise.all([a, b]);
    assert.equal(log.disposed, loaded, 'each grammar was disposed exactly once');
  });

  it('lease regained: after a stop that met a failing unsubscribe a new Indexer builds a worktree', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);
    await world.indexer.attach(failingSource({ git: false }), [world.dir]);
    await world.indexer.stop();

    const next = world.another();
    const result = await next.build(world.dir);
    assert.equal(result.files, 3);
    assert.equal((await world.reader.find('main')).data.length, 1);
  });
});
