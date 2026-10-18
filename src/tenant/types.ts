/**
 * The Tenant's public types (tenant-composition ADR decision 5): one composition of the modules that hold
 * per-repository state: Source Tree, Fact Store (with the writer lease), Indexer, Query and Metrics. The Grammar
 * Engine, the CommandRunner and the Governor are shared across tenants and arrive as dependencies.
 */
import type { CommandResult, CommandRunner } from '../command-runner/index.ts';
import type { Resolver, StoreLocation, StoreStatus, openFactStore } from '../fact-store/index.ts';
import type { Clock, DegradedCode, Diagnostic, Envelope, Request } from '../facts/index.ts';
import type { Governor, GovernorStatus } from '../governor/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import type { EventSource, Indexer, IndexerConfig, IndexerDeps, IndexerStatus } from '../indexer/index.ts';
import type { Roots } from '../lang/index.ts';
import type { Metrics, MetricsStatus } from '../metrics/index.ts';
import type { PreciseTier } from '../precise-resolver/index.ts';
import type { TierInfo } from '../query/index.ts';
import type { SourceTree, SourceTreeIdentity } from '../source-tree/index.ts';
import type { FlightEvent } from './flight.ts';
import type { RateInput } from './rate.ts';

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
  /** The longest the first request waits for the start-up Reconcile before it is answered `reconciling`. */
  readonly startupReconcileDeadlineMs: number;
  /** Quiet time (no request) before the Tenant runs one idle maintenance round. */
  readonly idleAfterMs: number;
  /** A follower retries the writer lease after a jittered delay between these two bounds. */
  readonly takeoverRetryMinMs: number;
  readonly takeoverRetryMaxMs: number;
  /** Events the flight recorder keeps (`recorder.maxEvents`, 03-CONSTANTS.md). */
  readonly flightMaxEvents: number;
  /** Bytes the flight recorder keeps (`recorder.maxBytes`, 03-CONSTANTS.md). */
  readonly flightMaxBytes: number;
  /**
   * The time bound of the eager resolution pass that follows a build, and of an approved `precise.command` (plan 03-29):
   * `precise.requestTimeoutMs`, 03-CONSTANTS.md (25000 ms). Zero or less turns the pass after a build off, so every read meets
   * a cold cache (a measurement hook of `scripts/precise-gate.ts --lazy`; `maintain resolve` still works).
   */
  readonly resolveBoundMs: number;
  /** The most reference sites one resolver call of the eager pass carries: `precise.sitesPerRequest`, 03-CONSTANTS.md (2000). */
  readonly resolveBatchSites: number;
  /**
   * Start the precise tier's worker in the background when the Tenant starts over a worktree that is already indexed (plan
   * 03-29, Pitfall 5). False leaves the first question to start it, as before; a measurement hook, not a setting.
   */
  readonly warmStart: boolean;
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
  /**
   * The user's `providers` setting (SEC-02): ids of first-party providers to turn off (`typescript` today). Absent: every
   * first-party provider runs. An id nobody knows has no effect. The Host passes it; the provider table reads it.
   */
  readonly providers?: { readonly disabled?: readonly string[] };
  /**
   * Builds the precise tier a module manifest names through `precise.adapter` (plan 03-23): the Host's table of built-in
   * tiers, closed over its runner and the user's `providers` list. Absent, or answering undefined for an id, means that
   * adapter is not known and nothing is started for it. The id is data from the manifest; it picks from the table and
   * never names a path or a command.
   */
  readonly tiers?: (adapterId: string) => PreciseTier | undefined;
  /** The adapter ids the composition root knows; `atlas_status` reports a module's precise tier active only for these. */
  readonly knownAdapters?: readonly string[];
  /** TEST HOOK. The store's resolver for this repository, given its directory; wins over `tiers`. Production omits it. */
  readonly resolverFactory?: (repoDir: string) => Resolver;
  /**
   * How a language module's `precise.command` is run (plan 03-29, SEC-02). Built by the Host. Absent: no command is ever run
   * and `maintain resolve` does not look for one.
   */
  readonly commands?: CommandGate;
  /** The version of this build, recorded in a new store. */
  readonly version?: string;
  /**
   * False: record no metrics (a noop instance). An instance: record into it instead of opening `metrics.db`; the
   * Tenant closes it with itself. Default true.
   */
  readonly metrics?: boolean | Metrics;
  /** Builds the event source an Indexer listens to. Absent: the Indexer is reconcile-only. */
  readonly eventSource?: () => EventSource;
  /** TEST HOOK. Builds the Indexer; production omits it. */
  readonly indexerFactory?: (deps: IndexerDeps) => Indexer;
  /** TEST HOOK. Opens the Fact Store, so a test can reach its lease callback or wrap it; production omits it. */
  readonly openStore?: typeof openFactStore;
  /** Shortens waits in tests. */
  readonly tuning?: Partial<TenantTuning>;
}

