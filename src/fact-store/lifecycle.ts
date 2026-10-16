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
import type { Db } from '../sqlite/index.ts';
import type { StoreParts } from './parts.ts';
import type { MaintenanceOptions, MaintenanceResult } from './types.ts';

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
} = {};

/** Where the last budget-limited `collect` stopped, so the next call goes on behind it (see `collectRetired`). */
interface CollectCursor {
  readonly retiredAt: number;
  readonly id: number;
}

const cursors = new WeakMap<StoreParts, CollectCursor>();

/** Fact tables keyed by the file they came from. */
const FACT_TABLES = ['symbols', 'refs', 'imports', 'import_bindings', 'exports'] as const;

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
 */
function resetLastInsertRowid(db: Db): void {
  db.exec("INSERT INTO names (name) VALUES (''); DELETE FROM names WHERE name = ''");
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
