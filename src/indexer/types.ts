/**
 * The Indexer's public types (tenant-composition ADR decision 2): the only writer client of the Fact Store. It
 * turns file events and build requests into stored facts through Source Tree, the Grammar Engine and the
 * Fact Store Writer, and schedules every unit of work through the Governor.
 *
 * A worktree is named by its root directory, exactly as `SourceTree.worktrees()` reports it (a canonical real
 * path). The same string is the Fact Store's worktree id, the Source Tree's `worktree` argument and the
 * `worktree` of every notice, so no mapping table exists.
 */
import type { FactStore } from '../fact-store/index.ts';
import type { Clock, Diagnostic } from '../facts/index.ts';
import type { Governor } from '../governor/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import type { Roots } from '../lang/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import type { EventSource, WatchMode } from './event-source.ts';

/** Tunables of the Indexer. Defaults: `DEFAULT_INDEXER_CONFIG`. Every key is overridable in config. */
export interface IndexerConfig {
  /** Quiet time after the last event of a path before it is indexed (D-12). */
  readonly debounceMs: number;
  /** Longest an event may wait before its path is indexed, however many events keep arriving (D-12). */
  readonly maxWaitMs: number;
  /** Default `waitMs` of `ensureFresh` before it answers with the unfinished paths. */
  readonly ensureFreshWaitMs: number;
  /** Files over this many bytes are not parsed. */
  readonly maxFileBytes: number;
  /** How many times a file that changes while it is read is read again before the path is given up as unstable. */
  readonly maxRaceRetries: number;
  /**
   * How often an idle Indexer re-runs Reconcile for every worktree it covers (D-13, maintenance priority). 0
   * switches the periodic Reconcile off; start-up, watcher problems and HEAD changes still reconcile.
   */
  readonly idleReconcileIntervalMs: number;
}

/** One path the Indexer could not index, with a stable code (`parse_timeout`, `source_too_large`, `unstable`, ...). */
export interface FailedPath {
  readonly worktree: string;
  readonly path: string;
  readonly code: string;
}

/** Progress and trouble, in the order it happens. The Host and the metrics layer listen; nothing depends on it. */
export type IndexerNotice =
  | { readonly kind: 'indexed'; readonly worktree: string; readonly path: string; readonly lagMs: number }
  | { readonly kind: 'failed'; readonly worktree: string; readonly path: string; readonly code: string }
  | { readonly kind: 'requeued'; readonly worktree: string; readonly path: string };

/**
 * Which paths are the emit output of an included source and so get no facts (TSM-03, OQ3). The Indexer asks `exclude`
 * once per build or Reconcile run, with every path the source set holds, before the overlay is written; it asks
 * `isOutput` (synchronously, from what the last `exclude` or the store's own project context learned) for a single
 * path an event or a fresh request names. A hand-written file under the output directory that matches no source is
 * not an output and keeps its facts. A filter never throws: when it cannot tell, it excludes nothing.
 */
export interface OutputFilter {
  exclude(worktree: string, paths: Iterable<string>): Promise<ReadonlySet<string>>;
  isOutput(worktree: string, path: string): boolean;
}

export interface IndexerDeps {
  /** The tenant (one repository composition) the Governor jobs are for. */
  readonly tenant: string;
  /** Keeps emit outputs out of the index; absent: every claimed source file is indexed (Phase 2). */
  readonly outputFilter?: OutputFilter;
  readonly tree: SourceTree;
  readonly store: FactStore;
  readonly engine: GrammarEngine;
  readonly roots: Roots;
  readonly governor: Governor;
  readonly clock: Clock;
  /**
   * Where file and git-directory events come from (the native watcher in production). Without one the Indexer
   * runs reconcile-only: answers stay fresh through Reconcile and `ensureFresh`, never through events.
   */
  readonly source?: EventSource;
  readonly config?: Partial<IndexerConfig>;
  readonly onNotice?: (notice: IndexerNotice) => void;
}

export type IndexerErrorCode = 'lease_held' | 'unknown_worktree' | 'stopped';

/**
 * `lease_held`: another holder has the Fact Store's writer slot, so this process cannot index. `unknown_worktree`:
 * Source Tree does not list the worktree. `stopped`: the Indexer was stopped.
 */
export class IndexerError extends Error {
  readonly code: IndexerErrorCode;

  constructor(code: IndexerErrorCode, message: string) {
    super(message);
    this.name = 'IndexerError';
    this.code = code;
  }
}

export interface BuildResult {
  /** Files in the source set: the ones the overlay now maps. */
  readonly files: number;
  /** Files whose facts were extracted by the Grammar Engine. */
  readonly parsed: number;
  /** Files attached to facts the store already held (same content elsewhere, or already attached). */
  readonly linked: number;
  /** Paths that left the overlay (deleted, or no longer source). */
  readonly removed: number;
  /**
   * Snapshot diagnostics plus one diagnostic per file the source set dropped (and one count of unclaimed extensions),
   * one count of emit outputs left out, and one count (`citation_comment_too_long`) of the files of the worktree's overlay that
   * hold a citation gap (a comment over the comment size bound, or more mentions than the per-file cap), whose citations are
   * therefore not all indexed. That count is read from the store after the overlay is written, so a build that parses nothing
   * repeats it.
   */
  readonly skipped: readonly Diagnostic[];
  readonly failed: readonly FailedPath[];
}

