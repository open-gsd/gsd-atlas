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

export interface IndexerDeps {
  /** The tenant (one repository composition) the Governor jobs are for. */
  readonly tenant: string;
  readonly tree: SourceTree;
  readonly store: FactStore;
  readonly engine: GrammarEngine;
  readonly roots: Roots;
  readonly governor: Governor;
  readonly clock: Clock;
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
  /** Snapshot diagnostics plus one diagnostic per file the source set dropped (and one count of unclaimed extensions). */
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

export interface IndexerStatus {
  /** Paths waiting in the coalescing queue or for a Governor slot. */
  readonly queued: number;
  /** Paths being processed right now. */
  readonly running: number;
  /** Paths whose last attempt failed, sorted by worktree then path. Cleared by a later success. */
  readonly failed: readonly FailedPath[];
  /** `Clock.now()` after the last commit, or null before any. */
  readonly lastIndexedAt: number | null;
}

export interface Indexer {
  /** Index a whole worktree and record its overlay. Throws `IndexerError` (`lease_held`, `unknown_worktree`). */
  build(worktree: string): Promise<BuildResult>;
  /** Report that `path` (repo-relative, POSIX) of `worktree` may have changed. Coalesced; never throws. */
  submit(worktree: string, path: string): void;
  /** Index the named paths now, ahead of the debounce (IDX-04). */
  ensureFresh(worktree: string, paths: readonly string[], waitMs?: number): Promise<FreshResult>;
  status(): IndexerStatus;
  /** Cancel timers, finish the work in progress, release the writer slot. Safe to call twice. */
  stop(): Promise<void>;
}
