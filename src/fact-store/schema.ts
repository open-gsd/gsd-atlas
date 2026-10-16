import type { Db } from '../sqlite/index.ts';

/** The version of the fact-store schema this build writes. Raised only by a rebuild-requiring change (D-15). */
export const SCHEMA_VERSION = 1;

/** The store database file inside the store directory. */
export const STORE_FILE_NAME = 'facts.db';

/** The life of a `files` row: facts serve while `live`, wait for collection when `retired`, are gone when `collected`. */
export const FILE_STATES = ['live', 'retired', 'collected'] as const;

export type FileState = (typeof FILE_STATES)[number];

/**
 * Create every table and index of schema version 1 (Pattern 1, measured: integer file ids make the store
 * 3.2 times smaller and 2.2 times faster than keying facts on the 40-hex blob id).
 *
 * One `files` row per distinct blob hash; every fact table is keyed by `file_id`; names are interned once in
 * `names`; an overlay maps (worktree, path) to a file id, and the path shown in provenance comes from the
 * overlay, so identical bytes at two paths are stored once. Spans are four integer columns (UTF-16 columns,
 * 0-based lines). Only names, kinds, spans, hashes and import specifiers are stored; no column holds the
 * bytes of a file.
 *
 * Plan 02-11 adds `resolution_contexts`, `resolved_edges` and `names_fts` to this same unreleased version.
 * Safe to run on an existing store: every statement is `IF NOT EXISTS`.
 */
export function createSchema(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  name TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS names (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  grammar_version TEXT NOT NULL,
  nsym INTEGER NOT NULL,
  nref INTEGER NOT NULL,
  error_bytes INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'retired', 'collected')),
  stale INTEGER NOT NULL DEFAULT 0,
  retired_at INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  file_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  name_id INTEGER NOT NULL,
  qname_id INTEGER,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  parent INTEGER,
  exported INTEGER,
  PRIMARY KEY (file_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols (name_id);

CREATE TABLE IF NOT EXISTS refs (
  file_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  name_id INTEGER NOT NULL,
  kind TEXT,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  import_path TEXT,
  enclosing INTEGER,
  PRIMARY KEY (file_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS refs_by_name ON refs (name_id);

CREATE TABLE IF NOT EXISTS imports (
  file_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  path TEXT NOT NULL,
  style TEXT,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  PRIMARY KEY (file_id, ord)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS import_bindings (
  file_id INTEGER NOT NULL,
  import_ord INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  imported TEXT NOT NULL,
  local_name TEXT NOT NULL,
  PRIMARY KEY (file_id, import_ord, ord)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS exports (
  file_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  name_id INTEGER NOT NULL,
  local_id INTEGER,
  from_path TEXT,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  PRIMARY KEY (file_id, ord)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS overlays (
  worktree TEXT NOT NULL PRIMARY KEY,
  ref TEXT NOT NULL,
  seq INTEGER NOT NULL,
  dropped INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS overlay_files (
  worktree TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  file_id INTEGER,
  PRIMARY KEY (worktree, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS overlay_files_by_file ON overlay_files (file_id);
CREATE INDEX IF NOT EXISTS overlay_files_by_hash ON overlay_files (hash);
`);
}