export interface FreshResult {
  /** True when every valid path is stored (or correctly absent) when the call answers. */
  readonly complete: boolean;
  /** Valid paths that are not stored yet: still queued, still being read, failed or unstable. Sorted. */
  readonly stalePaths: readonly string[];
  /** Paths that were refused without being read: absolute, with `..` or NUL, or leaving the worktree. In request order. */
  readonly invalid: readonly string[];
}

/**
 * How often an event source reported trouble for a worktree (the repository's common git directory for a problem of
 * the git watch). Each problem also starts a Reconcile of the worktrees the Indexer covers.
 */
export interface WatchProblemRecord {
  readonly worktree: string;
  readonly kind: 'error' | 'overflow';
  readonly count: number;
}

/**
 * What one Reconcile found and did. `changed` is how many paths the store said differ from the working tree
 * (changed, new, gone, pending or stale); `parsed`, `linked` and `removed` say what became of them (`linked` also
 * counts every unchanged file, exactly as a build does).
 */
export interface ReconcileOutcome {
  readonly changed: number;
  readonly parsed: number;
  readonly linked: number;
  readonly removed: number;
  readonly durationMs: number;
}

/** What one {@link Indexer.refresh} did. */
export interface RefreshOutcome {
  /** Paths that were extracted again, attached to known facts, or removed because they left the disk. */
  readonly processed: number;
}

/** The last completed Reconcile of any worktree. */
export interface LastReconcile {
  /** `Clock.now()` when it finished. */
  readonly at: number;
  readonly changed: number;
  readonly durationMs: number;
}

export interface IndexerStatus {
  /** Paths waiting in the coalescing queue or for a Governor slot. */
  readonly queued: number;
  /** Paths being processed right now. */
  readonly running: number;
  /** Paths whose last attempt failed, sorted by worktree then path. Cleared by a later success. */
  readonly failed: readonly FailedPath[];
  /** `Clock.now()` after the last commit, or null before any. */
  readonly lastIndexedAt: number | null;
  /** Problems reported by attached event sources, sorted by worktree then kind. */
  readonly watchProblems: readonly WatchProblemRecord[];
  /** How file events arrive: `native`, `poll`, or `reconcile-only` (no source, or one that could not start). */
  readonly watchMode: WatchMode;
  /** True while a Reconcile is running for any worktree. */
  readonly reconciling: boolean;
  /** The last completed Reconcile, or null before any. */
  readonly lastReconcile: LastReconcile | null;
}

/** Options of {@link Indexer.start}. */
export interface StartOptions {
  /**
   * The worktree roots to cover. Absent: every worktree of the repository, and a worktree added later is covered
   * too. Named: only these (a worktree removed later is still dropped); nothing else is indexed without a build.
   */
  readonly worktrees?: readonly string[];
}

export interface Indexer {
  /** Index a whole worktree and record its overlay. Throws `IndexerError` (`lease_held`, `unknown_worktree`). */
  build(worktree: string): Promise<BuildResult>;
  /** Report that `path` (repo-relative, POSIX) of `worktree` may have changed. Coalesced; never throws. */
  submit(worktree: string, path: string): void;
  /** Index the named paths now, ahead of the debounce (IDX-04). */
  ensureFresh(worktree: string, paths: readonly string[], waitMs?: number): Promise<FreshResult>;
  /**
   * Subscribe `source` for each worktree root: every change is submitted, every problem is counted in
   * `status().watchProblems`. Unsubscribed by `stop()`. This form only listens; it does not Reconcile.
   */
  attach(source: EventSource, worktrees: readonly string[]): Promise<void>;
  /**
   * Cover one more worktree: subscribe its root (and the git directory, once), then Reconcile it. The Tenant calls
   * this after a successful build. Throws `IndexerError` (`unknown_worktree`, `lease_held`, `stopped`).
   */
  attach(worktree: string): Promise<void>;
  /**
   * Start covering the repository: subscribe the worktrees (see {@link StartOptions}) and the common git
   * directory, Reconcile each worktree at the `indexing` priority, and arm the idle timer. Resolves when the
   * start-up Reconcile has completed. Rejects with `IndexerError` when the writer slot is held (`lease_held`).
   */
  start(options?: StartOptions): Promise<void>;
  /**
   * Compare a worktree with the store and index exactly what differs (IDX-03). Without an argument, every covered
   * worktree. Requests for one worktree that arrive while a run is in progress share it.
   */
  reconcile(worktree?: string): Promise<ReconcileOutcome>;
  /**
   * Re-extract every file the worktree's watermark lists as stale or pending (a grammar upgrade, a collected
   * version): each is read and parsed again even though the store already holds facts under its hash, which is
   * the one thing Reconcile does not do. `processed` counts the paths that were re-extracted or removed.
   * Throws `IndexerError` (`unknown_worktree`, `lease_held`, `stopped`).
   */
  refresh(worktree: string): Promise<RefreshOutcome>;
  status(): IndexerStatus;
  /** Cancel timers, finish the work in progress, release the writer slot. Safe to call twice. */
  stop(): Promise<void>;
}
