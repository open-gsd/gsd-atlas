import { WriterBusy } from '../fact-store/index.ts';
import type { Writer } from '../fact-store/index.ts';
import type { WorktreeInfo } from '../source-tree/index.ts';
import { runBuild } from './build.ts';
import { DEFAULT_INDEXER_CONFIG } from './defaults.ts';
import { createModuleHost } from './modules.ts';
import type { ProcessContext } from './process.ts';
import { IndexerError } from './types.ts';
import type { BuildResult, Indexer, IndexerConfig, IndexerDeps } from './types.ts';

const finiteAtLeast0 = (value: number): boolean => Number.isFinite(value) && value >= 0;
const integerAtLeast0 = (value: number): boolean => Number.isInteger(value) && value >= 0;

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

  const ctx: ProcessContext = {
    tenant: deps.tenant,
    tree: deps.tree,
    store: deps.store,
    governor: deps.governor,
    host,
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

    submit(): void {
      // The coalescing queue arrives with the next task of this plan.
    },

    ensureFresh() {
      return Promise.reject(new Error('the indexer ensureFresh is not implemented yet'));
    },

    attach() {
      return Promise.reject(new Error('the indexer attach is not implemented yet'));
    },

    status() {
      return { queued: 0, running: 0, failed: [], lastIndexedAt: null, watchProblems: [] };
    },

    stop(): Promise<void> {
      if (stopping !== undefined) return stopping;
      stopped = true;
      stopping = (async () => {
        for (const wake of [...wakers]) wake();
        await Promise.allSettled([...active]);
        await host.dispose();
        writer?.release();
        writer = undefined;
      })();
      return stopping;
    },
  };
}
