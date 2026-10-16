/**
 * The Tenant's public types (tenant-composition ADR decision 5): one composition of the modules that hold
 * per-repository state: Source Tree, Fact Store (with the writer lease), Indexer, Query and Metrics. The Grammar
 * Engine, the CommandRunner and the Governor are shared across tenants and arrive as dependencies.
 */
import type { StoreLocation } from '../fact-store/index.ts';
import type { StoreStatus } from '../fact-store/index.ts';
import type { Clock, Envelope, Request } from '../facts/index.ts';
import type { Governor, GovernorStatus } from '../governor/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import type { EventSource, Indexer, IndexerConfig, IndexerDeps, IndexerStatus } from '../indexer/index.ts';
import type { Roots } from '../lang/index.ts';
import type { MetricsStatus } from '../metrics/index.ts';
import type { SourceTree, SourceTreeIdentity } from '../source-tree/index.ts';

/** Schema of a `build` reply. */
export const BUILD_SCHEMA = 'gsd-atlas.build/1';
/** Schema of a `maintain` reply. */
export const MAINTAIN_SCHEMA = 'gsd-atlas.maintain/1';
/** Schema of a `status` reply (the status panels: the Metrics report plus the status snapshot). */
export const STATUS_SCHEMA = 'gsd-atlas.status/1';

/** The tasks a `maintain` request can name; `all` runs every other one in this order. */
export const MAINTAIN_TASKS = ['reconcile', 'resolve', 'refresh', 'collect', 'compact', 'check', 'all'] as const;
export type MaintainTask = (typeof MAINTAIN_TASKS)[number];

/** Tunables of a Tenant. Defaults: `DEFAULT_TENANT_TUNING`. */
export interface TenantTuning {
  /** The time box of one store maintenance slice (collect, compact), in milliseconds. */
  readonly maintenanceSliceMs: number;
}

export interface TenantDeps {
  /** Source Tree for the repository, built by the Host (it needed the identity to find the tenant). */
  readonly tree: SourceTree;
  readonly identity: SourceTreeIdentity;
  /** A checkout of the repository: the worktree the Host first met. Module roots of this tenant point at it. */
  readonly repoDir: string;
  /** The Host's module roots; the tenant replaces `repoRoot` with its own repository. */
  readonly roots: Roots;
  readonly engine: GrammarEngine;
  readonly governor: Governor;
  readonly clock: Clock;
  /** Where the store goes when the git common directory is not usable. */
  readonly cacheRoot: string;
  /** The user's `store.dir`, from user-level configuration or the environment; never from the repository. */
  readonly storeDir?: string;
  /** The user's Indexer settings (debounce, max wait). */
  readonly indexer?: Partial<IndexerConfig>;
  /** The user's `gc.graceMs`. */
  readonly graceMs?: number;
  /** The version of this build, recorded in a new store. */
  readonly version?: string;
  /** False: record no metrics (a noop instance). Default true. */
  readonly metrics?: boolean;
  /** Builds the event source an Indexer listens to. Absent: the Indexer is reconcile-only. */
  readonly eventSource?: () => EventSource;
  /** TEST HOOK. Builds the Indexer; production omits it. */
  readonly indexerFactory?: (deps: IndexerDeps) => Indexer;
  /** Shortens waits in tests. */
  readonly tuning?: Partial<TenantTuning>;
}

/** What one maintenance task did. */
export interface TaskReport {
  /** True when the task finished; false when its slice bound ran out first. */
  readonly complete: boolean;
  readonly spentMs: number;
  /** Rows, files or paths the task processed, whatever it counts. */
  readonly processed: number;
  /** Why the task did nothing, when it did nothing on purpose. */
  readonly note?: string;
  /** `check` only: whether the integrity check passed. */
  readonly ok?: boolean;
}

export interface MaintainOptions {
  /** The worktree root the request resolved to. */
  readonly worktree: string;
  /** Allow a full compaction of a fragmented file (`compact` only). */
  readonly full?: boolean;
}

/** The status snapshot of one tenant (counts and flags; no file paths beyond the store location). */
export interface TenantStatus {
  readonly storeId: string;
  readonly location: StoreLocation;
  /** True when this process holds the writer lease. */
  readonly leader: boolean;
  readonly store: StoreStatus;
  /** Null when this process runs no Indexer for the tenant. */
  readonly indexer: IndexerStatus | null;
  readonly governor: GovernorStatus;
  readonly metrics: MetricsStatus;
  /** Why the start-up Indexer did not start, when it did not. */
  readonly startError?: string;
}

export interface Tenant {
  readonly storeId: string;
  readonly location: StoreLocation;
  /** Answer a code request (`code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`) for `worktree`. */
  handle(request: Request, worktree: string): Promise<Envelope>;
  /** Index `worktree` and then watch it (D-11). `lease_held` on a follower. */
  build(worktree: string): Promise<Envelope>;
  /** Run a maintenance task (STO-10). `lease_held` on a follower that needs the writer. */
  maintain(task: MaintainTask, options: MaintainOptions): Promise<Envelope>;
  /** The status snapshot. */
  status(): Promise<TenantStatus>;
  /** The `status` reply: the Metrics report for the last `sinceMs` milliseconds plus the snapshot. */
  statusEnvelope(sinceMs: number): Promise<Envelope>;
  /** Stop the Indexer, close Metrics, close the store and give up the writer lease. Safe to call twice. */
  close(): Promise<void>;
}
