import { posix } from 'node:path';
import type {
  Answer,
  DegradedCode,
  ExportSite,
  FileFacts,
  ImportSite,
  ImportStyle,
  LocalSymbol,
  RefKind,
  RefSite,
  Span,
  SymbolIdentity,
} from '../facts/index.ts';
import type { Db, Row } from '../sqlite/index.ts';
import { UnknownWorktree } from './errors.ts';
import { assertOpen, extractorOf, readTransaction } from './parts.ts';
import type { StoreParts } from './parts.ts';
import type {
  CallerRecord,
  FindOptions,
  ImporterRecord,
  ImportersOptions,
  Provenance,
  Reader,
  RefRecord,
  SymbolRecord,
  WorktreeId,
} from './types.ts';

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
  return readTransaction(parts, (db) => {
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
  });
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

function find(snap: Snapshot, name: string, options: FindOptions | undefined): readonly SymbolRecord[] {
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
        ? db.prepare(FIND_FUZZY_SQL).all(snap.worktree, name, limit)
        : db.prepare(FIND_EXACT_SQL).all(snap.worktree, name, limit);
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

/** The symbol an identity names in this overlay, with its file; null when the repo, path, kind or name differ. */
function findSymbol(snap: Snapshot, id: SymbolIdentity): { file: FileRow; symbol: FileSymbol } | null {
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

/** One reference site of the overlay, with the identity of the symbol that contains it. */
interface SiteHit {
  readonly path: string;
  readonly fileId: number;
  readonly ord: number;
  readonly name: string;
  readonly kind: RefKind | null;
  readonly span: Span;
  readonly enclosing: SymbolIdentity | null;
}

const SITES_HEAD = `SELECT o.path AS path, r.file_id AS file_id, r.ord AS ord, r.kind AS kind, r.start_line AS start_line,
       r.start_col AS start_col, r.end_line AS end_line, r.end_col AS end_col, r.enclosing AS enclosing
       FROM names n
       JOIN refs r ON r.name_id = n.id
       JOIN overlay_files o ON o.file_id = r.file_id AND o.worktree = ?`;
const SITES_TAIL = 'ORDER BY o.path, r.start_line, r.start_col, r.ord';
const REF_SITES_SQL = `${SITES_HEAD} WHERE n.name = ? ${SITES_TAIL}`;
const CALL_SITES_SQL = `${SITES_HEAD} WHERE n.name = ? AND r.kind = 'call' AND r.enclosing IS NOT NULL ${SITES_TAIL}`;

/**
 * Every reference site in the overlay whose name equals the identity's name, ordered by path then span. This is
 * the simplest correct grammar-tier join: a name match with no scoping by imports and no ambiguity handling
 * (plan 02-11 adds both). The name is the bare name of the symbol the identity names when the overlay has it
 * (so `Box.put` matches sites named `put`), and the identity's qualified name otherwise.
 */
function refSites(snap: Snapshot, id: SymbolIdentity, callsOnly: boolean): readonly SiteHit[] {
  const name = findSymbol(snap, id)?.symbol.name ?? id.qualifiedName;
  if (name === '') return [];
  const rows = snap.db.prepare(callsOnly ? CALL_SITES_SQL : REF_SITES_SQL).all(snap.worktree, name);
  return rows.map((row) => {
    const fileId = num(row.file_id);
    const symbols = fileSymbols(snap, fileId);
    const container = row.enclosing === null ? undefined : symbols[num(row.enclosing)];
    const path = str(row.path);
    return {
      path,
      fileId,
      ord: num(row.ord),
      name,
      kind: row.kind === null ? null : (str(row.kind) as RefKind),
      span: spanOf(row),
      enclosing: container === undefined ? null : identityOf(snap, path, container),
    };
  });
}

/** Provenance of a grammar-tier edge: it names the site, never the definition, and is always `INFERRED`. */
function siteProvenance(snap: Snapshot, hit: SiteHit): Provenance {
  const file = fileRow(snap, hit.fileId);
  return {
    source_path: hit.path,
    span: hit.span,
    extractor: extractorOf(file.module, file.grammarVersion),
    content_hash: file.hash,
    first_seen: file.firstSeen,
    last_seen: file.lastSeen,
    confidence: 'INFERRED',
    debug: `ref/${encodeURIComponent(hit.path)}/${file.hash}/${hit.ord}`,
  };
}

function refRecord(snap: Snapshot, target: SymbolIdentity, hit: SiteHit): RefRecord {
  const record: RefRecord = {
    ...siteProvenance(snap, hit),
    site: { path: hit.path, span: hit.span, name: hit.name },
    target,
    tier: 'grammar',
    enclosing: hit.enclosing,
  };
  return hit.kind === null ? record : { ...record, kind: hit.kind };
}

function callerRecord(snap: Snapshot, callee: SymbolIdentity, hit: SiteHit, caller: SymbolIdentity): CallerRecord {
  return { ...siteProvenance(snap, hit), caller, callee, hops: 1, tier: 'grammar' };
}

/** A specifier is relative when it names a file next to or above the importing file. */
function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** A path with its last extension removed: `src/a.ts` and `src/a.js` both become `src/a`. */
function withoutExtension(filePath: string): string {
  const ext = posix.extname(filePath);
  return ext === '' ? filePath : filePath.slice(0, filePath.length - ext.length);
}

const IMPORTS_SQL = `SELECT o.path AS importer, i.file_id AS file_id, i.ord AS ord, i.path AS specifier, i.style AS style,
       i.start_line AS start_line, i.start_col AS start_col, i.end_line AS end_line, i.end_col AS end_col
       FROM overlay_files o
       JOIN imports i ON i.file_id = o.file_id
       WHERE o.worktree = ?
       ORDER BY o.path, i.start_line, i.start_col, i.ord`;

/**
 * Direct importers of `target`: every import in the overlay whose relative specifier, resolved against the
 * importing file's directory, equals the target path once the extension is removed on both sides. The match
 * runs in JavaScript over the overlay's imports (the overlay fits in memory), so no SQL string function is
 * involved. `INFERRED`: the statement is a cited fact, the link to a file is a path match.
 */
function importers(snap: Snapshot, target: string, options: ImportersOptions | undefined): readonly ImporterRecord[] {
  const wanted = withoutExtension(posix.normalize(target));
  const limit = options?.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.limit));
  const out: ImporterRecord[] = [];
  for (const row of snap.db.prepare(IMPORTS_SQL).all(snap.worktree)) {
    if (out.length >= limit) break;
    const specifier = str(row.specifier);
    if (!isRelative(specifier)) continue;
    const importer = str(row.importer);
    if (withoutExtension(posix.normalize(posix.join(posix.dirname(importer), specifier))) !== wanted) continue;
    const fileId = num(row.file_id);
    const file = fileRow(snap, fileId);
    const record: ImporterRecord = {
      source_path: importer,
      span: spanOf(row),
      extractor: extractorOf(file.module, file.grammarVersion),
      content_hash: file.hash,
      first_seen: file.firstSeen,
      last_seen: file.lastSeen,
      confidence: 'INFERRED',
      debug: `imp/${encodeURIComponent(importer)}/${file.hash}/${num(row.ord)}`,
      importer,
      specifier,
      hops: 1,
    };
    out.push(row.style === null ? record : { ...record, style: str(row.style) as ImportStyle });
  }
  return out;
}

