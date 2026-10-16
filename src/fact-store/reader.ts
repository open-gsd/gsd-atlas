import { posix } from 'node:path';
import type {
  ExportSite,
  FileFacts,
  ImportSite,
  ImportStyle,
  LocalSymbol,
  RefKind,
  RefSite,
} from '../facts/index.ts';
import { callerRecord, refRecord, scopedRefs } from './resolve.ts';
import {
  answer,
  fileIdAt,
  fileRow,
  fileSymbols,
  findRecords,
  findSymbol,
  num,
  spanOf,
  str,
  symbolRecord,
} from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import { extractorOf } from './parts.ts';
import type { StoreParts } from './parts.ts';
import type { ImporterRecord, ImportersOptions, Reader, WorktreeId } from './types.ts';

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
 * calls: every call sees the state committed when it starts.
 */
export function createReader(parts: StoreParts, worktree: WorktreeId): Reader {
  return {
    async find(name, options) {
      return answer(parts, worktree, (snap) => findRecords(snap, name, options));
    },
    async refs(id) {
      return answer(parts, worktree, (snap) => scopedRefs(snap, id).map((hit) => refRecord(snap, id, hit)));
    },
    async callers(id) {
      // One hop only until the multi-hop walk lands: `options.hops` above 1 returns the same set.
      return answer(parts, worktree, (snap) =>
        scopedRefs(snap, id).flatMap((hit) =>
          hit.kind === 'call' && hit.enclosing !== null ? [callerRecord(snap, id, hit, hit.enclosing, 1)] : [],
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
