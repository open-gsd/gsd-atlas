import { WriterBusy } from './errors.ts';
import { assertOpen } from './parts.ts';
import type { StoreParts } from './parts.ts';
import { createReader } from './reader.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { FactStore, MaintenanceResult } from './types.ts';
import { createWriter } from './writer.ts';

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
    async reconcile() {
      assertOpen(parts);
      return { reindex: [], complete: true };
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
      const db = parts.readDb;
      const worktrees = db
        .prepare('SELECT worktree, seq FROM overlays WHERE dropped = 0 ORDER BY worktree')
        .all()
        .map((row) => ({ worktree: String(row.worktree), seq: Number(row.seq), stalePaths: 0 }));
      const pages = Number(db.pragma('page_count'));
      const pageSize = Number(db.pragma('page_size'));
      const version = db.prepare('SELECT value FROM meta WHERE name = ?').get('schema_version');
      return {
        schemaVersion: version === undefined ? SCHEMA_VERSION : Number(version.value),
        worktrees,
        sizeBytes: pages * pageSize,
        writerLeaseHeld: parts.state.writerTaken,
      };
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