/**
 * What the Tenant needs to run a language module's `precise.command` (plan 03-29, SEC-02). The Host builds it from its own runner
 * and the permission list THIS Host may use (an MCP server has none unless it was started with `--allow-build`), so the Tenant
 * never reads a permission, a config or a hash of its own.
 */
export interface CommandGate {
  /** The Host's runner: the only thing that starts a process, and the owner of the last word on a permission. */
  readonly runner: CommandRunner;
  /** True when a person approved exactly this command (executable first) for this repository and this Host may use the approval. */
  approved(command: readonly string[]): boolean;
  /** Maps a refused start to the degraded answer and its fixed diagnostic; null for anything else. */
  needsApprovalFrom(result: Pick<CommandResult, 'denied'>): { readonly degraded: Extract<DegradedCode, 'needs_approval'>; readonly diagnostic: Diagnostic } | null;
}

/**
 * What running a language module's approved `precise.command` came to (plan 03-29, SEC-02). Only the facts of the process, never
 * what it printed: its output is neither stored nor returned.
 */
export interface CommandReport {
  /** True when the command was started. False when it was not approved (or could not be started). */
  readonly ran: boolean;
  /** True when it ended with exit code 0 inside its time limit. */
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** How long it ran, in milliseconds. */
  readonly ms: number;
  /** True when the command was not started because the person has not approved exactly this command for this repository. */
  readonly needsApproval: boolean;
}

/** What the eager resolution pass of `resolve` did (plan 03-29). */
export interface PreciseReport {
  /** Reference sites the resolver was asked about in this run. */
  readonly asked: number;
  /** Of those, the sites it produced an edge for. */
  readonly answered: number;
  /** True when the pass reached the end of the overlay. */
  readonly complete: boolean;
  /** `resolve` only, for a module that declares a `precise.command`. */
  readonly command?: CommandReport;
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
  /** `resolve` only, when a precise tier or a module command took part. */
  readonly precise?: PreciseReport;
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
  /**
   * The start-up Reconcile: `pending` while an Indexer started for the worktrees the store already indexes has not
   * finished (answers carry `reconciling`), `ready` once it settled, `none` when nothing was started.
   */
  readonly startup: 'pending' | 'ready' | 'none';
  /**
   * Idle maintenance (STO-10): `rounds` finished rounds (one that yielded to a request is not finished), when the
   * last one ended, and `failedSteps` steps that failed and were swallowed so the later steps could still run.
   */
  readonly idle: { readonly lastRoundAt: number | null; readonly rounds: number; readonly failedSteps: number };
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
  /**
   * The state of the precise tier for `worktree` (plan 03-26, QRY-07): `active`, `degraded` (with the code of the worker's last
   * failure), `inactive` (with a fixed reason), `needs_approval` or `disabled`, and the compiler the tier resolves with. It reads
   * state the Tenant already holds (the module registry, the user's `providers` setting, the last project description and what
   * recent answers reported); it never probes the compiler and never starts a worker.
   */
  tierInfo(worktree: string): Promise<TierInfo>;
  /** The `status` reply: the Metrics report for the last `sinceMs` milliseconds plus the snapshot. */
  statusEnvelope(sinceMs: number): Promise<Envelope>;
  /**
   * The newest `n` tool answers this repository's flight recorder holds, oldest first (the recorder is shared by every
   * process that answers for the repository). Empty when recording is off or the recorder cannot be read.
   */
  recentAnswers(n: number): readonly FlightEvent[];
  /** The id of the newest recorded tool answer, or null. */
  lastAnswerId(): string | null;
  /** The id of the newest session marker the recorder holds, or null. */
  sessionId(): string | null;
  /**
   * Record one rating a person gave (plan 03-17, D-16): the newest recorded answer, a feature, or the newest session.
   * `no_recent_answer` or `no_recent_session` when there is nothing to rate, `rating_not_saved` when the metrics
   * database could not take it. Never throws for either.
   */
  rate(input: RateInput): Promise<Envelope>;
  /** Stop the Indexer, close Metrics, close the store and give up the writer lease. Safe to call twice. */
  close(): Promise<void>;
}