/**
 * A read-only view of one worktree overlay on the store's read connection. Readers hold no snapshot across
 * calls: every call sees the state committed when it starts. `refs`, `callers` and `importers` are the
 * simplest correct grammar-tier joins; plan 02-11 deepens them without changing these signatures.
 */
export function createReader(parts: StoreParts, worktree: WorktreeId): Reader {
  return {
    async find(name, options) {
      return answer(parts, worktree, (snap) => find(snap, name, options));
    },
    async refs(id) {
      return answer(parts, worktree, (snap) => refSites(snap, id, false).map((hit) => refRecord(snap, id, hit)));
    },
    async callers(id) {
      // One hop only in this plan: `options.hops` above 1 returns the same set (plan 02-11 walks deeper).
      return answer(parts, worktree, (snap) =>
        refSites(snap, id, true).flatMap((hit) =>
          hit.enclosing === null ? [] : [callerRecord(snap, id, hit, hit.enclosing)],
        ),
      );
    },
    async symbol(id) {
      return answer(parts, worktree, (snap) => {
        const found = findSymbol(snap, id);
        return found === null ? null : symbolRecord(snap, id.path, found.file, found.symbol);
      });
    },
    async importers(target, options) {
      return answer(parts, worktree, (snap) => importers(snap, target, options));
    },
    async fileFacts(path) {
      return answer(parts, worktree, (snap) => {
        const fileId = fileIdAt(snap, path);
        return fileId === null ? null : rebuildFacts(snap, path, fileId);
      });
    },
  };
}
