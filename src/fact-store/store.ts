import { WriterBusy } from './errors.ts';
import { assertOpen, readTransaction } from './parts.ts';
import type { StoreParts } from './parts.ts';
import { createReader } from './reader.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { FactStore, MaintenanceResult, ReconcileResult, ReconcileTruth, StoreStatus } from './types.ts';
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

function status(parts: StoreParts): StoreStatus {
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
    const version = db.prepare('SELECT value FROM meta WHERE name = ?').get('schema_version');
    return {
      schemaVersion: version === undefined ? SCHEMA_VERSION : Number(version.value),
      worktrees,
      sizeBytes: pages * pageSize,
      writerLeaseHeld: parts.state.writerTaken,
    };
  });
}

/**
 * Assemble the `FactStore` from its parts.
 *
 * `collect`, `compact`, `check` and `maintain` are unimplemented by design in this plan: they report an
 * empty, successful run until plan 02-18 replaces them, and the contract suite does not assert on them.
 */
export function createStore(parts: StoreParts): FactStore {
  const idle = async (): Promise<MaintenanceResult> => {
    assertOpen(parts);
    return { complete: true, spentMs: 0, processed: 0 };
  };
  return {
    at: (worktree) => createReader(parts, worktree),
    writer() {
      assertOpen(parts);
      if (parts.state.writerTaken) throw new WriterBusy();
      parts.state.writerTaken = true;
      return createWriter(parts);
    },
    async reconcile(truth) {
      assertOpen(parts);
      return reconcile(parts, truth);
    },
    collect: idle,
    compact: idle,
    async check() {
      assertOpen(parts);
      return { ok: true, problems: [] };
    },
    maintain: idle,
    async status() {
      assertOpen(parts);
      return status(parts);
    },
    async close() {
      if (parts.state.closed) return;
      parts.state.closed = true;
      parts.state.writerTaken = false;
      parts.readDb.close();
      parts.writeDb.close();
    },
  };
}
