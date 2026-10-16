import { WriterBusy } from '../fact-store/index.ts';
import type { Writer } from '../fact-store/index.ts';
import type { WorktreeInfo } from '../source-tree/index.ts';
import { runBuild } from './build.ts';
import { DEFAULT_INDEXER_CONFIG } from './defaults.ts';
import type { EventSource } from './event-source.ts';
import { createPathFilter } from './ignore.ts';
import { createModuleHost } from './modules.ts';
import { isRepoRelative } from './paths.ts';
import { processBatch } from './process.ts';
import type { ProcessContext } from './process.ts';
import { createCoalescingQueue } from './queue.ts';
import { IndexerError } from './types.ts';
import type { BuildResult, Indexer, IndexerConfig, IndexerDeps, IndexerStatus, WatchProblemRecord } from './types.ts';

const finiteAtLeast0 = (value: number): boolean => Number.isFinite(value) && value >= 0;
const integerAtLeast0 = (value: number): boolean => Number.isInteger(value) && value >= 0;
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function resolveConfig(partial: Partial<IndexerConfig> | undefined): IndexerConfig {
  const config: IndexerConfig = { ...DEFAULT_INDEXER_CONFIG, ...partial };
  for (const key of ['debounceMs', 'maxWaitMs', 'ensureFreshWaitMs'] as const) {
    if (!finiteAtLeast0(config[key])) throw new RangeError(`indexer config ${key} must be a finite number >= 0`);
  }
  for (const key of ['maxFileBytes', 'maxRaceRetries'] as const) {
    if (!integerAtLeast0(config[key])) throw new RangeError(`indexer config ${key} must be an integer >= 0`);
  }
  return config;
}

/**
 * The Indexer: the only writer client of the Fact Store. It takes the writer slot lazily, on the first thing that
 * needs it, and gives it back in `stop()`.
 */
export function createIndexer(deps: IndexerDeps): Indexer {
  const config = resolveConfig(deps.config);
  const host = createModuleHost({ engine: deps.engine, roots: deps.roots });

  let writer: Writer | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  /** Sleeps that a stop wakes early. */
  const wakers = new Set<() => void>();
  /** Work in progress, so `stop()` can wait for it. */
  const active = new Set<Promise<unknown>>();
  const worktrees = new Map<string, WorktreeInfo>();
  const unsubscribes: Array<() => Promise<void>> = [];
  const problems = new Map<string, WatchProblemRecord>();

  const ctx: ProcessContext = {
    tenant: deps.tenant,
    tree: deps.tree,
    store: deps.store,
    governor: deps.governor,
    host,
    filter: createPathFilter(deps.tree),
    config,
    isStopped: () => stopped,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        let cancel = (): void => {};
        const wake = (): void => {
          wakers.delete(wake);
          cancel();
          resolve();
        };
        wakers.add(wake);
        cancel = deps.clock.after(ms, wake);
      }),
  };

  const assertRunning = (): void => {
    if (stopped) throw new IndexerError('stopped', 'the indexer was stopped');
  };

  const track = <T>(work: Promise<T>): Promise<T> => {
    active.add(work);
    const done = (): void => {
      active.delete(work);
    };
    work.then(done, done);
    return work;
  };

  function takeWriter(): Writer {
    if (writer !== undefined) return writer;
    try {
      writer = deps.store.writer();
    } catch (error) {
      if (error instanceof WriterBusy) {
        throw new IndexerError('lease_held', 'another holder has the fact store writer slot, so this process cannot index');
      }
      throw error;
    }
    return writer;
  }

  /** The worktree Source Tree lists under `id`. A build asks git again so the ref it records is current. */
  async function resolveWorktree(id: string, refresh: boolean): Promise<WorktreeInfo> {
    const cached = refresh ? undefined : worktrees.get(id);
    if (cached !== undefined) return cached;
    worktrees.clear();
    for (const info of await deps.tree.worktrees()) worktrees.set(info.path, info);
    const found = worktrees.get(id);
    if (found === undefined || found.bare) {
      throw new IndexerError('unknown_worktree', `${id} is not a worktree of this repository`);
    }
    return found;
  }

  /** One batch of due queue entries. Never throws: a queue job that cannot run is simply not run. */
  async function runQueued(worktree: string, paths: readonly string[]): Promise<void> {
    if (stopped) return;
    try {
      await resolveWorktree(worktree, false);
      await processBatch(ctx, takeWriter(), worktree, paths, { job: { cls: 'indexing' } });
    } catch {
      // Failure accounting arrives with the next task of this plan.
    }
  }

  const queue = createCoalescingQueue({
    clock: deps.clock,
    debounceMs: config.debounceMs,
    maxWaitMs: config.maxWaitMs,
    onBatch: (worktree, paths) => track(runQueued(worktree, paths)),
  });

  function submit(worktree: string, path: string): void {
    if (stopped || !isRepoRelative(path)) return;
    queue.submit(worktree, path);
  }

  function status(): IndexerStatus {
    return {
      queued: 0,
      running: 0,
      failed: [],
      lastIndexedAt: null,
      watchProblems: [...problems.values()].sort(
        (a, b) => compareCodeUnits(a.worktree, b.worktree) || compareCodeUnits(a.kind, b.kind),
      ),
    };
  }

  return {
    build(worktree: string): Promise<BuildResult> {
      return track(
        (async () => {
          assertRunning();
          const info = await resolveWorktree(worktree, true);
          const ref = info.branch ?? info.head ?? 'HEAD';
          return runBuild(ctx, takeWriter(), { worktree, ref });
        })(),
      );
    },

    submit,

    ensureFresh() {
      return Promise.reject(new Error('the indexer ensureFresh is not implemented yet'));
    },

    async attach(source: EventSource, roots: readonly string[]): Promise<void> {
      assertRunning();
      for (const worktree of roots) {
        const unsubscribe = await source.subscribe(worktree, (event) => {
          if (event.kind === 'change') {
            submit(worktree, event.path);
            return;
          }
          const key = `${worktree}\0${event.problem}`;
          const seen = problems.get(key);
          problems.set(key, { worktree, kind: event.problem, count: (seen?.count ?? 0) + 1 });
        });
        unsubscribes.push(unsubscribe);
      }
    },

    status,

    stop(): Promise<void> {
      if (stopping !== undefined) return stopping;
      stopped = true;
      stopping = (async () => {
        queue.close();
        for (const wake of [...wakers]) wake();
        for (const unsubscribe of unsubscribes.splice(0)) await unsubscribe();
        await Promise.allSettled([...active]);
        await host.dispose();
        writer?.release();
        writer = undefined;
      })();
      return stopping;
    },
  };
}
