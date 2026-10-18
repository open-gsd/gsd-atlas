/**
 * The store's upkeep (STO-05, STO-10, D-16, research Pattern 4): collect retired versions and the names nothing
 * uses any more, compact the file, check it.
 *
 * Every task is time-boxed, resumable and idempotent. A task returns after the first unit of work that ends past
 * its budget (it always does at least one unit, so repeated calls make progress), and a second run over a store
 * that has nothing left to do processes nothing and changes nothing.
 *
 * The caller (store.ts) has checked that this process may write. Everything here runs on the writable
 * connection, which is shared with the writer, so a commit can land between two awaits of a task; every delete
 * is therefore guarded by the state it was selected under, inside its own transaction.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../sqlite/index.ts';
import type { StoreParts } from './parts.ts';
import { isCorruptionError, recoveryCounters } from './recovery.ts';
import type { CheckResult, MaintenanceOptions, MaintenanceResult } from './types.ts';

/** Test-only hooks, in the way of `recoveryCounters` in recovery.ts. Never set outside a test. */
export const lifecycleTestHooks: {
  /** Called after `collect` chose the hashes of a chunk and before it deletes them (the revival race). */
  onSelected?: (hashes: readonly string[]) => void | Promise<void>;
  /** Called after every incremental-vacuum slice with the pages asked for and the real time it took. */
  onSlice?: (slice: { readonly pages: number; readonly ms: number }) => void;
  /** Called just before a full `VACUUM` runs. */
  onVacuum?: () => void;
  /** Called as `maintain` starts each of its tasks, in order. A throw fails that task. */
  onTask?: (name: 'collect' | 'compact' | 'check') => void;
  /** When true the store behaves as if this SQLite build had no `dbstat` table (so the fallback rule can be tested everywhere). */
  noDbstat?: boolean;
  /**
   * Called just before the checkpoint a `compact` run ends with: the mode asked for, the connection's busy timeout
   * at that moment, and the value it had when the checkpoint step began (restored afterwards). A throw fails the run.
   */
  onCheckpoint?: (checkpoint: {
    readonly mode: 'TRUNCATE' | 'PASSIVE';
    readonly busyTimeoutMs: number;
    readonly previousBusyTimeoutMs: number;
  }) => void;
} = {};

/**
 * Clear every lifecycle test hook. Tests call it in `afterEach`, so a failing test cannot leak a hook into the
 * next store. Production code never calls it.
 */
export function resetLifecycleTestHooks(): void {
  for (const key of Object.keys(lifecycleTestHooks) as Array<keyof typeof lifecycleTestHooks>) {
    delete lifecycleTestHooks[key];
  }
}

/** Where the last budget-limited `collect` stopped, so the next call goes on behind it (see `collectRetired`). */
interface CollectCursor {
  readonly retiredAt: number;
  readonly id: number;
}

const cursors = new WeakMap<StoreParts, CollectCursor>();

/** Fact tables keyed by the file they came from. */
const FACT_TABLES = ['symbols', 'refs', 'imports', 'import_bindings', 'exports', 'citations', 'citation_gaps'] as const;

/**
 * Delete the fact rows and the `files` row of every picked file that is still retired and still unreferenced,
 * in one transaction, and return how many went. A file revived or mapped by an overlay since it was picked is
 * skipped (T-02-60): every statement repeats the guard, and the `files` row goes last, so a file is removed
 * whole or not at all.
 */
