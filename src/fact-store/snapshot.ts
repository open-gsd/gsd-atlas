/**
 * What one read call sees: the read connection inside one read transaction, per-call caches, and the loaders
 * that turn rows into the values the reader and the resolution module work with. Internal; not exported from
 * index.ts.
 */
import type {
  Answer,
  DegradedCode,
  EmitLookup,
  ImportStyle,
  LocatedSymbol,
  Span,
  SymbolIdentity,
  Watermark,
} from '../facts/index.ts';
import type { Db, Row } from '../sqlite/index.ts';
import { UnknownWorktree } from './errors.ts';
import { assertOpen, extractorOf, readTransaction } from './parts.ts';
import type { StoreParts } from './parts.ts';
import { isRelativeSpecifier, resolveSpecifier } from './specifier.ts';
import type { FindOptions, SymbolRecord, WorktreeId } from './types.ts';

/** The `files` columns a record's provenance is built from. */
export interface FileRow {
  readonly id: number;
  readonly hash: string;
  readonly module: string;
  readonly grammarVersion: string;
  readonly errorBytes: number;
  readonly totalBytes: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

/** One definition of a file, with the discriminator that tells same-named overloads apart. */
export interface FileSymbol {
  readonly ord: number;
  readonly name: string;
  readonly qualifiedName: string | null;
  readonly kind: string;
  readonly span: Span;
  readonly parent: number | null;
  readonly exported: boolean | null;
  readonly discriminator: string | undefined;
}

/** One export of a file as stored: `local` and `from` are null when the export has none. */
export interface ExportRow {
  readonly name: string;
  readonly local: string | null;
  readonly from: string | null;
}

/** A name bound by an import: the exported name (`default`, `*` for a namespace) and the local name. */
export interface BindingRow {
  readonly imported: string;
  readonly local: string;
}

/** One relative import of the overlay, with the overlay path of the importing file. */
export interface ImportRow {
  readonly importer: string;
  readonly fileId: number;
  readonly ord: number;
  readonly specifier: string;
  readonly style: ImportStyle | null;
  readonly span: Span;
  readonly bindings: readonly BindingRow[];
}

/** The paths of one overlay. */
export interface OverlayView {
  /** Every path, including those whose facts are still pending. */
  readonly paths: ReadonlySet<string>;
  /** Path to file id; null while the path's facts are pending. */
  readonly fileIds: ReadonlyMap<string, number | null>;
  /** Path to blob hash. */
  readonly hashes: ReadonlyMap<string, string>;
}

/** Lazily built views of the overlay, shared by every walk inside one read. */
export interface SnapshotViews {
  overlay?: OverlayView;
  imports?: readonly ImportRow[];
  importsByPath?: ReadonlyMap<string, readonly ImportRow[]>;
  readonly exports: Map<number, readonly ExportRow[]>;
  readonly resolved: Map<string, readonly string[]>;
}

/** What one read call sees. */
export interface Snapshot {
  readonly db: Db;
  readonly parts: StoreParts;
  readonly worktree: WorktreeId;
  /** The overlay's watermark seq at the start of this read. */
  readonly seq: number;
  readonly files: Map<number, FileRow>;
  readonly symbols: Map<number, readonly FileSymbol[]>;
  readonly views: SnapshotViews;
  /** Where the project's compiler writes its output, when the read was given the project context (TSM-03). */
  readonly emit?: EmitLookup;
}

export const str = (value: unknown): string => String(value);
export const num = (value: unknown): number => Number(value);

export function spanOf(row: Row, prefix = ''): Span {
  return {
    startLine: num(row[`${prefix}start_line`]),
    startColumn: num(row[`${prefix}start_col`]),
    endLine: num(row[`${prefix}end_line`]),
    endColumn: num(row[`${prefix}end_col`]),
  };
}

export function fileRow(snap: Snapshot, fileId: number): FileRow {
  const known = snap.files.get(fileId);
  if (known !== undefined) return known;
  const row = snap.db
    .prepare(
      'SELECT id, hash, module, grammar_version, error_bytes, total_bytes, first_seen, last_seen FROM files WHERE id = ?',
    )
    .get(fileId);
  if (row === undefined) throw new Error(`file ${fileId} is referenced by an overlay but has no row`);
  const file: FileRow = {
    id: num(row.id),
    hash: str(row.hash),
    module: str(row.module),
    grammarVersion: str(row.grammar_version),
    errorBytes: num(row.error_bytes),
    totalBytes: num(row.total_bytes),
    firstSeen: num(row.first_seen),
    lastSeen: num(row.last_seen),
  };
  snap.files.set(fileId, file);
  return file;
}

/**
 * The definitions of one file in definition order. The discriminator is the zero-based index among the
 * symbols that share a qualified name (or name) and kind, set only when more than one share them.
 */
export function fileSymbols(snap: Snapshot, fileId: number): readonly FileSymbol[] {
  const known = snap.symbols.get(fileId);
  if (known !== undefined) return known;
  const rows = snap.db
    .prepare(
      `SELECT s.ord AS ord, n.name AS name, q.name AS qname, s.kind AS kind, s.start_line AS start_line,
              s.start_col AS start_col, s.end_line AS end_line, s.end_col AS end_col, s.parent AS parent,
              s.exported AS exported
       FROM symbols s
       JOIN names n ON n.id = s.name_id
       LEFT JOIN names q ON q.id = s.qname_id
       WHERE s.file_id = ?
       ORDER BY s.ord`,
    )
    .all(fileId);
  const groupSize = new Map<string, number>();
  const groupKey = (row: Row): string => `${str(row.qname ?? row.name)}\u0000${str(row.kind)}`;
  for (const row of rows) groupSize.set(groupKey(row), (groupSize.get(groupKey(row)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const symbols: FileSymbol[] = rows.map((row) => {
    const key = groupKey(row);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    return {
      ord: num(row.ord),
      name: str(row.name),
      qualifiedName: row.qname === null ? null : str(row.qname),
      kind: str(row.kind),
      span: spanOf(row),
      parent: row.parent === null ? null : num(row.parent),
      exported: row.exported === null ? null : num(row.exported) !== 0,
      discriminator: (groupSize.get(key) ?? 0) > 1 ? String(index) : undefined,
    };
  });
  snap.symbols.set(fileId, symbols);
  return symbols;
}

export function identityOf(snap: Snapshot, path: string, symbol: FileSymbol): SymbolIdentity {
  const base = { repo: snap.parts.repo, path, qualifiedName: symbol.qualifiedName ?? symbol.name, kind: symbol.kind };
  return symbol.discriminator === undefined ? base : { ...base, discriminator: symbol.discriminator };
}

export function symbolRecord(snap: Snapshot, path: string, file: FileRow, symbol: FileSymbol): SymbolRecord {
  const record: SymbolRecord = {
    identity: identityOf(snap, path, symbol),
    // Without source text there is no symbol-level hash; the file's content hash is the version.
    version: file.hash,
    source_path: path,
    span: symbol.span,
    extractor: extractorOf(file.module, file.grammarVersion),
    content_hash: file.hash,
    first_seen: file.firstSeen,
    last_seen: file.lastSeen,
    confidence: 'EXTRACTED',
    debug: `sym/${encodeURIComponent(path)}/${file.hash}/${symbol.ord}`,
  };
  return symbol.exported === null ? record : { ...record, exported: symbol.exported };
}

/** The file id behind an overlay path, or null when the path is absent or its facts are pending. */
export function fileIdAt(snap: Snapshot, path: string): number | null {
  const row = snap.db
    .prepare('SELECT file_id FROM overlay_files WHERE worktree = ? AND path = ?')
    .get(snap.worktree, path);
  return row === undefined || row.file_id === null ? null : num(row.file_id);
}

/** The symbol an identity names in this overlay, with its file; null when the repo, path, kind or name differ. */
export function findSymbol(snap: Snapshot, id: SymbolIdentity): { file: FileRow; symbol: FileSymbol } | null {
  if (id.repo !== snap.parts.repo) return null;
  const fileId = fileIdAt(snap, id.path);
  if (fileId === null) return null;
  const symbol = fileSymbols(snap, fileId).find(
    (candidate) =>
      candidate.kind === id.kind &&
      (candidate.qualifiedName ?? candidate.name) === id.qualifiedName &&
      candidate.discriminator === id.discriminator,
  );
  return symbol === undefined ? null : { file: fileRow(snap, fileId), symbol };
}

/**
 * Every symbol called `name` that the overlay's version of the file at `path` defines (the content hash the
 * overlay maps to that path), in definition order, with its identity and the span of its definition. The path
 * is looked up exactly as the overlay stores it; an unknown path, a pending one, a path outside the overlay
 * and an unknown name all give an empty list (T-03-204: nothing outside the overlay's own file is read).
 */
export function symbolsIn(snap: Snapshot, path: string, name: string): LocatedSymbol[] {
  const fileId = fileIdAt(snap, path);
  if (fileId === null) return [];
  return fileSymbols(snap, fileId)
    .filter((symbol) => symbol.name === name)
    .map((symbol) => ({ ...identityOf(snap, path, symbol), span: symbol.span }));
}

/** Every path of the overlay, loaded once per read. */
export function overlayView(snap: Snapshot): OverlayView {
  if (snap.views.overlay !== undefined) return snap.views.overlay;
  const paths = new Set<string>();
  const fileIds = new Map<string, number | null>();
  const hashes = new Map<string, string>();
  for (const row of snap.db
    .prepare('SELECT path, hash, file_id FROM overlay_files WHERE worktree = ? ORDER BY path')
    .all(snap.worktree)) {
    const path = str(row.path);
    paths.add(path);
    hashes.set(path, str(row.hash));
    fileIds.set(path, row.file_id === null ? null : num(row.file_id));
  }
  const view: OverlayView = { paths, fileIds, hashes };
  snap.views.overlay = view;
  return view;
}

const IMPORTS_SQL = `SELECT o.path AS importer, i.file_id AS file_id, i.ord AS ord, i.path AS specifier, i.style AS style,
       i.start_line AS start_line, i.start_col AS start_col, i.end_line AS end_line, i.end_col AS end_col
       FROM overlay_files o
       JOIN imports i ON i.file_id = o.file_id
       WHERE o.worktree = ?
       ORDER BY o.path, i.start_line, i.start_col, i.ord`;

const BINDINGS_SQL = `SELECT b.file_id AS file_id, b.import_ord AS import_ord, b.imported AS imported, b.local_name AS local_name
       FROM import_bindings b
       WHERE b.file_id IN (SELECT DISTINCT file_id FROM overlay_files WHERE worktree = ? AND file_id IS NOT NULL)
       ORDER BY b.file_id, b.import_ord, b.ord`;

/**
 * Every relative import of the overlay, ordered by importing path then position, with its bindings. Non-relative
 * specifiers are left out: they never resolve before Phase 3, so no walk needs them.
 */
export function importRows(snap: Snapshot): readonly ImportRow[] {
  if (snap.views.imports !== undefined) return snap.views.imports;
  const bindings = new Map<string, BindingRow[]>();
  for (const row of snap.db.prepare(BINDINGS_SQL).all(snap.worktree)) {
    const key = `${num(row.file_id)}:${num(row.import_ord)}`;
    const list = bindings.get(key) ?? [];
    list.push({ imported: str(row.imported), local: str(row.local_name) });
    bindings.set(key, list);
  }
  const rows: ImportRow[] = [];
  for (const row of snap.db.prepare(IMPORTS_SQL).all(snap.worktree)) {
    const specifier = str(row.specifier);
    if (!isRelativeSpecifier(specifier)) continue;
    const fileId = num(row.file_id);
    const ord = num(row.ord);
    rows.push({
      importer: str(row.importer),
      fileId,
      ord,
      specifier,
      style: row.style === null ? null : (str(row.style) as ImportStyle),
      span: spanOf(row),
      bindings: bindings.get(`${fileId}:${ord}`) ?? [],
    });
  }
  snap.views.imports = rows;
  return rows;
}

/** The relative imports written in one overlay path, in source order. */
export function importsOf(snap: Snapshot, path: string): readonly ImportRow[] {
  if (snap.views.importsByPath === undefined) {
    const grouped = new Map<string, ImportRow[]>();
    for (const row of importRows(snap)) {
      const list = grouped.get(row.importer) ?? [];
      list.push(row);
      grouped.set(row.importer, list);
    }
    snap.views.importsByPath = grouped;
  }
  return snap.views.importsByPath.get(path) ?? [];
}

/** The exports of one file in source order. */
export function exportsOf(snap: Snapshot, fileId: number): readonly ExportRow[] {
  const known = snap.views.exports.get(fileId);
  if (known !== undefined) return known;
  const rows = snap.db
    .prepare(
      `SELECT n.name AS name, l.name AS local_name, e.from_path AS from_path
       FROM exports e JOIN names n ON n.id = e.name_id LEFT JOIN names l ON l.id = e.local_id
       WHERE e.file_id = ? ORDER BY e.ord`,
    )
    .all(fileId)
    .map((row) => ({
      name: str(row.name),
      local: row.local_name === null ? null : str(row.local_name),
      from: row.from_path === null ? null : str(row.from_path),
    }));
  snap.views.exports.set(fileId, rows);
  return rows;
}

/** The overlay paths a specifier written in `importer` names, memoised for this read. */
export function resolveImport(snap: Snapshot, importer: string, specifier: string): readonly string[] {
  const key = `${importer}\u0000${specifier}`;
  const known = snap.views.resolved.get(key);
  if (known !== undefined) return known;
  const found = resolveSpecifier(importer, specifier, overlayView(snap).paths, snap.emit);
  snap.views.resolved.set(key, found);
  return found;
}

/** Paths in the overlay with no facts yet (pending) or with facts a newer grammar replaced (stale). */
const STALE_PATHS_SQL = `SELECT o.path AS path FROM overlay_files o LEFT JOIN files f ON f.id = o.file_id
  WHERE o.worktree = ? AND (o.file_id IS NULL OR f.stale = 1)`;

/** The state one read ran against, without its data. */
export interface ReadState {
  readonly watermark: Watermark;
  /** Process-wide codes plus `stale` when the watermark has stale paths. */
  readonly degraded: readonly DegradedCode[];
}

export interface SnapshotRead<T> extends ReadState {
  readonly value: T;
}

/**
 * Run `read` inside one read transaction on the read connection: the watermark (seq and stale paths) and
 * `read` see the same committed state. Throws `StoreClosed` and `UnknownWorktree` only.
 */
export function readSnapshot<T>(
  parts: StoreParts,
  worktree: WorktreeId,
  read: (snap: Snapshot) => T,
  emit?: EmitLookup,
): SnapshotRead<T> {
  assertOpen(parts);
  return readTransaction(parts, (db) => {
    const overlay = db.prepare('SELECT seq FROM overlays WHERE worktree = ? AND dropped = 0').get(worktree);
    if (overlay === undefined) throw new UnknownWorktree(worktree);
    const stalePaths = db
      .prepare(STALE_PATHS_SQL)
      .all(worktree)
      .map((row) => str(row.path))
      .sort();
    const seq = num(overlay.seq);
    const value = read({
      db,
      parts,
      worktree,
      seq,
      files: new Map(),
      symbols: new Map(),
      views: { exports: new Map(), resolved: new Map() },
      ...(emit === undefined ? {} : { emit }),
    });
    const degraded: DegradedCode[] = [...parts.degradedNow()];
    if (stalePaths.length > 0 && !degraded.includes('stale')) degraded.push('stale');
    return { value, watermark: { seq, stalePaths }, degraded };
  });
}

/** Wrap data in an Answer with the state it was read against, plus any further degraded codes. */
export function toAnswer<T>(state: ReadState, data: T, extra: readonly DegradedCode[] = []): Answer<T> {
  const degraded = [...state.degraded];
  for (const code of extra) if (!degraded.includes(code)) degraded.push(code);
  return degraded.length === 0
    ? { data, watermark: state.watermark }
    : { data, watermark: state.watermark, degraded };
}

/** One synchronous read wrapped in an Answer. */
export function answer<T>(parts: StoreParts, worktree: WorktreeId, read: (snap: Snapshot) => T, emit?: EmitLookup): Answer<T> {
  const done = readSnapshot(parts, worktree, read, emit);
  return toAnswer(done, done.value);
}

/** `prefix` and `fuzzy` return at most this many rows unless the caller passes a limit. */
const DEFAULT_FIND_LIMIT = 50;

/** The shortest `fuzzy` query that returns rows (shorter ones match too much to be useful). */
const MIN_FUZZY_CHARS = 3;

/** Highest code point: a name that starts with the query sorts below `query + U+10FFFF`. */
const RANGE_END = '\u{10FFFF}';

const FIND_HEAD = `SELECT o.path AS path, s.file_id AS file_id, s.ord AS ord
       FROM names n
       JOIN symbols s ON s.name_id = n.id
       JOIN overlay_files o ON o.file_id = s.file_id AND o.worktree = ?`;
const FIND_TAIL = `ORDER BY o.path, s.start_line, s.start_col, s.ord
       LIMIT ?`;
const FIND_EXACT_SQL = `${FIND_HEAD} WHERE n.name = ? ${FIND_TAIL}`;
const FIND_PREFIX_SQL = `${FIND_HEAD} WHERE n.name >= ? AND n.name < ? ${FIND_TAIL}`;
const FIND_FUZZY_SQL = `${FIND_HEAD} WHERE instr(lower(n.name), lower(?)) > 0 ${FIND_TAIL}`;
/** The trigram path: the interned names that contain the quoted phrase, found through `names_fts`. */
const FIND_TRIGRAM_SQL = `${FIND_HEAD} WHERE n.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) ${FIND_TAIL}`;

/**
 * The query as one FTS5 phrase: wrapped in double quotes with embedded double quotes doubled, so no operator
 * (AND, OR, NEAR, a column filter, a prefix star) can be injected through it (T-02-32). It is bound as a
 * parameter, never concatenated into SQL.
 */
function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/** Definitions by name in one of three modes; see `FindOptions`. */
export function findRecords(snap: Snapshot, name: string, options: FindOptions | undefined): readonly SymbolRecord[] {
  if (name === '') return [];
  const mode = options?.mode ?? 'exact';
  if (mode === 'fuzzy' && name.length < MIN_FUZZY_CHARS) return [];
  const limit =
    options?.limit !== undefined
      ? Math.max(0, Math.floor(options.limit))
      : mode === 'exact'
        ? -1
        : DEFAULT_FIND_LIMIT;
  const db = snap.db;
  const hits =
    mode === 'prefix'
      ? db.prepare(FIND_PREFIX_SQL).all(snap.worktree, name, name + RANGE_END, limit)
      : mode === 'fuzzy'
        ? snap.parts.fuzzyTrigram
          ? db.prepare(FIND_TRIGRAM_SQL).all(snap.worktree, ftsPhrase(name), limit)
          : db.prepare(FIND_FUZZY_SQL).all(snap.worktree, name, limit)
        : db.prepare(FIND_EXACT_SQL).all(snap.worktree, name, limit);
  return hits.map((hit) => {
    const fileId = num(hit.file_id);
    const symbol = fileSymbols(snap, fileId).find((candidate) => candidate.ord === num(hit.ord));
    if (symbol === undefined) throw new Error('a symbol row vanished inside a read transaction');
    return symbolRecord(snap, str(hit.path), fileRow(snap, fileId), symbol);
  });
}
