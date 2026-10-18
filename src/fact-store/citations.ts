/**
 * Reads of the ADR citations a worktree overlay holds (plan 03-28, D-19, D-20). The rows were written in the file version's own
 * transaction (writer.ts); this joins them to the overlay so a version shared by two paths answers for each path, and turns a
 * row into a record with provenance in the shape of every other fact: the path the overlay maps, the file version, the extractor,
 * and a `cit/` handle that `code_explain` can resolve.
 *
 * Only numbers, short details, spans and symbol ordinals are stored, so only they come back; no ADR document is involved here.
 */
import type { Row } from '../sqlite/index.ts';
import { extractorOf } from './parts.ts';
import { fileRow, fileSymbols, findSymbol, identityOf, num, spanOf, str } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import type { CitationRecord, CitationsQuery } from './types.ts';

/** The handle of a citation: its overlay path, the file version it was read from and its position in that version's citations. */
export function citationHandle(path: string, hash: string, ord: number): string {
  return `cit/${encodeURIComponent(path)}/${hash}/${String(ord)}`;
}

const BY_NUMBER_SQL = `SELECT o.path AS path, c.file_id AS file_id, c.ord AS ord, c.number AS number, c.detail AS detail,
       c.start_line AS start_line, c.start_col AS start_col, c.end_line AS end_line, c.end_col AS end_col, c.enclosing AS enclosing
       FROM citations c JOIN overlay_files o ON o.file_id = c.file_id AND o.worktree = ?
       WHERE c.number = ?
       ORDER BY o.path, c.start_line, c.start_col, c.ord
       LIMIT ?`;

const BY_SYMBOL_SQL = `SELECT c.file_id AS file_id, c.ord AS ord, c.number AS number, c.detail AS detail,
       c.start_line AS start_line, c.start_col AS start_col, c.end_line AS end_line, c.end_col AS end_col, c.enclosing AS enclosing
       FROM citations c WHERE c.file_id = ? AND c.enclosing = ?
       ORDER BY c.start_line, c.start_col, c.ord
       LIMIT ?`;

/** `limit` as a SQL row count: -1 (no bound) when absent, else a whole number of at least 0. */
function sqlLimit(limit: number | undefined): number {
  return limit === undefined || Number.isNaN(limit) ? -1 : Math.max(0, Math.floor(limit));
}

function recordOf(snap: Snapshot, path: string, row: Row): CitationRecord {
  const fileId = num(row.file_id);
  const file = fileRow(snap, fileId);
  const ord = num(row.ord);
  const enclosingOrd = row.enclosing === null ? null : num(row.enclosing);
  const symbol = enclosingOrd === null ? undefined : fileSymbols(snap, fileId).find((candidate) => candidate.ord === enclosingOrd);
  return {
    source_path: path,
    span: spanOf(row),
    extractor: extractorOf(file.module, file.grammarVersion),
    content_hash: file.hash,
    first_seen: file.firstSeen,
    last_seen: file.lastSeen,
    confidence: 'EXTRACTED',
    debug: citationHandle(path, file.hash, ord),
    number: num(row.number),
    ...(row.detail === null ? {} : { detail: str(row.detail) }),
    enclosing: symbol === undefined ? null : identityOf(snap, path, symbol),
  };
}

const GAP_FILES_SQL = `SELECT count(*) AS n FROM overlay_files o JOIN citation_gaps g ON g.file_id = o.file_id WHERE o.worktree = ?`;
const GAP_PATH_SQL = `${GAP_FILES_SQL} AND o.path = ?`;

/**
 * How many files of the overlay hold a citation gap (plan 03-28), or, with `path`, 1 or 0 for that one path. A file version
 * linked from two paths counts for each path, because each is a file of the worktree whose citations are incomplete.
 */
export function countCitationGaps(snap: Snapshot, path: string | undefined): number {
  const row = path === undefined ? snap.db.prepare(GAP_FILES_SQL).get(snap.worktree) : snap.db.prepare(GAP_PATH_SQL).get(snap.worktree, path);
  return num(row?.n ?? 0);
}

/** The citations `query` asks for, in the order of {@link Reader.citations}. */
export function readCitations(snap: Snapshot, query: CitationsQuery, limit: number | undefined): CitationRecord[] {
  const bound = sqlLimit(limit);
  if (query.number !== undefined) {
    if (!Number.isSafeInteger(query.number)) return [];
    return snap.db
      .prepare(BY_NUMBER_SQL)
      .all(snap.worktree, query.number, bound)
      .map((row) => recordOf(snap, str(row.path), row));
  }
  if (query.symbol !== undefined) {
    const found = findSymbol(snap, query.symbol);
    if (found === null) return [];
    return snap.db
      .prepare(BY_SYMBOL_SQL)
      .all(found.file.id, found.symbol.ord, bound)
      .map((row) => recordOf(snap, query.symbol?.path ?? '', row));
  }
  return [];
}
