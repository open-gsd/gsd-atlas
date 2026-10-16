/**
 * Internal wiring shared by the store, writer and reader. Not exported from index.ts.
 */
import type { DegradedCode, ResolutionContext } from '../facts/index.ts';
import type { Db } from '../sqlite/index.ts';
import { StoreClosed } from './errors.ts';
import type { StoreDeps } from './types.ts';

/** Mutable state of one open store. */
export interface StoreState {
  closed: boolean;
  /** True while a writer from `store.writer()` has not been released. */
  writerTaken: boolean;
}

/** Everything the writer, reader and store share. Built once by `openFactStore`. */
export interface StoreParts {
  /** The single writable connection; only the writer and maintenance use it. */
  readonly writeDb: Db;
  /** A read-only connection for readers: lock-free in WAL mode. */
  readonly readDb: Db;
  readonly deps: StoreDeps;
  /** The repo name used in symbol identities. */
  readonly repo: string;
  readonly canCache: () => boolean;
  readonly resolutionContext: () => ResolutionContext;
  /** True when this session keeps `names_fts` in step with `names` and fuzzy find reads it (else the LIKE scan). */
  readonly fuzzyTrigram: boolean;
  /** The overlay snapshot id last computed for each worktree, valid for the seq it was computed at. */
  readonly snapshotIds: Map<string, { readonly seq: number; readonly id: string }>;
  readonly state: StoreState;
  /** Degraded codes that hold for the whole process right now; plan 02-12 reports `follower` and `rebuilding` here. */
  readonly degradedNow: () => readonly DegradedCode[];
}

export function assertOpen(parts: StoreParts): void {
  if (parts.state.closed) throw new StoreClosed();
}

/**
 * Run `fn` inside one read transaction on the read connection, so every statement in it sees the same
 * committed state (a snapshot in WAL mode). `fn` must be synchronous: the connection is shared.
 */
export function readTransaction<T>(parts: StoreParts, fn: (db: Db) => T): T {
  const db = parts.readDb;
  db.exec('BEGIN');
  try {
    return fn(db);
  } finally {
    db.exec('COMMIT');
  }
}

/** The extractor string carried in provenance, for example `grammar:typescript@0.23.2`. */
export function extractorOf(module: string, grammarVersion: string): string {
  return `grammar:${module}@${grammarVersion}`;
}
