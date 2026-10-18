/**
 * The resolved-edge cache (STO-04): keys, reads and writes of `resolved_edges` and of the `resolved_asked`
 * markers (sites the resolver was asked about, with or without an edge). A cached edge or marker is valid for one
 * overlay snapshot (the exact set of path and content-hash pairs) and one resolution context, so nothing is ever
 * invalidated: a content change or another context is a different key and simply misses. Internal; not exported
 * from index.ts.
 */
import { createHash } from 'node:crypto';
import type { RefSiteKey, RelationKind, ResolutionContext, ResolvedEdge, ResolvedRelation, SymbolIdentity } from '../facts/index.ts';
import { DbError } from '../sqlite/index.ts';
import type { Db } from '../sqlite/index.ts';

const SEPARATOR = '\u0000';

/**
 * The id of an overlay's contents: the sha256, in hex, of its sorted `path NUL hash NUL` pairs. Two overlays
 * with identical contents have the same id and share cache rows; any path or hash change gives a new id.
 */
export function overlaySnapshotId(pathToHash: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const path of [...pathToHash.keys()].sort()) {
    hash.update(path);
    hash.update(SEPARATOR);
    hash.update(pathToHash.get(path) ?? '');
    hash.update(SEPARATOR);
  }
  return hash.digest('hex');
}

/** The stored form of a resolution context: its id and its config hashes in sorted order, as JSON. */
export function contextKey(context: ResolutionContext): string {
  return JSON.stringify({ id: context.id, configHashes: [...context.configHashes].sort() });
}

/** A string usable as a map key for a reference site: path, the four span numbers and the name. */
export function siteId(site: RefSiteKey): string {
  const { startLine, startColumn, endLine, endColumn } = site.span;
  return [site.path, startLine, startColumn, endLine, endColumn, site.name].join(SEPARATOR);
}

/** One edge as the cache holds it: the repo is the store's own, so it is not stored. */
export interface CachedEdge {
  readonly site: RefSiteKey;
  readonly target: SymbolIdentity;
  /** The id of the resolver that produced the edge, without the `precise:` prefix. */
  readonly resolver: string;
}

/** The row id of a stored resolution context, or undefined when no edge was ever cached under it. */
export function findContextId(db: Db, key: string): number | undefined {
  const row = db.prepare('SELECT id FROM resolution_contexts WHERE ctx = ?').get(key);
  return row === undefined ? undefined : Number(row.id);
}

/** The row id of a resolution context, creating it when new. Writer connection only. */
export function ensureContextId(db: Db, key: string): number {
  db.prepare('INSERT OR IGNORE INTO resolution_contexts (ctx) VALUES (?)').run(key);
  const id = findContextId(db, key);
  if (id === undefined) throw new Error('a resolution context that was just stored is missing');
  return id;
}

const READ_EDGES_SQL = `SELECT target_path, target_qualified_name, target_kind, target_discriminator, resolver
  FROM resolved_edges
  WHERE snapshot = ? AND context_id = ? AND site_path = ? AND start_line = ? AND start_column = ?
    AND end_line = ? AND end_column = ? AND name = ?
  ORDER BY target_path, target_qualified_name, target_kind, target_discriminator`;

/**
 * The cached edges of each requested site under one snapshot and context, keyed by `siteId`. A site with no
 * cached edge is absent from the result.
 */
export function readEdges(
  db: Db,
  snapshot: string,
  contextId: number,
  sites: readonly RefSiteKey[],
  repo: string,
): Map<string, CachedEdge[]> {
  const select = db.prepare(READ_EDGES_SQL);
  const found = new Map<string, CachedEdge[]>();
  for (const site of sites) {
    const { startLine, startColumn, endLine, endColumn } = site.span;
    const rows = select.all(snapshot, contextId, site.path, startLine, startColumn, endLine, endColumn, site.name);
    if (rows.length === 0) continue;
    found.set(
      siteId(site),
      rows.map((row) => {
        const discriminator = String(row.target_discriminator);
        const target: SymbolIdentity = {
          repo,
          path: String(row.target_path),
          qualifiedName: String(row.target_qualified_name),
          kind: String(row.target_kind),
          ...(discriminator === '' ? {} : { discriminator }),
        };
        return { site, target, resolver: String(row.resolver) };
      }),
    );
  }
  return found;
}

