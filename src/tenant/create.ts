/**
 * The Tenant: one repository's composition (tenant-composition ADR decision 5). In the order they depend on each
 * other: the Source Tree the Host built, the store location, the Fact Store with the cross-process writer lease,
 * Metrics beside it, the Indexer (created when something needs it), and Query over the store with the Indexer's
 * `ensureFresh` and the status ports.
 *
 * Nothing is indexed until someone asks for a build (D-11). When the store already indexes worktrees, the
 * Indexer is started for exactly those, so changes are watched and the start-up Reconcile repairs what happened
 * while nothing was running.
 */
import path from 'node:path';
import { UnknownWorktree, WriterBusy, openFactStore, resolveStoreLocation } from '../fact-store/index.ts';
import type { FactStore, MaintenanceResult, Resolver } from '../fact-store/index.ts';
import { okEnvelope } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { IndexerError, createIndexer } from '../indexer/index.ts';
import type { BuildResult, Indexer, IndexerNotice } from '../indexer/index.ts';
import { createNoopMetrics, openMetrics } from '../metrics/index.ts';
import type { Metrics } from '../metrics/index.ts';
import { createQuery, errorEnvelope } from '../query/index.ts';
import type { FreshPort } from '../query/index.ts';
import { DEFAULT_TENANT_TUNING } from './defaults.ts';
import { createIdleMaintainer } from './idle.ts';
import { answerEvent } from './record.ts';
import { createStatusPort } from './status-port.ts';
import { BUILD_SCHEMA, MAINTAIN_SCHEMA, STATUS_SCHEMA } from './types.ts';
import type { MaintainOptions, MaintainTask, TaskReport, Tenant, TenantDeps, TenantStatus, TenantTuning } from './types.ts';

/** The tasks `all` runs, in this order. */
const ALL_TASKS = ['reconcile', 'resolve', 'refresh', 'collect', 'compact', 'check'] as const;
type SingleTask = (typeof ALL_TASKS)[number];

/** The tasks that work on one worktree's overlay, so the worktree must have been built. */
const WORKTREE_TASKS: ReadonlySet<SingleTask> = new Set<SingleTask>(['reconcile', 'refresh']);

/**
 * The most slices one store task is run in before it is reported incomplete. A task that reports complete ends at
 * once; this only stops one that never does. Not a timeout, a queue bound or a gate threshold, so it has no row in
 * 02-CONSTANTS.md.
 */
const MAX_SLICES = 10_000;

/** Phase 2 has no precise tier: the store's resolver resolves nothing, and every edge stays grammar-tier. */
const noPreciseTier: Resolver = async function* () {
  // resolves nothing
};

const ignore = (): void => {};

const codeOf = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'internal_error';
};

/** What a finished build reports: counts only, so no repository path or text reaches the envelope. */
function buildData(worktree: string, result: BuildResult): Record<string, unknown> {
  const failedCodes: Record<string, number> = {};
  for (const failure of result.failed) failedCodes[failure.code] = (failedCodes[failure.code] ?? 0) + 1;
  return {
    worktree,
    files: result.files,
    parsed: result.parsed,
    linked: result.linked,
    removed: result.removed,
    skipped: result.skipped.length,
    failed: result.failed.length,
    failedCodes,
  };
}

