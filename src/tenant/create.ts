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
import { IDLE_MAINTENANCE, StoreClosed, UnknownWorktree, WriterBusy, openFactStore, resolveStoreLocation } from '../fact-store/index.ts';
import type { FactStore, MaintenanceResult, Resolver } from '../fact-store/index.ts';
import { createAnswerId, createSessionId, okEnvelope } from '../facts/index.ts';
import type { Diagnostic, Envelope, ProjectContextProvider, Request } from '../facts/index.ts';
import { DEFAULT_INDEXER_CONFIG, IndexerError, createIndexer, createModuleHost } from '../indexer/index.ts';
import type { BuildResult, Indexer, IndexerNotice, ModuleHost } from '../indexer/index.ts';
import { createNoopMetrics, openMetrics } from '../metrics/index.ts';
import type { Metrics } from '../metrics/index.ts';
import type { PreciseTier } from '../precise-resolver/index.ts';
import { createQuery, errorEnvelope } from '../query/index.ts';
import type { FreshPort } from '../query/index.ts';
import { DEFAULT_TENANT_TUNING } from './defaults.ts';
import { createFollowerFresh } from './follower-overlay.ts';
import { createFlightRecorder } from './flight.ts';
import type { FlightRecorder } from './flight.ts';
import { createIdleMaintainer } from './idle.ts';
import { recordRating } from './rate.ts';
import type { RateInput } from './rate.ts';
import { answerEvent, flightAnswer, isAnsweredKind } from './record.ts';
import { leaseHeldEnvelope, notIndexedEnvelope, storeUnavailableEnvelope } from './messages.ts';
import type { LeaseHolderName } from './messages.ts';
import { createOutputFilter, createTenantProjectProvider, preciseAdapterIds } from './project.ts';
import type { ProjectProvider } from './project.ts';
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

/** A repository whose modules name no known precise adapter has no precise tier: the store resolves nothing, and every edge stays grammar-tier. */
const noPreciseTier: Resolver = async function* () {
  // resolves nothing
};

const ignore = (): void => {};

/**
 * The precise tier the manifests of the repository's modules name (plan 03-23): the first id, in code-unit order, that the
 * Host's table can build. An id nobody knows starts nothing (T-03-235).
 */
function openTier(tiers: TenantDeps['tiers'], roots: TenantDeps['roots']): PreciseTier | undefined {
  if (tiers === undefined) return undefined;
  for (const id of preciseAdapterIds(roots)) {
    const tier = tiers(id);
    if (tier !== undefined) return tier;
  }
  return undefined;
}

/**
 * While the tier is switched off, every read that has sites to resolve carries `precise_unavailable`, and the cache is keyed
 * apart from the one a running tier fills (so a "nothing found" recorded while it was off is not believed after it is on).
 */