/**
 * Store edges under one snapshot and context. `INSERT OR IGNORE` against the full key, so storing an edge twice
 * (two calls that both missed the cache) leaves one row. Writer connection, inside the caller's transaction.
 */
export function writeEdges(
  db: Db,
  snapshot: string,
  contextId: number,
  edges: readonly ResolvedEdge[],
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO resolved_edges
       (snapshot, context_id, site_path, start_line, start_column, end_line, end_column, name,
        target_path, target_qualified_name, target_kind, target_discriminator, resolver)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const edge of edges) {
    const { startLine, startColumn, endLine, endColumn } = edge.site.span;
    insert.run(
      snapshot,
      contextId,
      edge.site.path,
      startLine,
      startColumn,
      endLine,
      endColumn,
      edge.site.name,
      edge.target.path,
      edge.target.qualifiedName,
      edge.target.kind,
      edge.target.discriminator ?? '',
      edge.resolver,
    );
  }
}

/** The snapshot ids of every live overlay, read from the stored overlay rows. */
export function liveSnapshotIds(db: Db): Set<string> {
  const ids = new Set<string>();
  const files = db.prepare('SELECT path, hash FROM overlay_files WHERE worktree = ?');
  for (const overlay of db.prepare('SELECT worktree FROM overlays WHERE dropped = 0').all()) {
    const pairs = new Map<string, string>();
    for (const row of files.all(String(overlay.worktree))) pairs.set(String(row.path), String(row.hash));
    ids.add(overlaySnapshotId(pairs));
  }
  return ids;
}

const READ_ASKED_SQL = `SELECT 1 AS found
  FROM resolved_asked
  WHERE snapshot = ? AND context_id = ? AND site_path = ? AND start_line = ? AND start_column = ?
    AND end_line = ? AND end_column = ? AND name = ?`;

/**
 * The sites, among `sites`, that were asked of the resolver under one snapshot and context, as a set of
 * `siteId`s. An asked site is settled: the resolver said what it had (an edge, or nothing) and is not asked
 * again. A table that can not be read (a store from a build that predates it, opened without write access)
 * counts as no markers: the worst outcome is asking again, never a failed read.
 */
export function readAsked(db: Db, snapshot: string, contextId: number, sites: readonly RefSiteKey[]): Set<string> {
  const found = new Set<string>();
  try {
    const select = db.prepare(READ_ASKED_SQL);
    for (const site of sites) {
      const { startLine, startColumn, endLine, endColumn } = site.span;
      if (select.get(snapshot, contextId, site.path, startLine, startColumn, endLine, endColumn, site.name) !== undefined) {
        found.add(siteId(site));
      }
    }
  } catch (error) {
    if (!(error instanceof DbError)) throw error;
    found.clear();
  }
  return found;
}

/**
 * Mark sites as asked under one snapshot and context. `INSERT OR IGNORE` against the full key, so marking a
 * site twice (two reads that both missed) leaves one row. Writer connection, inside the caller's transaction.
 */