export async function createTenant(deps: TenantDeps): Promise<Tenant> {
  const tuning: TenantTuning = { ...DEFAULT_TENANT_TUNING, ...deps.tuning };
  const { tree, identity, clock, governor } = deps;
  const roots = { ...deps.roots, repoRoot: deps.repoDir };

  const location = resolveStoreLocation({
    storeId: identity.storeId,
    commonDir: identity.commonDir,
    repoDir: deps.repoDir,
    cacheRoot: deps.cacheRoot,
    ...(deps.storeDir === undefined ? {} : { override: deps.storeDir }),
  });

  // Lease changes arrive through `onLeaseChange` and are applied one at a time, once the store exists (see below).
  let closed = false;
  let leaseLost = false;
  let leaseWork: Promise<void> = Promise.resolve();
  let storeOpened: () => void = () => {};
  const storeReady = new Promise<void>((resolve) => {
    storeOpened = resolve;
  });
  const onLeaseChange = (held: boolean): void => {
    if (closed) return;
    leaseWork = leaseWork
      .then(() => storeReady)
      .then(() => applyLease(held))
      .catch(ignore);
  };

  const store: FactStore = await (deps.openStore ?? openFactStore)(
    location.dir,
    { resolver: noPreciseTier, clock, gitHas: (hash) => tree.hasObject(hash) },
    {
      lease: 'acquire',
      takeover: { retryMinMs: tuning.takeoverRetryMinMs, retryMaxMs: tuning.takeoverRetryMaxMs },
      onLeaseChange,
      ...(deps.version === undefined ? {} : { version: deps.version }),
      ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
    },
  );
  storeOpened();
  const metrics: Metrics =
    deps.metrics === false
      ? createNoopMetrics('disabled')
      : typeof deps.metrics === 'object'
        ? deps.metrics
        : await openMetrics(path.join(location.dir, 'metrics.db'), { clock });

  /**
   * Recording never alters or delays an answer (MET-02, T-02-99): it runs after the envelope exists, and whatever it
   * throws is dropped. Metrics itself never throws; an injected double might.
   */
  const recording = (work: () => void): void => {
    try {
      work();
    } catch {
      // a metrics failure is not the caller's problem
    }
  };

  /** The Indexer's notices feed the freshness panel: how long a changed path waited before it was indexed. */
  const onIndexerNotice = (notice: IndexerNotice): void => {
    if (notice.kind !== 'indexed') return;
    recording(() => {
      metrics.record({ kind: 'freshness', lagMs: notice.lagMs });
    });
  };

  let indexer: Indexer | undefined;
  let closing: Promise<void> | undefined;
  let startError: string | undefined;

  /** The Indexer of this tenant, created on first need. Never after close, never without the writer lease (STO-08). */
  function getIndexer(): Indexer {
    if (closed || closing !== undefined) throw new IndexerError('stopped', 'the tenant was closed');
    if (indexer === undefined) {
      const source = deps.eventSource?.();
      const indexerDeps = {
        tenant: identity.storeId,
        tree,
        store,
        engine: deps.engine,
        roots,
        governor,
        clock,
        onNotice: onIndexerNotice,
        ...(source === undefined ? {} : { source }),
        ...(deps.indexer === undefined ? {} : { config: deps.indexer }),
      };
      indexer = (deps.indexerFactory ?? createIndexer)(indexerDeps);
    }
    return indexer;
  }

  const leaseHeld = (): Envelope =>
    errorEnvelope(
      'lease_held',
      'Another gsd-atlas process holds the writer for this repository, so this process cannot index or run maintenance. Use that process, or stop it first.',
    );

  const notIndexed = (): Envelope =>
    errorEnvelope('not_indexed', 'This repository has not been indexed yet. Run "gsd-atlas build" in it, then ask again.');

  /** An error that ends a request as an envelope; anything else is a bug and goes on. */
  function failure(error: unknown): Envelope {
    if (error instanceof WriterBusy) return leaseHeld();
    if (error instanceof UnknownWorktree) return notIndexed();
    if (error instanceof IndexerError) {
      if (error.code === 'lease_held') return leaseHeld();
      if (error.code === 'unknown_worktree') return errorEnvelope('unknown_worktree', 'That directory is not a worktree of the repository.');
      return errorEnvelope('tenant_closed', 'The repository was closed while the request ran.');
    }
    throw error;
  }

  /** True when this process holds the writer lease: the only process that indexes or runs maintenance (STO-08). */
  const isLeader = async (): Promise<boolean> => !leaseLost && (await store.status()).writerLeaseHeld;

  /** True when the store has an overlay for `worktree`, that is, somebody built it. */
  const isIndexed = async (worktree: string): Promise<boolean> =>
    (await store.status()).worktrees.some((entry) => entry.worktree === worktree);

  /**
   * Query's read-your-writes port. A worktree nobody built is never indexed because a request named paths (D-11).
   * A follower can not index: it answers that the paths are not done, and Query degrades the answer with
   * `fresh_timeout` until plan 02-27 gives followers an in-memory overlay.
   */
  const fresh: FreshPort = {
    async ensureFresh(worktree, paths, waitMs) {
      const status = await store.status();
      if (!status.worktrees.some((entry) => entry.worktree === worktree)) {
        return { complete: true, stalePaths: [], invalid: [] };
      }
      if (leaseLost || !status.writerLeaseHeld) return { complete: false, stalePaths: [...paths], invalid: [] };
      return getIndexer().ensureFresh(worktree, paths, waitMs);
    },
  };

  const query = createQuery({
    store,
    text: tree,
    fresh,
    status: createStatusPort({ store, indexer: () => indexer, governor, roots }),
    clock,
  });

  // The start-up Reconcile (D-02). While an Indexer started for the worktrees the store already indexes has not
  // finished, `starting` is set: the first request waits for it, but only up to the approved deadline, and every
  // answer says `reconciling` until it settles. `starting` never rejects; a failure becomes `startError`.
  let starting: Promise<void> | undefined;
  let startAttempted = false;
  let gate: Promise<void> | undefined;
  let cancelGate: (() => void) | undefined;

  /**
   * Start the Indexer for `indexed`, the worktrees the store already indexes (the ones git still lists). Only a
   * writer-lease holder calls this (STO-08), and never twice at once.
   */
  function beginIndexing(indexed: readonly string[]): void {
    if (closed || starting !== undefined || indexed.length === 0) return;
    startError = undefined;
    const work = (async () => {
      const listed = new Set((await tree.worktrees()).filter((entry) => !entry.bare).map((entry) => entry.path));
      const targets = indexed.filter((worktree) => listed.has(worktree));
      if (targets.length === 0 || closed) return;
      startAttempted = true;
      await getIndexer().start({ worktrees: targets });
    })();
    const mine: Promise<void> = work
      .catch((error: unknown) => {
        startError = codeOf(error);
      })
      .then(() => {
        if (starting === mine) starting = undefined;
        cancelGate?.();
        gate = undefined;
      });
    starting = mine;
  }

  /**
   * Wait for the start-up to settle or for the approved deadline, whichever comes first. The deadline timer is
   * cancelled when start finishes first, and by `close()`. Requests that arrive meanwhile share the one wait; once the
   * deadline has passed a later request does not wait again.
   */
  function startupGate(): Promise<void> {
    if (starting === undefined) return Promise.resolve();
    gate ??= new Promise<void>((resolve) => {
      const cancel = clock.after(tuning.startupReconcileDeadlineMs, () => {
        cancelGate = undefined;
        resolve();
      });
      cancelGate = () => {
        cancelGate = undefined;
        gate = undefined;
        cancel();
        resolve();
      };
    });
    return gate;
  }

  /** Gaining the lease (a follower took over): start indexing what the store indexes, once. */
  async function applyLease(held: boolean): Promise<void> {
    if (closed) return;
    if (held) {
      leaseLost = false;
      if (indexer !== undefined || starting !== undefined) return;
      beginIndexing((await store.status()).worktrees.map((entry) => entry.worktree));
      return;
    }
    // Lost: no Indexer, watcher or writer task may outlive the lease. Behave as a follower from here on.
    leaseLost = true;
    const running = indexer;
    indexer = undefined;
    if (running !== undefined) await running.stop().catch(ignore);
  }

  // Idle maintenance (STO-10). The counters feed `status().idle`; a failed step is counted and swallowed.
  let idleRounds = 0;
  let idleLastRoundAt: number | null = null;
  let idleFailedSteps = 0;

  /**
   * Record the index-health gauge: files and stale paths summed over the overlays the store holds, the paths the
   * Indexer gave up on, and the store size. Counts only (MET-02). `flush` writes it now.
   */
  async function recordHealth(flush: boolean): Promise<void> {
    const storeStatus = await store.status();
    let files = 0;
    let staleFiles = 0;
    for (const entry of storeStatus.worktrees) {
      files += entry.files;
      staleFiles += entry.stalePaths;
    }
    const errorFiles = indexer?.status().failed.length ?? 0;
    recording(() => {
      metrics.record({ kind: 'index_health', files, errorFiles, staleFiles, sizeBytes: storeStatus.sizeBytes });
    });
    if (flush) {
      try {
        await metrics.flush();
      } catch {
        // the gauge is still queued
      }
    }
  }

  type Attempt<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'busy' } | { readonly kind: 'failed' };

  /**
   * One step of an idle round, submitted to the Governor at the maintenance class. A busy Governor ends the round
   * quietly (the next quiet period tries again); a step that throws is counted and the next step still runs.
   */
  async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
    try {
      const outcome = await governor.run({ tenant: identity.storeId, class: 'maintenance', cost: 1 }, work);
      if (outcome.kind === 'ok') return { kind: 'ok', value: outcome.value };
      if (outcome.kind === 'busy') return { kind: 'busy' };
    } catch {
      // counted below
    }
    idleFailedSteps += 1;
    return { kind: 'failed' };
  }

  /**
   * One slice of store upkeep. The store's `maintain` takes the in-process writer slot, which a running Indexer holds;
   * then `collect` and `compact` (which need the lease, not the slot) do the same work, and `check` closes the pass.
   */
  async function maintenanceSlice(): Promise<MaintenanceResult> {
    try {
      return await store.maintain(tuning.maintenanceSliceMs);
    } catch (error) {
      if (!(error instanceof WriterBusy)) throw error;
    }
    const collected = await store.collect({ budgetMs: tuning.maintenanceSliceMs });
    const compacted = await store.compact({ budgetMs: tuning.maintenanceSliceMs });
    const complete = collected.complete && compacted.complete;
    if (complete) await store.check();
    return {
      complete,
      spentMs: collected.spentMs + compacted.spentMs,
      processed: collected.processed + compacted.processed,
    };
  }

  /**
   * One idle round (STO-10): on the lease holder the store upkeep in slices until complete, then a refresh of each
   * worktree the Indexer covers; on every process the metrics rollup and the index-health gauge. It checks
   * `shouldYield` before every step and stops quietly when a request has arrived.
   */
  async function idleRound(shouldYield: () => boolean): Promise<void> {
    if (closed) return;
    if (await isLeader().catch(() => false)) {
      let complete = false;
      for (let slice = 0; slice < MAX_SLICES && !complete; slice += 1) {
        if (shouldYield()) return;
        const step = await attempt(maintenanceSlice);
        if (step.kind === 'busy') return;
        if (step.kind === 'failed') break;
        complete = step.value.complete;
      }
      if (indexer !== undefined) {
        const listed = await tree
          .worktrees()
          .then((entries) => new Set(entries.filter((entry) => !entry.bare).map((entry) => entry.path)))
          .catch(() => new Set<string>());
        for (const entry of (await store.status()).worktrees) {
          if (!listed.has(entry.worktree)) continue;
          if (shouldYield()) return;
          const step = await attempt(() => getIndexer().refresh(entry.worktree));
          if (step.kind === 'busy') return;
        }
      }
    }
    if (shouldYield()) return;
    if ((await attempt(() => metrics.rollup())).kind === 'busy') return;
    if (shouldYield()) return;
    if ((await attempt(() => recordHealth(true))).kind === 'busy') return;
    idleRounds += 1;
    idleLastRoundAt = clock.now();
  }

  const idle = createIdleMaintainer({
    clock,
    idleAfterMs: tuning.idleAfterMs,
    run: idleRound,
    onError() {
      idleFailedSteps += 1;
    },
  });

  const opening = await store.status();
  // A follower starts nothing: no Indexer, no watcher. It starts one when it takes over (`applyLease`).
  if (opening.writerLeaseHeld) beginIndexing(opening.worktrees.map((entry) => entry.worktree));

  async function snapshot(): Promise<TenantStatus> {
    const storeStatus = await store.status();
    return {
      storeId: identity.storeId,
      location,
      leader: !leaseLost && storeStatus.writerLeaseHeld,
      store: storeStatus,
      indexer: indexer?.status() ?? null,
      governor: governor.status(),
      metrics: metrics.status(),
      startup: starting !== undefined ? 'pending' : startAttempted ? 'ready' : 'none',
      idle: { lastRoundAt: idleLastRoundAt, rounds: idleRounds, failedSteps: idleFailedSteps },
      ...(startError === undefined ? {} : { startError }),
    };
  }

  /**
   * A store task run in time-boxed slices (the approved `maintenance.sliceMs`) until it reports complete. Each call
   * is resumable and idempotent, so a task that did not finish is simply called again.
   */
  async function sliced(call: (budgetMs: number) => Promise<MaintenanceResult>): Promise<TaskReport> {
    let processed = 0;
    let spentMs = 0;
    for (let slice = 0; slice < MAX_SLICES; slice += 1) {
      const result = await call(tuning.maintenanceSliceMs);
      processed += result.processed;
      spentMs += result.spentMs;
      if (result.complete) return { complete: true, spentMs, processed };
    }
    return { complete: false, spentMs, processed };
  }

  /**
   * One maintenance task. `collect`, `compact` and `check` call the store directly: they need write authority (the
   * lease) but not the in-process writer slot, which the Indexer holds, so they run while it indexes. The store's own
   * `maintain` wrapper takes that slot and would answer `WriterBusy` here.
   */
  async function runTask(task: SingleTask, options: MaintainOptions): Promise<TaskReport> {
    const started = clock.now();
    const took = (): number => Math.max(0, clock.now() - started);
    switch (task) {
      case 'reconcile': {
        const outcome = await getIndexer().reconcile(options.worktree);
        return { complete: true, spentMs: outcome.durationMs, processed: outcome.changed };
      }
      case 'resolve':
        return { complete: true, spentMs: 0, processed: 0, note: 'no precise tier is active' };
      case 'refresh': {
        const { processed } = await getIndexer().refresh(options.worktree);
        return { complete: true, spentMs: took(), processed };
      }
      case 'collect':
        return sliced((budgetMs) => store.collect({ budgetMs }));
      case 'compact':
        return sliced((budgetMs) => store.compact({ budgetMs, ...(options.full === true ? { full: true } : {}) }));
      case 'check': {
        const result = await store.check();
        return { complete: true, spentMs: took(), processed: result.problems.length, ok: result.ok };
      }
    }
  }

  return {
    storeId: identity.storeId,
    location,

    async handle(request: Request, worktree: string): Promise<Envelope> {
      const started = clock.now();
      idle.touch();
      await startupGate();
      const answered = await query.ask({ ...request, worktree });
      // Until the start-up Reconcile settles, an answer may lag the working tree: say so (D-02).
      const envelope =
        answered.ok && starting !== undefined && !(answered.degraded ?? []).includes('reconciling')
          ? { ...answered, degraded: [...(answered.degraded ?? []), 'reconciling' as const] }
          : answered;
      recording(() => {
        const event = answerEvent(request.kind, envelope, clock.now() - started);
        if (event !== null) metrics.record(event);
      });
      idle.touch();
      return envelope;
    },

    async build(worktree: string): Promise<Envelope> {
      idle.touch();
      try {
        if (!(await isLeader())) return leaseHeld();
        const ix = getIndexer();
        const result = await ix.build(worktree);
        await ix.attach(worktree);
        // The dashboard's index-health panel fills after a build, not only after the first idle round.
        await recordHealth(false).catch(ignore);
        return okEnvelope(BUILD_SCHEMA, buildData(worktree, result));
      } catch (error) {
        return failure(error);
      } finally {
        idle.touch();
      }
    },

    async maintain(task: MaintainTask, options: MaintainOptions): Promise<Envelope> {
      const tasks: readonly SingleTask[] = task === 'all' ? ALL_TASKS : [task];
      idle.touch();
      try {
        // Only `resolve` (a no-op while no precise tier is active) needs neither the writer nor an overlay.
        if (tasks.some((each) => each !== 'resolve') && !(await isLeader())) return leaseHeld();
        if (tasks.some((each) => WORKTREE_TASKS.has(each)) && !(await isIndexed(options.worktree))) return notIndexed();
        const reports: Partial<Record<SingleTask, TaskReport>> = {};
        for (const each of tasks) reports[each] = await runTask(each, options);
        return okEnvelope(MAINTAIN_SCHEMA, { tasks: reports });
      } catch (error) {
        return failure(error);
      } finally {
        idle.touch();
      }
    },

    status: snapshot,

    async statusEnvelope(sinceMs: number): Promise<Envelope> {
      const until = clock.now();
      const range = { since: until - sinceMs, until };
      // An answer served a moment ago is still in the recorder queue; write it so the report shows it.
      try {
        await metrics.flush();
      } catch {
        // the report below still answers, from what is stored
      }
      const [report, tenant] = await Promise.all([metrics.report(range), snapshot()]);
      return okEnvelope(STATUS_SCHEMA, { range, report, tenant });
    },

    close(): Promise<void> {
      // First thing: nothing may start in a closing Tenant, whatever lease change or start-up is still in flight.
      closed = true;
      closing ??= (async () => {
        cancelGate?.();
        // No idle timer may outlive the Tenant, and a round in flight is asked to yield and awaited.
        await idle.close();
        await leaseWork.catch(ignore);
        const running = indexer;
        if (running !== undefined) await running.stop().catch(ignore);
        await starting?.catch(ignore);
        // The start-up may have created the Indexer after the stop above looked; it is stopped now.
        if (indexer !== undefined && indexer !== running) await indexer.stop().catch(ignore);
        await metrics.close();
        await store.close();
      })();
      return closing;
    },
  };
}
