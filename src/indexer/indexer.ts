import { UnknownWorktree, WriterBusy } from '../fact-store/index.ts';
import type { Writer } from '../fact-store/index.ts';
import type { WorktreeInfo } from '../source-tree/index.ts';
import { runBuild } from './build.ts';
import { DEFAULT_INDEXER_CONFIG } from './defaults.ts';
import type { EventSource, GitHandler, GitSourceEvent, SourceEvent, SourceHandler } from './event-source.ts';
import { createPathFilter } from './ignore.ts';
import { createModuleHost } from './modules.ts';
import { isRepoRelative, realRoot, staysInside } from './paths.ts';
import { createPathLocks, processBatch } from './process.ts';
import type { PathResult, ProcessContext, ProcessCounters } from './process.ts';
import { createCoalescingQueue } from './queue.ts';
import { reconcileWorktree } from './reconcile.ts';
import type { ReconcilePriority } from './reconcile.ts';
import { IndexerError } from './types.ts';
import { eligibleWorktrees, syncWorktrees } from './worktrees.ts';
import type {
  BuildResult,
  FailedPath,
  FreshResult,
  Indexer,
  IndexerConfig,
  IndexerDeps,
  IndexerNotice,
  IndexerStatus,
  LastReconcile,
  ReconcileOutcome,
  RefreshOutcome,
  StartOptions,
  WatchProblemRecord,
} from './types.ts';

/**
 * How many stale paths one refresh hands to batch processing at a time. Like the Reconcile chunk it is not a
 * timeout, a queue bound or a gate threshold, so it has no row in 02-CONSTANTS.md: it only bounds how much one
 * Governor submission holds.
 */
const REFRESH_CHUNK = 256;

const finiteAtLeast0 = (value: number): boolean => Number.isFinite(value) && value >= 0;
const integerAtLeast0 = (value: number): boolean => Number.isInteger(value) && value >= 0;
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (worktree: string, rel: string): string => `${worktree}\0${rel}`;
const ignore = (): void => {};