function deleteRetired(parts: StoreParts, picked: readonly number[]): number {
  const db = parts.writeDb;
  return db.transaction(() => {
    const retired =
      "file_id IN (SELECT id FROM files WHERE id = ? AND state = 'retired' AND NOT EXISTS (SELECT 1 FROM overlay_files WHERE file_id = files.id))";
    const factDeletes = FACT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE ${retired}`));
    const removeFile = db.prepare(
      "DELETE FROM files WHERE id = ? AND state = 'retired' AND NOT EXISTS (SELECT 1 FROM overlay_files WHERE file_id = ?)",
    );
    let removed = 0;
    for (const id of picked) {
      for (const remove of factDeletes) remove.run(id);
      removed += Number(removeFile.run(id, id).changes);
    }
    return removed;
  });
}

/** How many trigram rows one `DELETE ... rowid IN (...)` statement removes. */
const INDEX_DELETE_BATCH = 500;

/** The ids every fact row points at: symbols, qualified names, reference sites and export entries. */
const USED_NAMES = `SELECT name_id FROM symbols
  UNION SELECT qname_id FROM symbols WHERE qname_id IS NOT NULL
  UNION SELECT name_id FROM refs
  UNION SELECT name_id FROM exports
  UNION SELECT local_id FROM exports WHERE local_id IS NOT NULL`;

/**
 * Delete the interned names no fact row uses, and their trigram rows when the fuzzy index is on. One
 * transaction, so a name and its index entry go together. Returns how many names went.
 */
function deleteUnusedNames(parts: StoreParts): number {
  const db: Db = parts.writeDb;
  return db.transaction(() => {
    const unused = db.prepare(`SELECT id, name FROM names WHERE id NOT IN (${USED_NAMES})`).all();
    if (unused.length === 0) return 0;
    if (parts.fuzzyTrigram) {
      if (parts.settings.contentlessDelete) {
        // `exec`, not a prepared `run`: FTS5 reports a meaningless change count for a contentless delete, which the
        // kit refuses to turn into a number. The ids are integers read from the database a moment ago.
        for (let from = 0; from < unused.length; from += INDEX_DELETE_BATCH) {
          const ids = unused.slice(from, from + INDEX_DELETE_BATCH).map((row) => Number(row.id));
          db.exec(`DELETE FROM names_fts WHERE rowid IN (${ids.join(',')})`);
        }
      } else {
        // A contentless table without `contentless_delete` forgets a row only when told its exact text.
        const forget = db.prepare("INSERT INTO names_fts (names_fts, rowid, name) VALUES ('delete', ?, ?)");
        for (const row of unused) forget.run(Number(row.id), String(row.name));
      }
    }
    for (let from = 0; from < unused.length; from += INDEX_DELETE_BATCH) {
      const ids = unused.slice(from, from + INDEX_DELETE_BATCH).map((row) => Number(row.id));
      db.exec(`DELETE FROM names WHERE id IN (${ids.join(',')})`);
    }
    return unused.length;
  });
}

/**
 * Deleting rows from the contentless FTS5 table leaves the connection's last-insert rowid at an internal segment
 * id above 2^53. The kit refuses to hand such a number back, so the next `run()` of any statement on this
 * connection, a `DELETE` in the writer included, would throw `IntegerOutOfRangeError`. Inserting into an
 * ordinary table sets the value to a small one again; the row is removed at once.
 *
 * The row goes into `names` and not into `meta`: `meta` is a WITHOUT ROWID table, and those do not move the
 * last-insert rowid. Its name is a NUL character plus a random identifier, deleted by exact value. No fact can
 * collide with it (a name holding a NUL is not a name an extractor produces, and the value is random besides),
 * where the former empty-string sentinel threw a constraint error, after the rows were already deleted, when a live
 * fact was named `''` (WR-05). Built in SQL text with `exec`: a prepared `run()` would read the very rowid this
 * function exists to repair.
 */
function resetLastInsertRowid(db: Db): void {
  const sentinel = `char(0) || '${randomUUID()}'`;
  db.exec(`INSERT INTO names (name) VALUES (${sentinel}); DELETE FROM names WHERE name = ${sentinel}`);
}

/**
 * Collect retired file versions (D-16): a version goes once git holds its blob (`gitHas`) or its grace period
 * has passed, and the names no remaining fact uses go with them.
 *
 * Chunks of `settings.chunkSize` files in retired-at order, one transaction each. After a chunk the call stops
 * when the budget is spent, so a call always processes at least one chunk. A call that stops early remembers
 * where, so versions that must wait (git lacks them, the grace is running) at the front of the order cannot
 * keep the ones behind them from being reached; a call that reaches the end forgets the position and the next
 * one starts again from the front.
 *
 * `processed` counts files. The names are deleted at the end of every call that collected a file.
 */
export async function collectRetired(parts: StoreParts, options: MaintenanceOptions): Promise<MaintenanceResult> {
  const { clock, gitHas } = parts.deps;
  const { chunkSize, graceMs } = parts.settings;
  const started = clock.now();
  let cursor: CollectCursor = cursors.get(parts) ?? { retiredAt: -1, id: 0 };
  let processed = 0;
  let complete = false;

  for (;;) {
    const page = parts.writeDb
      .prepare(
        `SELECT id, hash, COALESCE(retired_at, 0) AS retired_at FROM files
         WHERE state = 'retired' AND (COALESCE(retired_at, 0) > ? OR (COALESCE(retired_at, 0) = ? AND id > ?))
         ORDER BY COALESCE(retired_at, 0), id LIMIT ?`,
      )
      .all(cursor.retiredAt, cursor.retiredAt, cursor.id, chunkSize);
    if (page.length === 0) {
      complete = true;
      break;
    }
    const now = clock.now();
    const hashes: string[] = [];
    const ids: number[] = [];
    for (const row of page) {
      const hash = String(row.hash);
      if (Number(row.retired_at) + graceMs <= now || (await gitHas(hash))) {
        hashes.push(hash);
        ids.push(Number(row.id));
      }
    }
    const last = page[page.length - 1];
    if (last === undefined) throw new Error('a page of files ended without a last row');
    cursor = { retiredAt: Number(last.retired_at), id: Number(last.id) };
    if (ids.length > 0) {
      await lifecycleTestHooks.onSelected?.(hashes);
      processed += deleteRetired(parts, ids);
    }
    if (page.length < chunkSize) {
      complete = true;
      break;
    }
    if (clock.now() - started >= options.budgetMs) break;
  }

  if (complete) cursors.delete(parts);
  else cursors.set(parts, cursor);
  if (processed > 0 && deleteUnusedNames(parts) > 0 && parts.fuzzyTrigram) resetLastInsertRowid(parts.writeDb);
  return { complete, spentMs: clock.now() - started, processed };
}

/**
 * How incremental-vacuum slices are sized. The first slice asks for `firstPages`; later slices are sized from how
 * long the last one took, at most `maxGrowth` times the last and never above `maxPages` (64 MiB at 4 KiB pages).
 * Exported so the slice test can assert the structure instead of a wall-clock time.
 */
export const COMPACT_SLICE_LIMITS: Readonly<{ firstPages: number; maxPages: number; maxGrowth: number }> = Object.freeze({
  firstPages: 64,
  maxPages: 16_384,
  maxGrowth: 4,
});

/** What a slice is sized to take: half the pause the plan allows, so noise does not push it over. */
const SLICE_FRACTION = 0.5;

/**
 * A file whose b-tree pages are more than this fraction empty inside is worth a full VACUUM on request even with
 * no free page. Incremental vacuum only returns pages that are empty; scattered deletes (a heavily edited store
 * whose old versions were collected) leave pages two thirds empty that nothing returns, and measured on the
 * size gate that costs 1.34 times a fresh build. A fresh build is about 26 percent empty inside, so a third
 * leaves it alone, and that margin is the hysteresis that keeps the idle loop from vacuuming every round.
 * This is the idle policy trigger recorded in 02-CONSTANTS.md as `compact.fullUnusedFraction`.
 */
const FRAGMENTED_FRACTION = 1 / 3;

/** Bytes of unused space inside the b-tree pages, or undefined when this SQLite build has no `dbstat` table. */
function unusedBytes(db: Db): number | undefined {
  if (lifecycleTestHooks.noDbstat === true) return undefined;
  try {
    const row = db.prepare('SELECT sum(unused) AS unused FROM dbstat').get();
    return row === undefined || row.unused === null ? undefined : Number(row.unused);
  } catch {
    return undefined; // no dbstat, or the scan failed: the free-page rule alone decides
  }
}

/**
 * Whether a full `VACUUM` is warranted: more than a quarter of the file is free pages (`compact.fullFreeFraction`,
 * the rule of the worktree-lifecycle ADR), or, when this build can say, more than `FRAGMENTED_FRACTION` of it is
 * empty space inside pages. Without `dbstat` the in-page space cannot be measured: `afterChurn` (a collect in this
 * same call deleted files, set by `maintain`) then stands in for it, so the full request vacuums once per churn
 * episode; a direct `compact({ full: true })` leaves it unset and follows the free-page rule only.
 */
function worthVacuuming(db: Db, freePages: number, afterChurn: boolean): boolean {
  const total = Number(db.pragma('page_count'));
  if (freePages * 4 > total) return true;
  const unused = unusedBytes(db);
  if (unused === undefined) return afterChurn;
  return unused > total * Number(db.pragma('page_size')) * FRAGMENTED_FRACTION;
}

/** The next slice's page count: aim for `target` ms given that `pages` took `ms`, growing by at most `MAX_SLICE_GROWTH`. */
function nextSlicePages(pages: number, ms: number, target: number): number {
  const scaled = Math.floor((pages * target) / Math.max(ms, 0.05));
  return Math.max(1, Math.min(scaled, pages * COMPACT_SLICE_LIMITS.maxGrowth, COMPACT_SLICE_LIMITS.maxPages));
}

/**
 * Checkpoint the log without ever waiting for a reader (WR-04). `wal_checkpoint(TRUNCATE)` calls the connection's
 * busy handler while a reader in another process still uses the log, and this runs synchronously on the leader's
 * event loop, so the connection's 5 s busy timeout would freeze every request. The timeout is set to 0 for this one
 * call (0 means do not wait, it is not a duration: `compact.checkpointBusyTimeoutMs` in 02-CONSTANTS.md) and put
 * back afterwards, also when the call throws. A checkpoint that finds a reader reports busy instead of failing, and
 * the log drains on a later run.
 */
function checkpoint(db: Db, mode: 'TRUNCATE' | 'PASSIVE'): void {
  const previousBusyTimeoutMs = Number(db.pragma('busy_timeout'));
  db.pragma('busy_timeout', 0);
  try {
    lifecycleTestHooks.onCheckpoint?.({ mode, busyTimeoutMs: Number(db.pragma('busy_timeout')), previousBusyTimeoutMs });
    db.pragma('wal_checkpoint', mode);
  } finally {
    db.pragma('busy_timeout', previousBusyTimeoutMs);
  }
}

/**
 * Compact the file (STO-10): return free pages to the file system in incremental-vacuum slices, each aimed at
 * well under the approved `maintenance.sliceMs` (the first slice is measured and the rest scaled from it), and
 * stop after the first slice that ends past the budget. Every run ends with `PRAGMA optimize` and a WAL
 * checkpoint, which truncates the log when the run finished.
 *
 * A full `VACUUM` rewrites the whole file while it holds the writer, so it runs only when the caller asks
 * (`options.full`) and the file is worth it (`worthVacuuming`); otherwise `full` changes nothing. The decision is
 * taken before the slices and, when they returned every free page, once more after them. `processed` counts the
 * pages given back.
 */
export async function compactStore(parts: StoreParts, options: MaintenanceOptions): Promise<MaintenanceResult> {
  const db = parts.writeDb;
  const { clock } = parts.deps;
  const started = clock.now();
  const freePages = (): number => Number(db.pragma('freelist_count'));
  const target = parts.settings.sliceMs * SLICE_FRACTION;
  let processed = 0;
  let complete = true;

  const afterChurn = options.afterChurn === true;
  let vacuumed = false;
  const vacuum = (): void => {
    const before = Number(db.pragma('page_count'));
    lifecycleTestHooks.onVacuum?.();
    db.exec('VACUUM');
    processed += before - Number(db.pragma('page_count'));
    vacuumed = true;
  };

  let free = freePages();
  if (options.full === true && worthVacuuming(db, free, afterChurn)) {
    vacuum();
    free = freePages();
  }

  let pages = COMPACT_SLICE_LIMITS.firstPages;
  while (free > 0) {
    const began = performance.now();
    db.pragma('incremental_vacuum', pages);
    const ms = performance.now() - began;
    lifecycleTestHooks.onSlice?.({ pages, ms });
    const left = freePages();
    if (left >= free) break; // nothing was freed: the file is not an incremental-vacuum database
    processed += free - left;
    free = left;
    pages = nextSlicePages(pages, ms, target);
    if (free > 0 && clock.now() - started >= options.budgetMs) {
      complete = false;
      break;
    }
  }

  // Second chance: returning the free pages made the file smaller, so the same empty space can now be more than a
  // third of it. Decide again, once, so a single call converges (a VACUUM that already ran this call is enough).
  if (options.full === true && !vacuumed && complete && free === 0 && worthVacuuming(db, 0, afterChurn)) {
    vacuum();
  }

  // `optimize` first: it may write planner statistics, and the checkpoint must be the last write so the log ends
  // empty. Only a finished run asks for a truncating checkpoint; an unfinished run lets the log drain.
  db.pragma('optimize');
  checkpoint(db, complete ? 'TRUNCATE' : 'PASSIVE');
  return { complete, spentMs: clock.now() - started, processed };
}

/** `quick_check` lines for the connection: none when the database answers `ok`. Damage that stops the check is a line too. */
function quickCheckProblems(db: Db): string[] {
  recoveryCounters.quickChecks += 1;
  try {
    const lines = db
      .prepare('PRAGMA quick_check(20)')
      .all()
      .map((row) => String(Object.values(row)[0]));
    if (lines.length === 1 && lines[0] === 'ok') return [];
    return lines.length === 0 ? ['quick_check gave no answer'] : lines;
  } catch (error) {
    if (isCorruptionError(error)) return [error instanceof Error ? error.message : String(error)];
    throw error;
  }
}

/**
 * Check the database (STO-06, A17): `quick_check`, and when it finds damage, `rebuild` moves the files aside
 * and puts a fresh store in their place through the open path (plan 02-12), so reads say `rebuilding` until a
 * full overlay is written again. Returns the problem lines.
 */
export async function checkStore(parts: StoreParts, rebuild: (() => Promise<void>) | undefined): Promise<CheckResult> {
  const problems = quickCheckProblems(parts.writeDb);
  if (problems.length === 0) return { ok: true, problems: [] };
  if (rebuild !== undefined) {
    try {
      await rebuild();
    } catch (error) {
      // WR-03: the rebuild failed; the opener has already restored the store or closed it. Say so in the answer
      // instead of rejecting out of the maintenance request.
      problems.push(error instanceof Error ? error.message : `rebuild failed: ${String(error)}`);
    }
    cursors.delete(parts); // the position described the file that was just moved aside
  }
  return { ok: false, problems };
}
