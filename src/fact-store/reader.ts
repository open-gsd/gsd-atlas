import type { ExportSite, FileFacts, ImportSite, LocalSymbol, RefKind, RefSite } from '../facts/index.ts';
import {
  callerRecord,
  clampDepth,
  collectCallEdges,
  importerRecord,
  refRecord,
  scopedRefs,
  selectCallers,
  walkImporters,
} from './resolve.ts';
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
import type { StoreParts } from './parts.ts';
import type { Reader, WorktreeId } from './types.ts';

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

/** `limit` as a whole number of rows, or all of them when absent. */
function limitOf(limit: number | undefined): number {
  return limit === undefined || Number.isNaN(limit) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(limit));
}

/**
 * A read-only view of one worktree overlay on the store's read connection. Readers hold no snapshot across
 * calls: every call sees the state committed when it starts. `refs`, `callers` and `importers` live in
 * resolve.ts; this is the glue.
 */
export function createReader(parts: StoreParts, worktree: WorktreeId): Reader {
  return {
    async find(name, options) {
      return answer(parts, worktree, (snap) => findRecords(snap, name, options));
    },
    async refs(id) {
      return answer(parts, worktree, (snap) => scopedRefs(snap, id).map((hit) => refRecord(snap, id, hit)));
    },
    async callers(id, options) {
      return answer(parts, worktree, (snap) => {
        const hops = clampDepth(options?.hops);
        return selectCallers(id, collectCallEdges(snap, id, hops), hops, () => true).map(({ edge, hops: at }) =>
          callerRecord(snap, edge.callee, edge.hit, edge.caller, at),
        );
      });
    },
    async symbol(id) {
      return answer(parts, worktree, (snap) => {
        const found = findSymbol(snap, id);
        return found === null ? null : symbolRecord(snap, id.path, found.file, found.symbol);
      });
    },
    async importers(target, options) {
      return answer(parts, worktree, (snap) =>
        walkImporters(snap, target, clampDepth(options?.depth))
          .slice(0, limitOf(options?.limit))
          .map((edge) => importerRecord(snap, edge)),
      );
    },
    async fileFacts(path) {
      return answer(parts, worktree, (snap) => {
        const fileId = fileIdAt(snap, path);
        return fileId === null ? null : rebuildFacts(snap, path, fileId);
      });
    },
  };
}