function keyedByTier(provider: ProjectProvider | undefined, tier: PreciseTier | undefined): ProjectContextProvider | undefined {
  if (provider === undefined || tier === undefined || tier.active) return provider;
  return async (scope) => {
    const project = await provider(scope);
    return {
      ...project,
      context: { ...project.context, id: `${project.context.id}+${tier.id}:off` },
      degraded: [...(project.degraded ?? []), 'precise_unavailable'],
    };
  };
}

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

  // TSM-03: the project the modules' manifests name (`project.model`) is described once per path set, and the store and
  // the Indexer both read the same description. No module names a model: no provider, and Phase 2 behaviour as it was.
  const projectProvider = createTenantProjectProvider(tree, roots);

  // Plan 03-23: the precise tier the modules' manifests name through `precise.adapter`, from the Host's own table. The
  // test hook, when given, replaces its resolver. Nothing is started here: the tier starts its worker on the first read.
  const tier = openTier(deps.tiers, roots);
  const resolver: Resolver = deps.resolverFactory?.(deps.repoDir) ?? tier?.resolver ?? noPreciseTier;
  const projectContext = keyedByTier(projectProvider, tier);

  let store: FactStore;
  try {
    store = await (deps.openStore ?? openFactStore)(
      location.dir,
      { resolver, clock, gitHas: (hash) => tree.hasObject(hash) },
      {
        lease: 'acquire',
        ...(projectContext === undefined ? {} : { projectContext }),
        takeover: { retryMinMs: tuning.takeoverRetryMinMs, retryMaxMs: tuning.takeoverRetryMaxMs },
        onLeaseChange,
        ...(deps.version === undefined ? {} : { version: deps.version }),
        ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
      },
    );
  } catch (error) {
    await tier?.close().catch(ignore);
    throw error;
  }
  storeOpened();

  // IN-10: from here on a throw must not leave the store, and with it the writer lease, held by an object nobody
  // references. `abandon` closes what was opened so far and rethrows the original error.
  let openedMetrics: Metrics | undefined;
  let followerModules: ModuleHost | undefined;
  async function abandon(error: unknown): Promise<never> {
    closed = true;
    await followerModules?.dispose().catch(ignore);
    await openedMetrics?.close().catch(ignore);
    await tier?.close().catch(ignore);
    await store.close().catch(ignore);
    throw error;
  }

  let metrics: Metrics;
  try {
    metrics =
      deps.metrics === false
        ? createNoopMetrics('disabled')
        : typeof deps.metrics === 'object'
          ? deps.metrics
          : await openMetrics(path.join(location.dir, 'metrics.db'), { clock });
    openedMetrics = metrics;
  } catch (error) {
    return abandon(error);
  }

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

  /**
   * The flight recorder (plan 03-17, D-16): a capped local file beside the store that every process answering for this
   * repository appends to, so `rate` and `bug` in another process can name the last answer. It needs no writer lease,
   * so a follower records too. A user who turned metrics off gets no recorder either: nothing is kept about their use.
   * The session marker is written lazily, just before this Tenant's first recorded answer, so a process that only rates
   * or builds does not become "the newest session".
   */
  const flight: FlightRecorder | null =
    deps.metrics === false
      ? null
      : createFlightRecorder({
          dir: path.join(location.dir, 'flight'),
          maxEvents: tuning.flightMaxEvents,
          maxBytes: tuning.flightMaxBytes,
          clock,
        });
  const ownSessionId = createSessionId();
  let sessionMarked = false;

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
        ...(projectProvider === undefined ? {} : { outputFilter: createOutputFilter(projectProvider) }),
        ...(source === undefined ? {} : { source }),
        ...(deps.indexer === undefined ? {} : { config: deps.indexer }),
      };
      indexer = (deps.indexerFactory ?? createIndexer)(indexerDeps);
    }
    return indexer;
  }

  /** Who holds the writer lease, when the store can say (`lease.json`); never throws. */
  const holderName = async (): Promise<LeaseHolderName | undefined> => {
    try {
      const holder = (await store.status()).leaseHolder;
      return holder === undefined ? undefined : { pid: holder.pid, version: holder.version };
    } catch {
      return undefined;
    }
  };

  const leaseHeld = async (): Promise<Envelope> => leaseHeldEnvelope(await holderName());

  /** The store exists but this worktree was never built (WR-02): names the process that holds the writer, if known. */
  const notIndexed = async (): Promise<Envelope> => notIndexedEnvelope(await holderName());

  /** An error that ends a request as an envelope; anything else is a bug and goes on. */
  async function failure(error: unknown): Promise<Envelope> {
    if (error instanceof StoreClosed) return storeUnavailableEnvelope();
    if (error instanceof WriterBusy) return leaseHeld();
    if (error instanceof UnknownWorktree) return notIndexed();
    if (error instanceof IndexerError) {
      if (error.code === 'lease_held') return leaseHeld();
      if (error.code === 'unknown_worktree') return errorEnvelope('unknown_worktree', 'That directory is not a worktree of the repository.');
      return errorEnvelope('tenant_closed', 'The repository was closed while the request ran.');
    }
    throw error;
  }

  /**
   * An answer that carries a degraded code of the precise tier gains the tier's fixed-text diagnostic for it (plan 03-23):
   * `compiler_fallback` names why the bundled compiler was used, `precise_unavailable` says the tier is off or no config
   * covers a file. The text holds no repository text. Failures and answers without such a code are returned as they are.
   */
  function explained(envelope: Envelope, worktree: string): Envelope {
    const codes = envelope.degraded ?? [];
    if (tier === undefined || !envelope.ok || codes.length === 0) return envelope;
    const facts = projectProvider?.precise(worktree);
    const added: Diagnostic[] = [];
    for (const code of codes) {
      const note = tier.explain(code, facts);
      if (note !== undefined && !envelope.diagnostics.some((known) => known.code === note.code && known.message === note.message)) added.push(note);
    }
    return added.length === 0 ? envelope : { ...envelope, diagnostics: [...envelope.diagnostics, ...added] };
  }

  /** True when this process holds the writer lease: the only process that indexes or runs maintenance (STO-08). */
  const isLeader = async (): Promise<boolean> => !leaseLost && (await store.status()).writerLeaseHeld;

  /** True when the store has an overlay for `worktree`, that is, somebody built it. */
  const isIndexed = async (worktree: string): Promise<boolean> =>
    (await store.status()).worktrees.some((entry) => entry.worktree === worktree);

  /**
   * The module host of the follower overlay (`followerModules`, declared above so a failed construction can dispose
   * it), made on the first `fresh` request a follower answers (a leader's Indexer has its own) and disposed with the Tenant.
   */
  const followerHost = (): ModuleHost => (followerModules ??= createModuleHost({ engine: deps.engine, roots }));
  const followerModulesLazy: ModuleHost = {
    extensions: () => followerHost().extensions(),
    extract: (filePath, text, contentHash) => followerHost().extract(filePath, text, contentHash),
    dispose: async () => {
      if (followerModules !== undefined) await followerModules.dispose();
    },
  };
  let followerFresh: FreshPort;
  try {
    const indexerSettings = { ...DEFAULT_INDEXER_CONFIG, ...deps.indexer };
    followerFresh = createFollowerFresh({
      tree,
      modules: followerModulesLazy,
      store,
      clock,
      maxRaceRetries: indexerSettings.maxRaceRetries,
      maxFileBytes: indexerSettings.maxFileBytes,
      // The store names its symbols after its directory unless it was told otherwise; the Tenant never tells it.
      repo: path.basename(path.resolve(location.dir)),
    });
  } catch (error) {
    return abandon(error);
  }

  /**
   * Query's read-your-writes port. A worktree nobody built is never indexed because a request named paths (D-11).
   * The writer-lease holder asks its Indexer. A follower never writes: it parses the paths into an in-memory overlay
   * for this request only (D-03). The choice is made per call, so a follower that takes the lease over starts using
   * its Indexer with the next request.
   */
  const fresh: FreshPort = {
    async ensureFresh(worktree, paths, waitMs) {
      const status = await store.status();
      if (!status.worktrees.some((entry) => entry.worktree === worktree)) {
        return { complete: true, stalePaths: [], invalid: [] };
      }
      if (leaseLost || !status.writerLeaseHeld) return followerFresh.ensureFresh(worktree, paths, waitMs);
      return getIndexer().ensureFresh(worktree, paths, waitMs);
    },
  };

  let query: ReturnType<typeof createQuery>;
  try {
    query = createQuery({
      store,
      text: tree,
      fresh,
      status: createStatusPort({
        store,
        indexer: () => indexer,
        governor,
        roots,
        ...(deps.knownAdapters === undefined ? {} : { knownAdapters: deps.knownAdapters }),
        ...(deps.providers?.disabled === undefined ? {} : { disabledAdapters: deps.providers.disabled }),
      }),
      clock,
    });
  } catch (error) {
    return abandon(error);
  }

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
   * One slice of store upkeep, with the idle policy (`IDLE_MAINTENANCE`, STO-05, D-16): the store asks for a full
   * compaction, which vacuums only past the recorded thresholds and only after the collect step of the same call
   * finished, so a healthy store is never vacuumed. The store's `maintain` takes the in-process writer slot, which a
   * running Indexer holds; then `collect` and `compact` (which need the lease, not the slot) do the same work with
   * the same policy (the full request goes with the compact step only after a collect that reported complete), and
   * `check` closes the pass. A VACUUM that has started cannot be interrupted: it is the one documented exception to
   * the 200 ms maintenance bound (02-CONSTANTS.md).
   */
  async function maintenanceSlice(): Promise<MaintenanceResult> {
    try {
      return await store.maintain(tuning.maintenanceSliceMs, IDLE_MAINTENANCE);
    } catch (error) {
      if (!(error instanceof WriterBusy)) throw error;
    }
    const collected = await store.collect({ budgetMs: tuning.maintenanceSliceMs });
    const compacted = await store.compact({ budgetMs: tuning.maintenanceSliceMs, ...(collected.complete ? IDLE_MAINTENANCE : {}) });
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
   * `shouldYield` before every step and stops quietly when a request has arrived. The full compaction the store
   * upkeep requests when due is the one step a `shouldYield` cannot interrupt once it has started.
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

  let opening: Awaited<ReturnType<FactStore['status']>>;
  try {
    opening = await store.status();
  } catch (error) {
    return abandon(error);
  }
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
      let answered: Envelope;
      try {
        answered = await query.ask({ ...request, worktree });
      } catch (error) {
        // The store closed itself (a failed recovery, plan 02-31): an answer, not an internal error.
        if (error instanceof StoreClosed) {
          idle.touch();
          return storeUnavailableEnvelope();
        }
        throw error;
      }
      // Until the start-up Reconcile settles, an answer may lag the working tree: say so (D-02).
      const lagging =
        answered.ok && starting !== undefined && !(answered.degraded ?? []).includes('reconciling')
          ? { ...answered, degraded: [...(answered.degraded ?? []), 'reconciling' as const] }
          : answered;
      const envelope = explained(lagging, worktree);
      const elapsed = clock.now() - started;
      // The answer id is added once the answer exists (D-16); it holds no content. The same id goes to the recorder.
      const id = isAnsweredKind(request.kind) ? createAnswerId() : undefined;
      const stamped = id === undefined ? envelope : { ...envelope, answer_id: id };
      recording(() => {
        const event = answerEvent(request.kind, envelope, elapsed);
        if (event !== null) metrics.record(event);
      });
      recording(() => {
        if (flight === null || id === undefined) return;
        const event = flightAnswer(request, envelope, elapsed, id);
        if (event === null) return;
        if (!sessionMarked) {
          sessionMarked = true;
          flight.append({ kind: 'session', id: ownSessionId });
        }
        flight.append(event);
      });
      idle.touch();
      return stamped;
    },

    async build(worktree: string): Promise<Envelope> {
      idle.touch();
      try {
        if (!(await isLeader())) return await leaseHeld();
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
        if (tasks.some((each) => each !== 'resolve') && !(await isLeader())) return await leaseHeld();
        if (tasks.some((each) => WORKTREE_TASKS.has(each)) && !(await isIndexed(options.worktree))) return await notIndexed();
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
      try {
        const [report, tenant] = await Promise.all([metrics.report(range), snapshot()]);
        return okEnvelope(STATUS_SCHEMA, { range, report, tenant });
      } catch (error) {
        if (error instanceof StoreClosed) return storeUnavailableEnvelope();
        throw error;
      }
    },

    recentAnswers(n: number) {
      return flight?.recent(n, 'answer') ?? [];
    },

    lastAnswerId(): string | null {
      return flight?.lastAnswer()?.id ?? null;
    },

    sessionId(): string | null {
      return flight?.sessionId() ?? null;
    },

    async rate(input: RateInput): Promise<Envelope> {
      idle.touch();
      try {
        return await recordRating({ metrics, flight }, input);
      } finally {
        idle.touch();
      }
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
        await followerModulesLazy.dispose().catch(ignore);
        // The compiler worker ends with the Tenant (TSM-05): its stdin is closed, and it is killed after the grace period.
        await tier?.close().catch(ignore);
        await metrics.close();
        await store.close();
      })();
      return closing;
    },
  };
}
