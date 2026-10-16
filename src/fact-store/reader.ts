import type {
  Answer,
  DegradedCode,
  ExportSite,
  FileFacts,
  ImportSite,
  LocalSymbol,
  RefKind,
  RefSite,
  Span,
  SymbolIdentity,
} from '../facts/index.ts';
import type { Db, Row } from '../sqlite/index.ts';
import { UnknownWorktree } from './errors.ts';
import { assertOpen, extractorOf } from './parts.ts';
import type { StoreParts } from './parts.ts';
import type { FindOptions, Reader, SymbolRecord, WorktreeId } from './types.ts';

/** The `files` columns a record's provenance is built from. */
interface FileRow {
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
interface FileSymbol {
  readonly ord: number;
  readonly name: string;
  readonly qualifiedName: string | null;
  readonly kind: string;
  readonly span: Span;
  readonly parent: number | null;
  readonly exported: boolean | null;
  readonly discriminator: string | undefined;
}

const str = (value: unknown): string => String(value);
const num = (value: unknown): number => Number(value);

function spanOf(row: Row, prefix = ''): Span {
  return {
    startLine: num(row[`${prefix}start_line`]),
    startColumn: num(row[`${prefix}start_col`]),
    endLine: num(row[`${prefix}end_line`]),
    endColumn: num(row[`${prefix}end_col`]),
  };
}

/** What one read call sees: the read connection inside one read transaction, plus per-call caches. */
interface Snapshot {
  readonly db: Db;
  readonly parts: StoreParts;
  readonly worktree: WorktreeId;
  readonly files: Map<number, FileRow>;
  readonly symbols: Map<number, readonly FileSymbol[]>;
}

function fileRow(snap: Snapshot, fileId: number): FileRow {
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
function fileSymbols(snap: Snapshot, fileId: number): readonly FileSymbol[] {
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

function identityOf(snap: Snapshot, path: string, symbol: FileSymbol): SymbolIdentity {
  const base = { repo: snap.parts.repo, path, qualifiedName: symbol.qualifiedName ?? symbol.name, kind: symbol.kind };
  return symbol.discriminator === undefined ? base : { ...base, discriminator: symbol.discriminator };
}

function symbolRecord(snap: Snapshot, path: string, file: FileRow, symbol: FileSymbol): SymbolRecord {
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

/** Paths in the overlay with no facts yet (pending) or with facts a newer grammar replaced (stale). */
const STALE_PATHS_SQL = `SELECT o.path AS path FROM overlay_files o LEFT JOIN files f ON f.id = o.file_id
  WHERE o.worktree = ? AND (o.file_id IS NULL OR f.stale = 1)`;

/**
 * Run `read` inside one read transaction on the read connection and wrap its result in an Answer: the
 * watermark (seq and stale paths) and `read` see the same committed state. Throws `StoreClosed` and
 * `UnknownWorktree` only.
 */
function answer<T>(
  parts: StoreParts,
  worktree: WorktreeId,
  read: (snap: Snapshot) => T,
): Answer<T> {
  assertOpen(parts);
  const db = parts.readDb;
  db.exec('BEGIN');
  try {
    const overlay = db.prepare('SELECT seq FROM overlays WHERE worktree = ? AND dropped = 0').get(worktree);
    if (overlay === undefined) throw new UnknownWorktree(worktree);
    const stalePaths = db
      .prepare(STALE_PATHS_SQL)
      .all(worktree)
      .map((row) => str(row.path))
      .sort();
    const data = read({ db, parts, worktree, files: new Map(), symbols: new Map() });
    const degraded: DegradedCode[] = [...parts.degradedNow()];
    if (stalePaths.length > 0 && !degraded.includes('stale')) degraded.push('stale');
    const watermark = { seq: num(overlay.seq), stalePaths };
    return degraded.length === 0 ? { data, watermark } : { data, watermark, degraded };
  } finally {
    db.exec('COMMIT');
  }
}

function notYet(): never {
  throw new Error('not implemented in this task');
}

function find(snap: Snapshot, name: string, options: FindOptions | undefined): readonly SymbolRecord[] {
  if (name === '') return [];
  const limit = options?.limit === undefined ? -1 : Math.max(0, Math.floor(options.limit));
  const hits = snap.db
    .prepare(
      `SELECT o.path AS path, s.file_id AS file_id, s.ord AS ord
       FROM names n
       JOIN symbols s ON s.name_id = n.id
       JOIN overlay_files o ON o.file_id = s.file_id AND o.worktree = ?
       WHERE n.name = ?
       ORDER BY o.path, s.start_line, s.start_col, s.ord
       LIMIT ?`,
    )
    .all(snap.worktree, name, limit);
  return hits.map((hit) => {
    const fileId = num(hit.file_id);
    const symbol = fileSymbols(snap, fileId).find((candidate) => candidate.ord === num(hit.ord));
    if (symbol === undefined) throw new Error('a symbol row vanished inside a read transaction');
    return symbolRecord(snap, str(hit.path), fileRow(snap, fileId), symbol);
  });
}

/** The file id behind an overlay path, or null when the path is absent or its facts are pending. */
function fileIdAt(snap: Snapshot, path: string): number | null {
  const row = snap.db
    .prepare('SELECT file_id FROM overlay_files WHERE worktree = ? AND path = ?')
    .get(snap.worktree, path);
  return row === undefined || row.file_id === null ? null : num(row.file_id);
}

function rebuildFacts(snap: Snapshot, path: string, fileId: number): FileFacts {
  const file = fileRow(snap, fileId);
  const symbols: LocalSymbol[] = fileSymbols(snap, fileId).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    span: symbol.span,
    ...(symbol.qualifiedName === null ? {} : { qualifiedName: symbol.qualifiedName }),
    ...(symbol.parent === null ? {} : { parent: symbol.parent }),
    ...(symbol.exported === null ? {} : { exported: symbol.exported }),
  }));

  const refSites: RefSite[] = snap.db
    .prepare(
      `SELECT n.name AS name, r.kind AS kind, r.start_line AS start_line, r.start_col AS start_col,
              r.end_line AS end_line, r.end_col AS end_col, r.import_path AS import_path, r.enclosing AS enclosing
       FROM refs r JOIN names n ON n.id = r.name_id WHERE r.file_id = ? ORDER BY r.ord`,
    )
    .all(fileId)
    .map((row) => ({
      name: str(row.name),
      span: spanOf(row),
      ...(row.import_path === null ? {} : { importPath: str(row.import_path) }),
      ...(row.kind === null ? {} : { kind: str(row.kind) as RefKind }),
      ...(row.enclosing === null ? {} : { enclosing: num(row.enclosing) }),
    }));

  const bindings = new Map<number, { imported: string; local: string }[]>();
  for (const row of snap.db
    .prepare('SELECT import_ord, imported, local_name FROM import_bindings WHERE file_id = ? ORDER BY import_ord, ord')
    .all(fileId)) {
    const list = bindings.get(num(row.import_ord)) ?? [];
    list.push({ imported: str(row.imported), local: str(row.local_name) });
    bindings.set(num(row.import_ord), list);
  }
  const imports: ImportSite[] = snap.db
    .prepare(
      'SELECT ord, path, style, start_line, start_col, end_line, end_col FROM imports WHERE file_id = ? ORDER BY ord',
    )
    .all(fileId)
    .map((row) => {
      const list = bindings.get(num(row.ord));
      return {
        path: str(row.path),
        span: spanOf(row),
        ...(row.style === null ? {} : { style: str(row.style) as NonNullable<ImportSite['style']> }),
        ...(list === undefined ? {} : { bindings: list }),
      };
    });

  const exports: ExportSite[] = snap.db
    .prepare(
      `SELECT n.name AS name, l.name AS local_name, e.from_path AS from_path, e.start_line AS start_line,
              e.start_col AS start_col, e.end_line AS end_line, e.end_col AS end_col
       FROM exports e JOIN names n ON n.id = e.name_id LEFT JOIN names l ON l.id = e.local_id
       WHERE e.file_id = ? ORDER BY e.ord`,
    )
    .all(fileId)
    .map((row) => ({
      name: str(row.name),
      span: spanOf(row),
      ...(row.local_name === null ? {} : { local: str(row.local_name) }),
      ...(row.from_path === null ? {} : { from: str(row.from_path) }),
    }));

  return {
    path,
    contentHash: file.hash,
    module: file.module,
    grammarVersion: file.grammarVersion,
    symbols,
    refSites,
    imports,
    exports,
    parse: { errorBytes: file.errorBytes, totalBytes: file.totalBytes },
  };
}

/**
 * A read-only view of one worktree overlay on the store's read connection. Readers hold no snapshot across
 * calls: every call sees the state committed when it starts. Task 3 of plan 02-06 completes refs, callers,
 * importers and the prefix and fuzzy modes.
 */
export function createReader(parts: StoreParts, worktree: WorktreeId): Reader {
  return {
    async find(name, options) {
      return answer(parts, worktree, (snap) => find(snap, name, options));
    },
    async refs() {
      assertOpen(parts);
      return notYet();
    },
    async callers() {
      assertOpen(parts);
      return notYet();
    },
    async symbol(id) {
      return answer(parts, worktree, (snap) => {
        if (id.repo !== parts.repo) return null;
        const fileId = fileIdAt(snap, id.path);
        if (fileId === null) return null;
        const file = fileRow(snap, fileId);
        const match = fileSymbols(snap, fileId).find(
          (symbol) =>
            symbol.kind === id.kind &&
            (symbol.qualifiedName ?? symbol.name) === id.qualifiedName &&
            symbol.discriminator === id.discriminator,
        );
        return match === undefined ? null : symbolRecord(snap, id.path, file, match);
      });
    },
    async fileFacts(path) {
      return answer(parts, worktree, (snap) => {
        const fileId = fileIdAt(snap, path);
        return fileId === null ? null : rebuildFacts(snap, path, fileId);
      });
    },
  };
}
