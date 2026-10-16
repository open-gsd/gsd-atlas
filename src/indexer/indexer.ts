import { WriterBusy } from '../fact-store/index.ts';
import type { Writer } from '../fact-store/index.ts';
import type { WorktreeInfo } from '../source-tree/index.ts';
import { runBuild } from './build.ts';
import { DEFAULT_INDEXER_CONFIG } from './defaults.ts';
import type { EventSource } from './event-source.ts';
import { createPathFilter } from './ignore.ts';
import { createModuleHost } from './modules.ts';
import { isRepoRelative, realRoot, staysInside } from './paths.ts';
import { createPathLocks, processBatch } from './process.ts';
import type { PathResult, ProcessContext, ProcessCounters } from './process.ts';
import { createCoalescingQueue } from './queue.ts';
import { IndexerError } from './types.ts';
import type {
  BuildResult,
  FailedPath,
  FreshResult,
  Indexer,
  IndexerConfig,
  IndexerDeps,
  IndexerNotice,
  IndexerStatus,
  WatchProblemRecord,
} from './types.ts';

const finiteAtLeast0 = (value: number): boolean => Number.isFinite(value) && value >= 0;
const integerAtLeast0 = (value: number): boolean => Number.isInteger(value) && value >= 0;
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (worktree: string, rel: string): string => `${worktree}\0${rel}`;

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

const codeOf = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'internal_error';
};

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
  let requests = 0;
  let lastIndexedAt: number | null = null;
  /** Sleeps that a stop wakes early. */
  const wakers = new Set<() => void>();
  /** Work in progress, so `stop()` can wait for it. */
  const active = new Set<Promise<unknown>>();
  const worktrees = new Map<string, WorktreeInfo>();
  const unsubscribes: Array<() => Promise<void>> = [];
  const problems = new Map<string, WatchProblemRecord>();
  const failures = new Map<string, FailedPath>();
  const counters: ProcessCounters = { batched: 0, running: 0 };

  /** A listener that throws must not stop the queue. */
  const notify = (notice: IndexerNotice): void => {
    try {
      deps.onNotice?.(notice);
    } catch {
      // ignored on purpose
    }
  };

  const ctx: ProcessContext = {
    tenant: deps.tenant,
    tree: deps.tree,
    store: deps.store,
    governor: deps.governor,
    host,
    filter: createPathFilter(deps.tree),
    locks: createPathLocks(),
    counters,
    config,
    notice: notify,
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

  /**
   * Record what a batch did: failures stay in `status().failed` until the path succeeds, every outcome that touched
   * the store is an `indexed` notice with its lag, and a failure is a `failed` notice.
   */
  function account(worktree: string, results: readonly PathResult[], firstAt: ReadonlyMap<string, number>, startedAt: number): void {
    const now = deps.clock.now();
    for (const result of results) {
      const key = keyOf(worktree, result.path);
      if (result.outcome === 'failed') {
        const code = result.code ?? 'internal_error';
        failures.set(key, { worktree, path: result.path, code });
        notify({ kind: 'failed', worktree, path: result.path, code });
        continue;
      }
      failures.delete(key);
      if (result.outcome === 'skipped') continue;
      lastIndexedAt = now;
      notify({ kind: 'indexed', worktree, path: result.path, lagMs: Math.max(0, now - (firstAt.get(result.path) ?? startedAt)) });
    }
  }

  /** One batch of due queue entries. Never throws: a queue job that cannot run is a failure of each of its paths. */
  async function runQueued(worktree: string, paths: readonly string[], firstAt: ReadonlyMap<string, number>): Promise<void> {
    if (stopped) return;
    const startedAt = deps.clock.now();
    try {
      await resolveWorktree(worktree, false);
      const results = await processBatch(ctx, takeWriter(), worktree, paths, { job: { cls: 'indexing' } });
      account(worktree, results, firstAt, startedAt);
    } catch (error) {
      if (error instanceof IndexerError && error.code === 'stopped') return;
      const code = codeOf(error);
      account(worktree, paths.map((path): PathResult => ({ path, outcome: 'failed', code })), firstAt, startedAt);
    }
  }

  const queue = createCoalescingQueue({
    clock: deps.clock,
    debounceMs: config.debounceMs,
    maxWaitMs: config.maxWaitMs,
    onBatch: (worktree, paths, firstAt) => track(runQueued(worktree, paths, firstAt)),
  });

  function submit(worktree: string, path: string): void {
    if (stopped || !isRepoRelative(path)) return;
    queue.submit(worktree, path);
  }

  async function ensureFresh(worktree: string, paths: readonly string[], waitMs: number = config.ensureFreshWaitMs): Promise<FreshResult> {
    assertRunning();
    // The wait starts now, before anything is awaited, so a caller that advances the clock right away is counted.
    let cancelWait: () => void = () => {};
    const timedOut = new Promise<'timeout'>((resolve) => {
      cancelWait = deps.clock.after(waitMs, () => {
        resolve('timeout');
      });
    });
    try {
      await resolveWorktree(worktree, false);
      const root = await realRoot(worktree);
      const invalid: string[] = [];
      const valid = new Set<string>();
      const seen = new Set<string>();
      for (const rel of paths) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        // Refused here, before any read or hash: agent-supplied strings never reach the file system unchecked (T-02-48).
        if (root !== undefined && isRepoRelative(rel) && (await staysInside(root, rel))) valid.add(rel);
        else invalid.push(rel);
      }
      const sorted = [...valid].sort(compareCodeUnits);
      if (sorted.length === 0) return { complete: true, stalePaths: [], invalid };

      const fresh = takeWriter();
      // Entries waiting for their debounce are superseded: this request indexes those paths now, under the fresh class.
      const taken = queue.flushNow(worktree, sorted);
      const startedAt = deps.clock.now();
      requests += 1;
      const done = new Map<string, PathResult>();
      const work = track(
        processBatch(ctx, fresh, worktree, sorted, {
          job: { cls: 'fresh', requestId: `fresh-${String(requests)}` },
          onResult: (result) => {
            done.set(result.path, result);
          },
        }).then((results) => {
          account(worktree, results, taken, startedAt);
        }),
      );
      // After a timeout the work carries on in the background; its failure must not become an unhandled rejection.
      work.catch(() => {});
      await Promise.race([work, timedOut]);

      const stale = sorted.filter((rel) => {
        const result = done.get(rel);
        return result === undefined || result.outcome === 'failed';
      });
      return { complete: stale.length === 0, stalePaths: stale, invalid };
    } finally {
      cancelWait();
    }
  }

  function status(): IndexerStatus {
    return {
      queued: queue.pending() + Math.max(0, counters.batched - counters.running),
      running: counters.running,
      failed: [...failures.values()].sort(
        (a, b) => compareCodeUnits(a.worktree, b.worktree) || compareCodeUnits(a.path, b.path),
      ),
      lastIndexedAt,
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
          const startedAt = deps.clock.now();
          return runBuild(ctx, takeWriter(), { worktree, ref }, (results, departed) => {
            account(worktree, results, new Map(), startedAt);
            for (const rel of departed) failures.delete(keyOf(worktree, rel));
          });
        })(),
      );
    },

    submit,

    ensureFresh,

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
