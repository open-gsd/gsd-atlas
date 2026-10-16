import type { DegradedCode } from '../facts/index.ts';
import type { Db } from '../sqlite/index.ts';
import { WriterBusy } from './errors.ts';
import type { Lease } from './lease.ts';
import { checkStore, collectRetired, compactStore } from './lifecycle.ts';
import { maintainStore } from './maintain.ts';
import { assertOpen, readTransaction } from './parts.ts';
import type { StoreParts } from './parts.ts';
import { createReader } from './reader.ts';
import type { DirtyGuard } from './recovery.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type {
  FactStore,
  MaintenanceResult,
  ReconcileResult,
  ReconcileTruth,
  StoreStatus,
  Writer,
} from './types.ts';
import { createWriter } from './writer.ts';

/**
 * Compare the overlay's stored hashes with the truth. A path needs re-indexing when its hash differs, when the
 * overlay lacks it, when the truth lacks it (a deletion), and when its hash matches but its facts are still
 * pending or were marked stale: the Indexer has to extract those too. Sorted by code-unit path order.
 */
function reconcile(parts: StoreParts, truth: ReconcileTruth): ReconcileResult {
  const stored = readTransaction(parts, (db) => {
    const entries = new Map<string, { hash: string; needsFacts: boolean }>();
    const rows = db
      .prepare(
        `SELECT o.path AS path, o.hash AS hash, (o.file_id IS NULL OR f.stale = 1) AS needs_facts
         FROM overlay_files o LEFT JOIN files f ON f.id = o.file_id
         WHERE o.worktree = ?`,
      )
      .all(truth.worktree);
    for (const row of rows) {
      entries.set(String(row.path), { hash: String(row.hash), needsFacts: Number(row.needs_facts) !== 0 });
    }
    return entries;
  });
  const reindex = new Set<string>();
  for (const [path, hash] of truth.pathToHash) {
    const entry = stored.get(path);
    if (entry === undefined || entry.hash !== hash || entry.needsFacts) reindex.add(path);
  }
  for (const path of stored.keys()) if (!truth.pathToHash.has(path)) reindex.add(path);
  return { reindex: [...reindex].sort(), complete: true };
}

/** What the lifecycle layer (open.ts) hands the store beyond its connections. All optional. */
export interface StoreLifecycle {
  /** The cross-process writer lease; absent when the store was opened with `lease: 'none'`. */
  readonly lease?: Lease;
  /** Stops the follower's takeover retries. Called first thing in `close()`; set by the opener once the retries start. */
  stopTakeover?: () => void;
  /** Told when this process gives the lease up at `close()` (takeover is reported by the opener). */
  readonly leaseChanged?: (held: boolean) => void;
  /** Keeps the dirty sentinel in step with the writer's activity (D-14). */
  readonly dirty?: DirtyGuard;
  /** True while the opener is replacing the database files (takeover found a damaged store): no writer is handed out. */
  recovering?: boolean;
  /**
   * Moves the damaged database aside and puts a fresh, rebuilding store in its place, through the opener's own
   * recovery path. Called by `check` when `quick_check` fails; set by the opener.
   */
  rebuild?: () => Promise<void>;
}

/** `meta` entry: set when the store was rebuilt, cleared by the first completed `setOverlay` afterwards (D-14). */
export const REBUILD_PENDING_META = 'rebuild_pending';

/** `meta` entries that record the corruption rebuild for `status()`. */
export const REBUILT_MOVED_TO_META = 'rebuilt_moved_to';
export const REBUILT_AT_META = 'rebuilt_at';

function rebuildPending(db: Db): boolean {
  return db.prepare('SELECT 1 AS present FROM meta WHERE name = ?').get(REBUILD_PENDING_META) !== undefined;
}

/**
 * The `degradedNow` of a store: the degraded codes that hold for the whole process right now. A process that
 * does not hold the writer lease is a follower, and every answer it gives says so. A store that was rebuilt
 * answers `rebuilding` until a full overlay has been written again (D-14); the flag lives in the database, so a
 * follower sees it end when the leader's `setOverlay` completes.
 */
export function processDegraded(lifecycle: StoreLifecycle, readDb: () => Db): () => readonly DegradedCode[] {
  return () => {
    const codes: DegradedCode[] = [];
    if (lifecycle.lease !== undefined && !lifecycle.lease.held) codes.push('follower');
    if (rebuildPending(readDb())) codes.push('rebuilding');
    return codes;
  };
}

/**
 * The writer the store hands out: every mutating call first makes sure the dirty sentinel exists and holds its
 * removal timer, and re-arms the timer when the call is done; `release()` removes the sentinel at once. The
 * first `setOverlay` that completes after a rebuild ends the `rebuilding` state.
 */
function guardWriter(parts: StoreParts, writer: Writer, dirty: DirtyGuard | undefined): Writer {
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    if (!parts.state.closed) dirty?.begin();
    try {
      return await call();
    } finally {
      if (!parts.state.closed) dirty?.end();
    }
  };
  return {
    commitFile: (input) => guarded(() => writer.commitFile(input)),
    link: (worktree, path, hash) => guarded(() => writer.link(worktree, path, hash)),
    setOverlay: (worktree, ref, pathToHash) =>
      guarded(async () => {
        await writer.setOverlay(worktree, ref, pathToHash);
        if (rebuildPending(parts.writeDb)) {
          parts.writeDb.prepare('DELETE FROM meta WHERE name = ?').run(REBUILD_PENDING_META);
        }
      }),
    dropOverlay: (worktree) => guarded(() => writer.dropOverlay(worktree)),
    markStale: (selector) => guarded(() => writer.markStale(selector)),
    release() {
      writer.release();
      dirty?.flush();
    },
  };
}

