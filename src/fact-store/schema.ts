import type { Db } from '../sqlite/index.ts';

/**
 * The version of the fact-store schema this build writes. Raised only by a rebuild-requiring change (D-15).
 *
 * Version 2 (plan 03-24, the single bump of Phase 3) adds the `citations` table to the local facts of a file
 * version. A store written by version 1 holds no citations and would answer "no ADR cites this" for every file, so
 * it is derived data that this build deletes and recreates when it opens it (the open step, D-15); the Host then
 * reports `not_indexed` until `gsd-atlas build` has run again. Development stores built in Phase 2 need that one
 * rebuild.
 *
 * Plan 03-28 adds `citation_gaps` (what the extractor could not keep of a file's ADR mentions) without moving the version:
 * like `resolved_asked` and `resolved_relations` it is additive derived data created `IF NOT EXISTS`,
 * plan 03-24 recorded version 2 as the single bump of Phase 3 and plan 03-31 pins it. A development store built before the
 * table existed reports no gap until it is rebuilt.
 */
export const SCHEMA_VERSION = 2;

/** The store database file inside the store directory. */
export const STORE_FILE_NAME = 'facts.db';

/**
 * The life of a `files` row: facts serve while `live` and wait for collection when `retired`. A collected
 * file's row is deleted (`deleteRetired`), so there is no state for it; committing the same hash again inserts
 * a new row with a new id.
 */
export const FILE_STATES = ['live', 'retired'] as const;

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
 * Plan 02-11 adds `names_fts` (the fuzzy-name index), `resolution_contexts` and `resolved_edges` to this same
 * unreleased version; plan 03-20 adds `resolved_asked`, derived cache data, the same way, and plan 03-25 adds
 * `resolved_relations` and `relations_asked`. Safe to run on an existing store: every statement is `IF NOT EXISTS`.
 */
export function createSchema(db: Db, fuzzy: FuzzyIndex): void {
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
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'retired')),
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

