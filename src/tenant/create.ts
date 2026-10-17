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
import { openFactStore, resolveStoreLocation } from '../fact-store/index.ts';
import type { FactStore, Resolver } from '../fact-store/index.ts';
import { okEnvelope } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { IndexerError, createIndexer } from '../indexer/index.ts';
import type { BuildResult, Indexer } from '../indexer/index.ts';
import { createNoopMetrics, openMetrics } from '../metrics/index.ts';
import { createQuery, errorEnvelope } from '../query/index.ts';
import type { FreshPort } from '../query/index.ts';
import { DEFAULT_TENANT_TUNING } from './defaults.ts';
import { createStatusPort } from './status-port.ts';
import { BUILD_SCHEMA, STATUS_SCHEMA } from './types.ts';
import type { MaintainOptions, MaintainTask, Tenant, TenantDeps, TenantStatus, TenantTuning } from './types.ts';

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

  const store: FactStore = await openFactStore(
    location.dir,
    { resolver: noPreciseTier, clock, gitHas: (hash) => tree.hasObject(hash) },
    {
      lease: 'acquire',
      ...(deps.version === undefined ? {} : { version: deps.version }),
      ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
    },
  );
  const metrics =
    deps.metrics === false
      ? createNoopMetrics('disabled')
      : await openMetrics(path.join(location.dir, 'metrics.db'), { clock });

  let indexer: Indexer | undefined;
  let closing: Promise<void> | undefined;
  let startError: string | undefined;

  /** The Indexer of this tenant, created on first need. */
  function getIndexer(): Indexer {
    if (closing !== undefined) throw new IndexerError('stopped', 'the tenant was closed');
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

  /** An error that ends a request as an envelope; anything else is a bug and goes on. */
  function failure(error: unknown): Envelope {
    if (error instanceof IndexerError) {
      if (error.code === 'lease_held') return leaseHeld();
      if (error.code === 'unknown_worktree') return errorEnvelope('unknown_worktree', 'That directory is not a worktree of the repository.');
      return errorEnvelope('tenant_closed', 'The repository was closed while the request ran.');
    }
    throw error;
  }

  /** Query's read-your-writes port. A worktree nobody built is never indexed because a request named paths (D-11). */
  const fresh: FreshPort = {
    async ensureFresh(worktree, paths, waitMs) {
      const status = await store.status();
      if (!status.worktrees.some((entry) => entry.worktree === worktree)) {
        return { complete: true, stalePaths: [], invalid: [] };
      }
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

  // Start watching the worktrees the store already indexes. Never waited for: a request is served from the store
  // meanwhile, and the start-up Reconcile repairs it.
  let starting: Promise<void> = Promise.resolve();
  const indexed = (await store.status()).worktrees.map((entry) => entry.worktree);
  if (indexed.length > 0) {
    starting = (async () => {
      try {
        const listed = new Set((await tree.worktrees()).filter((entry) => !entry.bare).map((entry) => entry.path));
        const targets = indexed.filter((worktree) => listed.has(worktree));
        if (targets.length > 0 && closing === undefined) await getIndexer().start({ worktrees: targets });
      } catch (error) {
        startError = codeOf(error);
      }
    })();
  }

  async function snapshot(): Promise<TenantStatus> {
    const storeStatus = await store.status();
    return {
      storeId: identity.storeId,
      location,
      leader: storeStatus.writerLeaseHeld,
      store: storeStatus,
      indexer: indexer?.status() ?? null,
      governor: governor.status(),
      metrics: metrics.status(),
      ...(startError === undefined ? {} : { startError }),
    };
  }

  return {
    storeId: identity.storeId,
    location,

    handle(request: Request, worktree: string): Promise<Envelope> {
      return query.ask({ ...request, worktree });
    },

    async build(worktree: string): Promise<Envelope> {
      try {
        const ix = getIndexer();
        const result = await ix.build(worktree);
        await ix.attach(worktree);
        return okEnvelope(BUILD_SCHEMA, buildData(worktree, result));
      } catch (error) {
        return failure(error);
      }
    },

    maintain(task: MaintainTask, _options: MaintainOptions): Promise<Envelope> {
      return Promise.resolve(
        errorEnvelope('maintain_unavailable', `maintenance task ${task} is not available from this tenant yet`),
      );
    },

    status: snapshot,

    async statusEnvelope(sinceMs: number): Promise<Envelope> {
      const until = clock.now();
      const range = { since: until - sinceMs, until };
      const [report, tenant] = await Promise.all([metrics.report(range), snapshot()]);
      return okEnvelope(STATUS_SCHEMA, { range, report, tenant });
    },

    close(): Promise<void> {
      closing ??= (async () => {
        const running = indexer;
        if (running !== undefined) await running.stop().catch(ignore);
        await starting.catch(ignore);
        // The start-up may have created the Indexer after the stop above looked; it is stopped now.
        if (indexer !== undefined && indexer !== running) await indexer.stop().catch(ignore);
        await metrics.close();
        await store.close();
      })();
      return closing;
    },
  };
}