function status(parts: StoreParts, lifecycle: StoreLifecycle): StoreStatus {
  return readTransaction(parts, (db) => {
    const worktrees = db
      .prepare(
        `SELECT v.worktree AS worktree, v.seq AS seq,
                (SELECT count(*) FROM overlay_files o LEFT JOIN files f ON f.id = o.file_id
                  WHERE o.worktree = v.worktree AND (o.file_id IS NULL OR f.stale = 1)) AS stale_paths
         FROM overlays v WHERE v.dropped = 0 ORDER BY v.worktree`,
      )
      .all()
      .map((row) => ({ worktree: String(row.worktree), seq: Number(row.seq), stalePaths: Number(row.stale_paths) }));
    const pages = Number(db.pragma('page_count'));
    const pageSize = Number(db.pragma('page_size'));
    const metaValue = (name: string): string | undefined => {
      const row = db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
      return row === undefined ? undefined : String(row.value);
    };
    const version = metaValue('schema_version');
    const movedTo = metaValue(REBUILT_MOVED_TO_META);
    const rebuiltAt = metaValue(REBUILT_AT_META);
    return {
      schemaVersion: version === undefined ? SCHEMA_VERSION : Number(version),
      worktrees,
      sizeBytes: pages * pageSize,
      // With a cross-process lease the answer is whether this process holds it; without one, whether a writer is out.
      writerLeaseHeld: lifecycle.lease === undefined ? parts.state.writerTaken : lifecycle.lease.held,
      ...(movedTo === undefined || rebuiltAt === undefined
        ? {}
        : { rebuiltAfterCorruption: { movedTo, at: Number(rebuiltAt) } }),
    };
  });
}

/**
 * Assemble the `FactStore` from its parts.
 *
 * `collect`, `compact`, `check` and `maintain` are the upkeep tasks of plan 02-18 (lifecycle.ts, maintain.ts).
 * They write, so they need write authority: a follower, or a store being replaced, answers `WriterBusy`.
 */
export function createStore(parts: StoreParts, lifecycle: StoreLifecycle = {}): FactStore {
  const dirty = lifecycle.dirty;
  /** Upkeep needs write authority, not the in-process writer slot: it may run while the Indexer holds the writer. */
  const requireAuthority = (): void => {
    assertOpen(parts);
    if (lifecycle.lease !== undefined && !lifecycle.lease.held) throw new WriterBusy();
    if (lifecycle.recovering === true) throw new WriterBusy();
  };
  /** Upkeep writes, so it keeps the dirty sentinel in step the way the writer does (D-14). */
  const dirtied = async <T>(call: () => Promise<T>): Promise<T> => {
    dirty?.begin();
    try {
      return await call();
    } finally {
      if (!parts.state.closed) dirty?.end();
    }
  };
  return {
    at: (worktree) => createReader(parts, worktree),
    writer() {
      assertOpen(parts);
      // A follower never writes: while another process holds the cross-process lease there is no writer to give.
      if (lifecycle.lease !== undefined && !lifecycle.lease.held) throw new WriterBusy();
      if (lifecycle.recovering === true || parts.state.writerTaken) throw new WriterBusy();
      parts.state.writerTaken = true;
      return guardWriter(parts, createWriter(parts), lifecycle.dirty);
    },
    async reconcile(truth) {
      assertOpen(parts);
      return reconcile(parts, truth);
    },
    async collect(options) {
      requireAuthority();
      return dirtied(() => collectRetired(parts, options));
    },
    async compact(options) {
      requireAuthority();
      return dirtied(() => compactStore(parts, options));
    },
    async check() {
      requireAuthority();
      return dirtied(() => checkStore(parts, lifecycle.rebuild));
    },
    async maintain(budgetMs) {
      requireAuthority();
      if (!Number.isFinite(budgetMs) || budgetMs < 0) {
        throw new RangeError('the maintenance budget must be a finite number of milliseconds, zero or more');
      }
      // `maintain` takes the writer slot itself, so it can not run while the Indexer's writer is out.
      if (parts.state.writerTaken) throw new WriterBusy();
      parts.state.writerTaken = true;
      try {
        return await dirtied(() =>
          maintainStore(
            {
              collect: (options) => collectRetired(parts, options),
              compact: (options) => compactStore(parts, options),
              check: () => checkStore(parts, lifecycle.rebuild),
            },
            parts.deps.clock,
            budgetMs,
          ),
        );
      } finally {
        parts.state.writerTaken = false;
      }
    },
    async status() {
      assertOpen(parts);
      return status(parts, lifecycle);
    },
    async close() {
      if (parts.state.closed) return;
      parts.state.closed = true;
      parts.state.writerTaken = false;
      lifecycle.stopTakeover?.();
      lifecycle.dirty?.flush();
      parts.readDb.close();
      parts.writeDb.close();
      // Last: the lease goes after the database handles, so a successor never meets a leader that is still closing.
      if (lifecycle.lease !== undefined) {
        const wasHeld = lifecycle.lease.held;
        await lifecycle.lease.release();
        if (wasHeld) lifecycle.leaseChanged?.(false);
      }
    },
  };
}