export function writeAsked(db: Db, snapshot: string, contextId: number, sites: readonly RefSiteKey[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO resolved_asked
       (snapshot, context_id, site_path, start_line, start_column, end_line, end_column, name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const site of sites) {
    const { startLine, startColumn, endLine, endColumn } = site.span;
    insert.run(snapshot, contextId, site.path, startLine, startColumn, endLine, endColumn, site.name);
  }
}

/**
 * Delete the edges, the relations and the asked markers of every snapshot that no live overlay has any more, so the
 * cache stays bounded. All four tables go in one pass: a marker never outlives the snapshot it describes.
 */
export function pruneEdges(db: Db, live: ReadonlySet<string>): void {
  for (const table of ['resolved_edges', 'resolved_asked', 'resolved_relations', 'relations_asked']) {
    const remove = db.prepare(`DELETE FROM ${table} WHERE snapshot = ?`);
    for (const row of db.prepare(`SELECT DISTINCT snapshot FROM ${table}`).all()) {
      const snapshot = String(row.snapshot);
      if (!live.has(snapshot)) remove.run(snapshot);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Relations (plan 03-25): extends, implements and overrides, cached like edges and settled per file.
// ---------------------------------------------------------------------------------------------------------

/** One relation as the cache holds it: the repo is the store's own, so it is not stored. */
export interface CachedRelation {
  readonly from: SymbolIdentity;
  readonly to: SymbolIdentity;
  readonly relation: RelationKind;
  /** The id of the resolver that produced the relation, without the `precise:` prefix. */
  readonly resolver: string;
}

const RELATION_COLUMNS = `from_path, from_qualified_name, from_kind, from_discriminator,
  to_path, to_qualified_name, to_kind, to_discriminator, relation, resolver`;

function endpointOf(repo: string, row: Record<string, unknown>, side: 'from' | 'to'): SymbolIdentity {
  const discriminator = String(row[`${side}_discriminator`]);
  return {
    repo,
    path: String(row[`${side}_path`]),
    qualifiedName: String(row[`${side}_qualified_name`]),
    kind: String(row[`${side}_kind`]),
    ...(discriminator === '' ? {} : { discriminator }),
  };
}

function relationOf(repo: string, row: Record<string, unknown>): CachedRelation {
  return {
    from: endpointOf(repo, row, 'from'),
    to: endpointOf(repo, row, 'to'),
    relation: String(row.relation) as RelationKind,
    resolver: String(row.resolver),
  };
}

/** The cached relations whose `to` is `target`, under one snapshot and context. A store that cannot read the table has none. */
export function readRelationsTo(db: Db, snapshot: string, contextId: number, target: SymbolIdentity, repo: string): CachedRelation[] {
  try {
    return db
      .prepare(
        `SELECT ${RELATION_COLUMNS} FROM resolved_relations
         WHERE snapshot = ? AND context_id = ? AND to_path = ? AND to_qualified_name = ? AND to_kind = ? AND to_discriminator = ?`,
      )
      .all(snapshot, contextId, target.path, target.qualifiedName, target.kind, target.discriminator ?? '')
      .map((row) => relationOf(repo, row));
  } catch (error) {
    if (!(error instanceof DbError)) throw error;
    return [];
  }
}

/** The cached relations whose `from` is declared in `filePath`, under one snapshot and context. */
export function readRelationsFrom(db: Db, snapshot: string, contextId: number, filePath: string, repo: string): CachedRelation[] {
  try {
    return db
      .prepare(`SELECT ${RELATION_COLUMNS} FROM resolved_relations WHERE snapshot = ? AND context_id = ? AND from_path = ?`)
      .all(snapshot, contextId, filePath)
      .map((row) => relationOf(repo, row));
  } catch (error) {
    if (!(error instanceof DbError)) throw error;
    return [];
  }
}

/**
 * The files, among `files`, whose relations were asked of the resolver under one snapshot and context. A table that can not
 * be read counts as no markers: the worst outcome is asking again, never a failed read.
 */
export function readRelationsAsked(db: Db, snapshot: string, contextId: number, files: readonly string[]): Set<string> {
  const found = new Set<string>();
  try {
    const select = db.prepare('SELECT 1 AS found FROM relations_asked WHERE snapshot = ? AND context_id = ? AND file_path = ?');
    for (const file of files) if (select.get(snapshot, contextId, file) !== undefined) found.add(file);
  } catch (error) {
    if (!(error instanceof DbError)) throw error;
    found.clear();
  }
  return found;
}

/** Store relations under one snapshot and context (`INSERT OR IGNORE`, so one stored twice leaves one row). Writer connection, inside the caller's transaction. */
export function writeRelations(db: Db, snapshot: string, contextId: number, relations: readonly ResolvedRelation[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO resolved_relations
       (snapshot, context_id, from_path, from_qualified_name, from_kind, from_discriminator,
        to_path, to_qualified_name, to_kind, to_discriminator, relation, resolver)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of relations) {
    insert.run(
      snapshot,
      contextId,
      item.from.path,
      item.from.qualifiedName,
      item.from.kind,
      item.from.discriminator ?? '',
      item.to.path,
      item.to.qualifiedName,
      item.to.kind,
      item.to.discriminator ?? '',
      item.relation,
      item.resolver,
    );
  }
}

/** Mark files as asked under one snapshot and context. Writer connection, inside the caller's transaction. */
export function writeRelationsAsked(db: Db, snapshot: string, contextId: number, files: readonly string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO relations_asked (snapshot, context_id, file_path) VALUES (?, ?, ?)');
  for (const file of files) insert.run(snapshot, contextId, file);
}