-- ADR citations found in the comments of a file version (plan 03-24, D-19): the ADR number, an optional short
-- section detail and the span of the mention. The enclosing column is the ord of the symbol the mention belongs to.
-- No column holds comment text.
CREATE TABLE IF NOT EXISTS citations (
  file_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  number INTEGER NOT NULL,
  detail TEXT,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  enclosing INTEGER,
  PRIMARY KEY (file_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS citations_by_number ON citations (number);

-- What the extractor could not keep of a file version's ADR mentions (plan 03-28, amendment of 2026-10-18): comments it skipped
-- for their size and whether the file held more mentions than the cap. One row per file version that has a gap, written in the
-- file's own transaction and collected with it. A count and a flag; no path, number or text. Additive derived data, created with
-- IF NOT EXISTS, so a store made before this table existed gains it on the next open and the schema version does not move.
CREATE TABLE IF NOT EXISTS citation_gaps (
  file_id INTEGER NOT NULL PRIMARY KEY,
  skipped_comments INTEGER NOT NULL,
  capped INTEGER NOT NULL
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

-- The resolved-edge cache (STO-04). A precise edge binds one reference site to one definition; it is valid for
-- exactly the overlay contents (snapshot: a hash of the sorted path and content-hash pairs) and the
-- configuration (context) it was computed under, so a content change or another context simply misses.
-- Derived data: nothing here is needed to rebuild the facts.
CREATE TABLE IF NOT EXISTS resolution_contexts (
  id INTEGER PRIMARY KEY,
  ctx TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS resolved_edges (
  snapshot TEXT NOT NULL,
  context_id INTEGER NOT NULL,
  site_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  name TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_qualified_name TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_discriminator TEXT NOT NULL DEFAULT '',
  resolver TEXT NOT NULL,
  PRIMARY KEY (snapshot, context_id, site_path, start_line, start_column, end_line, end_column, name,
               target_path, target_qualified_name, target_kind, target_discriminator)
) WITHOUT ROWID;

-- The negative marker (Pitfall 6): one row per reference site the resolver was asked about, under the same
-- key as the edges minus the target. A site with an asked row is settled, with or without an edge, so the
-- resolver is not asked again until the snapshot or the context changes. Derived data like the edges: dropping
-- it changes only how often the resolver is called, never an answer. Created with IF NOT EXISTS, so a store
-- made before this table existed gains it on the next open and the schema version does not move.
CREATE TABLE IF NOT EXISTS resolved_asked (
  snapshot TEXT NOT NULL,
  context_id INTEGER NOT NULL,
  site_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (snapshot, context_id, site_path, start_line, start_column, end_line, end_column, name)
) WITHOUT ROWID;

-- Symbol-to-symbol relations from the precise tier (plan 03-25, OQ1): extends, implements and overrides. A relation
-- binds two grammar symbols, so it has no site; it is valid for exactly the overlay contents (snapshot) and the
-- configuration (context) it was computed under, like an edge. Derived data, created with IF NOT EXISTS, so a store made
-- before this table existed gains it on the next open and the schema version does not move.
CREATE TABLE IF NOT EXISTS resolved_relations (
  snapshot TEXT NOT NULL,
  context_id INTEGER NOT NULL,
  from_path TEXT NOT NULL,
  from_qualified_name TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_discriminator TEXT NOT NULL DEFAULT '',
  to_path TEXT NOT NULL,
  to_qualified_name TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_discriminator TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL CHECK (relation IN ('extends', 'implements', 'overrides')),
  resolver TEXT NOT NULL,
  PRIMARY KEY (snapshot, context_id, from_path, from_qualified_name, from_kind, from_discriminator,
               to_path, to_qualified_name, to_kind, to_discriminator, relation)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS resolved_relations_by_to ON resolved_relations (snapshot, context_id, to_path, to_qualified_name);

-- The per-file marker of relations: the resolver was asked for the relations whose \`from\` is declared in this file,
-- with or without any answer. A file with a marker is settled until the snapshot or the context changes. Written only
-- when the resolver's call completed, so a timeout or a failure never settles a file.
CREATE TABLE IF NOT EXISTS relations_asked (
  snapshot TEXT NOT NULL,
  context_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  PRIMARY KEY (snapshot, context_id, file_path)
) WITHOUT ROWID;
`);
  createFuzzyIndex(db, fuzzy);
}

/** The `meta` entry that records which fuzzy-name path kept `names_fts` in step with `names`. */
export const FUZZY_PATH_META = 'fuzzy_path';

/**
 * What the open step found out about the SQL engine's full-text support, and whether to use it. `trigram` is
 * the effective choice (capability and no test override); `contentlessDelete` says whether the table can have
 * rows deleted, which plan 02-18 needs to drop garbage-collected names.
 */
export interface FuzzyIndex {
  readonly trigram: boolean;
  readonly contentlessDelete: boolean;
}

/**
 * Fuzzy name search (research Pattern 1): a contentless FTS5 table over the interned names, rowid = names.id,
 * tokenized into trigrams with `detail=full` so a quoted phrase of three or more characters finds any
 * substring. It holds no text a reader can get back, only the index. Writers add a row when they intern a new
 * name; `meta.fuzzy_path` says whether the last session that wrote kept the table in step. When this session
 * uses the table but the last one did not (a fresh store, or a capability that came and went), the table is
 * emptied and refilled from `names` so it can never miss a name. When this session does not use it, the entry
 * says `like` and the reader falls back to the bounded LIKE scan.
 */
function createFuzzyIndex(db: Db, fuzzy: FuzzyIndex): void {
  const recorded = db.prepare('SELECT value FROM meta WHERE name = ?').get(FUZZY_PATH_META);
  const setPath = db.prepare('INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)');
  if (!fuzzy.trigram) {
    setPath.run(FUZZY_PATH_META, 'like');
    return;
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS names_fts USING fts5(name, content='', ${
      fuzzy.contentlessDelete ? 'contentless_delete=1, ' : ''
    }detail=full, tokenize='trigram')`,
  );
  if (recorded === undefined || String(recorded.value) !== 'trigram') {
    db.exec("INSERT INTO names_fts (names_fts) VALUES ('delete-all')");
    db.exec('INSERT INTO names_fts (rowid, name) SELECT id, name FROM names');
    setPath.run(FUZZY_PATH_META, 'trigram');
  }
}