function resolveConfig(partial: Partial<IndexerConfig> | undefined): IndexerConfig {
  const config: IndexerConfig = { ...DEFAULT_INDEXER_CONFIG, ...partial };
  for (const key of ['debounceMs', 'maxWaitMs', 'ensureFreshWaitMs', 'idleReconcileIntervalMs'] as const) {
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

/** One worktree's Reconcile bookkeeping: the run in progress, and the one run waiting to follow it. */
interface ReconcileSlot {
  current?: Promise<ReconcileOutcome>;
  next?: Promise<ReconcileOutcome>;
}

/** A worktree the Indexer covers: the name of its git directory and its file subscription, when it has one. */
interface Covered {
  /** `''` for the main worktree, else the name under `<common git directory>/worktrees/`. */
  readonly gitDirName: string;
  unsubscribe?: () => Promise<void>;
}

const sumOutcomes = (outcomes: readonly ReconcileOutcome[]): ReconcileOutcome => {
  const [only] = outcomes;
  if (outcomes.length === 1 && only !== undefined) return only;
  return outcomes.reduce<ReconcileOutcome>(
    (total, each) => ({
      changed: total.changed + each.changed,
      parsed: total.parsed + each.parsed,
      linked: total.linked + each.linked,
      removed: total.removed + each.removed,
      durationMs: Math.max(total.durationMs, each.durationMs),
    }),
    { changed: 0, parsed: 0, linked: 0, removed: 0, durationMs: 0 },
  );
};

/**
 * The Indexer: the only writer client of the Fact Store. It takes the writer slot lazily, on the first thing that
 * needs it, and gives it back in `stop()`.
 *
 * Events make it quick, Reconcile makes it right (IDX-03, D-13): a Reconcile runs on start, on any watcher
 * problem, and periodically while idle, so an event that never arrived is repaired by the next run.
 */
export function createIndexer(deps: IndexerDeps): Indexer {
  const config = resolveConfig(deps.config);
  const host = createModuleHost({ engine: deps.engine, roots: deps.roots });

  let writer: Writer | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let requests = 0;
  let lastIndexedAt: number | null = null;
  let lastReconcile: LastReconcile | null = null;
  /** The source events arrive from: the one in the dependencies, or the one a legacy `attach` was given. */
  let activeSource: EventSource | undefined = deps.source;
  /** True once a subscription could not start; answers stay fresh through Reconcile alone. */
  let degraded = false;
  let idleCancel: (() => void) | undefined;
  /** True when `start()` was asked for every worktree: one that appears later is covered too. */
  let coverAll = false;
  let gitUnsubscribe: (() => Promise<void>) | undefined;
  let gitSubscribed = false;
  let commonDirOnce: Promise<string> | undefined;
  /** Worktree set changes are applied one at a time, in the order they were reported. */
  let syncTail: Promise<void> = Promise.resolve();
  /** Sleeps that a stop wakes early. */
  const wakers = new Set<() => void>();
  /** Work in progress, so `stop()` can wait for it. */
  const active = new Set<Promise<unknown>>();
  const worktrees = new Map<string, WorktreeInfo>();
  const unsubscribes: Array<() => Promise<void>> = [];
  const problems = new Map<string, WatchProblemRecord>();
  const failures = new Map<string, FailedPath>();
  const counters: ProcessCounters = { batched: 0, running: 0 };
  /** The worktrees `start` and `attach` cover, by root. */
  const covered = new Map<string, Covered>();
  const slots = new Map<string, ReconcileSlot>();
  /** For each worktree with a Reconcile running: the paths other jobs committed since it began. */
  const touchedPaths = new Map<string, Set<string>>();

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
    ...(deps.outputFilter === undefined ? {} : { outputFilter: deps.outputFilter }),
    locks: createPathLocks(),
    counters,
    config,
    notice: notify,
    now: () => deps.clock.now(),
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

  /** Ask git for the worktrees again and remember them by root. */
  async function listWorktrees(): Promise<readonly WorktreeInfo[]> {
    const listed = await deps.tree.worktrees();
    worktrees.clear();
    for (const info of listed) worktrees.set(info.path, info);
    return listed;
  }

  /** The worktree Source Tree lists under `id`. A build asks git again so the ref it records is current. */
  async function resolveWorktree(id: string, refresh: boolean): Promise<WorktreeInfo> {
    const cached = refresh ? undefined : worktrees.get(id);
    if (cached !== undefined) return cached;
    await listWorktrees();
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

  /** Told as each path of a queue batch or an `ensureFresh` reaches its result: a Reconcile running now must not undo it. */
  function noteCommitted(worktree: string, result: PathResult): void {
    if (result.outcome === 'parsed' || result.outcome === 'linked' || result.outcome === 'removed') {
      touchedPaths.get(worktree)?.add(result.path);
    }
  }

  /** One batch of due queue entries. Never throws: a queue job that cannot run is a failure of each of its paths. */
  async function runQueued(worktree: string, paths: readonly string[], firstAt: ReadonlyMap<string, number>): Promise<void> {
    if (stopped) return;
    const startedAt = deps.clock.now();
    try {
      await resolveWorktree(worktree, false);
      const results = await processBatch(ctx, takeWriter(), worktree, paths, {
        job: { cls: 'indexing' },
        onResult: (result) => {
          noteCommitted(worktree, result);
        },
      });
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
            noteCommitted(worktree, result);
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

  /** One Reconcile of one worktree, from the refreshed ref to the recorded overlay. */
  async function executeReconcile(worktree: string, priority: ReconcilePriority): Promise<ReconcileOutcome> {
    assertRunning();
    const info = await resolveWorktree(worktree, true);
    const ref = info.branch ?? info.head ?? 'HEAD';
    const startedAt = deps.clock.now();
    const touched = new Set<string>();
    touchedPaths.set(worktree, touched);
    try {
      const report = await reconcileWorktree(ctx, takeWriter(), { worktree, ref }, priority, {
        touched,
        observe: (results, departed) => {
          account(worktree, results, new Map(), startedAt);
          for (const rel of departed) failures.delete(keyOf(worktree, rel));
        },
      });
      lastReconcile = { at: deps.clock.now(), changed: report.changed, durationMs: report.durationMs };
      return {
        changed: report.changed,
        parsed: report.parsed,
        linked: report.linked,
        removed: report.removed,
        durationMs: report.durationMs,
      };
    } finally {
      touchedPaths.delete(worktree);
    }
  }

  /**
   * Ask for a Reconcile of `worktree`. A plain request shares the run in progress, if any. A `trailing` request
   * (a HEAD change, a watcher problem) needs a run that BEGINS after the request, because the run in progress may
   * have taken its snapshot before the change: it waits for that run and then shares one follow-up run.
   */
  function requestReconcile(worktree: string, priority: ReconcilePriority, trailing: boolean): Promise<ReconcileOutcome> {
    const slot = slots.get(worktree) ?? {};
    slots.set(worktree, slot);
    const begin = (): Promise<ReconcileOutcome> => {
      const run: Promise<ReconcileOutcome> = track(
        executeReconcile(worktree, priority).finally(() => {
          if (slot.current === run) slot.current = undefined;
        }),
      );
      slot.current = run;
      return run;
    };
    if (slot.current === undefined) return begin();
    if (!trailing) return slot.current;
    slot.next ??= slot.current.then(ignore, ignore).then(() => {
      slot.next = undefined;
      return slot.current ?? begin();
    });
    return slot.next;
  }

  /** Start a Reconcile nobody waits for; its failure is not an error of the caller. */
  function reconcileInBackground(worktree: string, priority: ReconcilePriority): void {
    if (stopped) return;
    requestReconcile(worktree, priority, true).catch(ignore);
  }

  /** The handler of one worktree's file subscription. A problem is counted and, when `repair` is set, repaired. */
  function fileHandler(worktree: string, repair: boolean): SourceHandler {
    return (event: SourceEvent): void => {
      if (event.kind === 'change') {
        submit(worktree, event.path);
        return;
      }
      const key = `${worktree}\0${event.problem}`;
      const seen = problems.get(key);
      problems.set(key, { worktree, kind: event.problem, count: (seen?.count ?? 0) + 1 });
      if (repair) reconcileInBackground(worktree, 'indexing');
    };
  }

  /** Subscribe the file watch of one worktree root, once. A source that cannot start leaves Reconcile as the only path. */
  async function cover(worktree: string, gitDirName: string): Promise<void> {
    if (covered.has(worktree) || stopped) return;
    const entry: Covered = { gitDirName };
    covered.set(worktree, entry);
    if (activeSource === undefined) return;
    let unsubscribe: () => Promise<void>;
    try {
      unsubscribe = await activeSource.subscribe(worktree, fileHandler(worktree, true));
    } catch {
      degraded = true;
      return;
    }
    if (stopped) {
      // stop() ran while this subscription was opening and found nothing to close: it closes itself.
      await closeLate(unsubscribe);
      return;
    }
    entry.unsubscribe = unsubscribe;
    void hintChanged(activeSource, worktree);
  }

  /** Close a subscription (one that finished opening after stop(), or any one stop() closes); a watcher that fails to stop is not an error. */
  async function closeLate(unsubscribe: () => Promise<void>): Promise<void> {
    try {
      await unsubscribe();
    } catch {
      // a watcher that fails to stop must not keep the Indexer from stopping
    }
  }

  /**
   * The optional start-up hint: the paths the source says changed while nothing was watching are queued, so they
   * are indexed ahead of the Reconcile's walk. It is only a hint (research: the call lagged about 1.5 seconds on
   * macOS), so it is never waited for and every failure of it is ignored; Reconcile is authoritative.
   */
  async function hintChanged(source: EventSource, worktree: string): Promise<void> {
    try {
      for (const rel of (await source.eventsSince?.(worktree)) ?? []) submit(worktree, rel);
    } catch {
      // ignored on purpose
    }
  }

  /** The matching hint at stop: remember where each covered worktree was, for the next start. */
  async function writeHint(source: EventSource, worktree: string): Promise<void> {
    try {
      await source.writeSnapshot?.(worktree);
    } catch {
      // ignored on purpose
    }
  }

  /** The canonical common git directory Source Tree reports: the only directory the git watch is ever pointed at. */
  function commonDirOf(): Promise<string> {
    commonDirOnce ??= deps.tree.identity().then(
      (identity) => identity.commonDir,
      (error: unknown) => {
        commonDirOnce = undefined;
        throw error;
      },
    );
    return commonDirOnce;
  }

  /** What a HEAD change, a worktree change or a problem of the git watch makes the Indexer do. */
  function gitHandler(commonDir: string): GitHandler {
    return (event: GitSourceEvent): void => {
      if (stopped) return;
      if (event.kind === 'head') {
        for (const [root, entry] of covered) {
          if (entry.gitDirName === event.gitDirName) reconcileInBackground(root, 'indexing');
        }
        return;
      }
      if (event.kind === 'worktrees') {
        scheduleSync();
        return;
      }
      const key = `${commonDir}\0${event.problem}`;
      const seen = problems.get(key);
      problems.set(key, { worktree: commonDir, kind: event.problem, count: (seen?.count ?? 0) + 1 });
      for (const root of covered.keys()) reconcileInBackground(root, 'indexing');
      scheduleSync();
    };
  }

  /** Subscribe the git directory, once for the whole repository. */
  async function watchGitDir(commonDir: string): Promise<void> {
    if (activeSource === undefined || gitSubscribed || stopped) return;
    gitSubscribed = true;
    let unsubscribe: () => Promise<void>;
    try {
      unsubscribe = await activeSource.subscribeGit(commonDir, gitHandler(commonDir));
    } catch {
      degraded = true;
      return;
    }
    if (stopped) {
      await closeLate(unsubscribe);
      return;
    }
    gitUnsubscribe = unsubscribe;
  }

  /** Bring the covered worktrees in step with `git worktree list`: subscribe new ones, drop the overlay of gone ones. */
  async function syncNow(): Promise<void> {
    if (stopped) return;
    const listed = await listWorktrees();
    const commonDir = await commonDirOf();
    await syncWorktrees({
      listed,
      commonDir,
      covered: [...covered.keys()],
      addNew: coverAll,
      subscribe: async (root, gitDirName) => {
        await cover(root, gitDirName);
        await requestReconcile(root, 'indexing', false);
      },
      unsubscribe: async (root) => {
        const entry = covered.get(root);
        covered.delete(root);
        try {
          await entry?.unsubscribe?.();
        } catch {
          // a watcher that fails to stop must not keep the worktree from being dropped
        }
      },
      drop: async (root) => {
        for (const key of [...failures.keys()]) if (failures.get(key)?.worktree === root) failures.delete(key);
        try {
          await takeWriter().dropOverlay(root);
        } catch (error) {
          if (!(error instanceof IndexerError)) throw error;
        }
      },
    });
  }

  function scheduleSync(): void {
    if (stopped) return;
    syncTail = syncTail.then(syncNow).catch(ignore);
    track(syncTail);
  }

  /** The idle timer: re-armed first, so a long Reconcile never delays the next tick; runs share per worktree. */
  function armIdle(): void {
    if (stopped || idleCancel !== undefined || config.idleReconcileIntervalMs <= 0) return;
    idleCancel = deps.clock.after(config.idleReconcileIntervalMs, () => {
      idleCancel = undefined;
      if (stopped) return;
      armIdle();
      for (const worktree of covered.keys()) requestReconcile(worktree, 'maintenance', false).catch(ignore);
    });
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
      watchMode: degraded || activeSource === undefined ? 'reconcile-only' : activeSource.watchMode(),
      reconciling: [...slots.values()].some((slot) => slot.current !== undefined),
      lastReconcile,
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

    async start(options: StartOptions = {}): Promise<void> {
      assertRunning();
      const eligible = eligibleWorktrees(await listWorktrees(), await commonDirOf());
      const targets: Array<readonly [string, string]> = [];
      if (options.worktrees === undefined) {
        coverAll = true;
        targets.push(...eligible);
      } else {
        for (const root of options.worktrees) {
          const name = eligible.get(root);
          if (name === undefined) {
            throw new IndexerError('unknown_worktree', `${root} is not a worktree of this repository that can be watched`);
          }
          targets.push([root, name]);
        }
      }
      armIdle();
      // Every subscription first, so an edit made while the first Reconcile runs is not missed.
      await watchGitDir(await commonDirOf());
      for (const [root, name] of targets) await cover(root, name);
      for (const [root] of targets) await requestReconcile(root, 'indexing', false);
    },

    async reconcile(worktree?: string): Promise<ReconcileOutcome> {
      assertRunning();
      const targets = worktree === undefined ? [...covered.keys()] : [worktree];
      return sumOutcomes(await Promise.all(targets.map((each) => requestReconcile(each, 'indexing', false))));
    },

    async attach(first: EventSource | string, roots?: readonly string[]): Promise<void> {
      assertRunning();
      if (typeof first === 'string') {
        const commonDir = await commonDirOf();
        const name = eligibleWorktrees(await listWorktrees(), commonDir).get(first);
        if (name === undefined) {
          throw new IndexerError('unknown_worktree', `${first} is not a worktree of this repository that can be watched`);
        }
        await watchGitDir(commonDir);
        await cover(first, name);
        await requestReconcile(first, 'indexing', false);
        return;
      }
      activeSource ??= first;
      for (const worktree of roots ?? []) {
        const unsubscribe = await first.subscribe(worktree, fileHandler(worktree, false));
        if (stopped) {
          await closeLate(unsubscribe);
          return;
        }
        unsubscribes.push(unsubscribe);
      }
    },

    refresh(worktree: string): Promise<RefreshOutcome> {
      return track(
        (async () => {
          assertRunning();
          await resolveWorktree(worktree, false);
          let stale: readonly string[];
          try {
            // Any path does: the watermark of every read lists the paths whose facts are stale or still pending.
            stale = (await deps.store.at(worktree).fileFacts('')).watermark.stalePaths;
          } catch (error) {
            if (error instanceof UnknownWorktree) {
              throw new IndexerError('unknown_worktree', `${worktree} has not been built, so it has nothing to refresh`);
            }
            throw error;
          }
          if (stale.length === 0) return { processed: 0 };

          const refreshing = takeWriter();
          const startedAt = deps.clock.now();
          let processed = 0;
          for (let from = 0; from < stale.length; from += REFRESH_CHUNK) {
            const results = await processBatch(ctx, refreshing, worktree, stale.slice(from, from + REFRESH_CHUNK), {
              job: { cls: 'maintenance' },
              force: true,
              onResult: (result) => {
                noteCommitted(worktree, result);
              },
            });
            account(worktree, results, new Map(), startedAt);
            processed += results.filter((result) => result.outcome !== 'failed' && result.outcome !== 'skipped').length;
          }
          return { processed };
        })(),
      );
    },

    status,

    stop(): Promise<void> {
      if (stopping !== undefined) return stopping;
      stopped = true;
      stopping = (async () => {
        // Whatever fails below, the module host is disposed and the writer slot is given back (WR-13): a leader
        // that loses and regains the lease must find the slot free.
        try {
          queue.close();
          idleCancel?.();
          idleCancel = undefined;
          for (const wake of [...wakers]) wake();
          for (const unsubscribe of unsubscribes.splice(0)) await closeLate(unsubscribe);
          if (gitUnsubscribe !== undefined) await closeLate(gitUnsubscribe);
          gitUnsubscribe = undefined;
          for (const entry of covered.values()) {
            if (entry.unsubscribe !== undefined) await closeLate(entry.unsubscribe);
          }
          const roots = [...covered.keys()];
          covered.clear();
          while (active.size > 0) await Promise.allSettled([...active]);
          if (activeSource !== undefined) for (const root of roots) await writeHint(activeSource, root);
        } finally {
          try {
            await host.dispose();
          } finally {
            writer?.release();
            writer = undefined;
          }
        }
      })();
      return stopping;
    },
  };
}
