import type {
  Answer,
  CitationSite,
  EmitLookup,
  ExportSite,
  FileFacts,
  ImportSite,
  LocalSymbol,
  RefKind,
  RefSite,
} from '../facts/index.ts';
import {
  clampDepth,
  collectCallEdges,
  emitLookupFor,
  importerRecord,
  mergeCaller,
  mergeRefs,
  readResolving,
  refRecord,
  resolveSites,
  scopedRefs,
  selectCallers,
  siteKeyOf,
  siteProvenance,
  standingEdge,
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
  overlayView,
  readSnapshot,
  spanOf,
  str,
  symbolRecord,
  toAnswer,
} from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import type { StoreParts } from './parts.ts';
import type { ImporterRecord, Reader, WorktreeId } from './types.ts';

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

  // ADR citations (plan 03-24): only the number, the short detail and the span are stored, so only they come back.
  const citations: CitationSite[] = snap.db
    .prepare(
      `SELECT number, detail, start_line, start_col, end_line, end_col, enclosing
       FROM citations WHERE file_id = ? ORDER BY ord`,
    )
    .all(fileId)
    .map((row) => ({
      number: num(row.number),
      span: spanOf(row),
      ...(row.detail === null ? {} : { detail: str(row.detail) }),
      ...(row.enclosing === null ? {} : { enclosing: num(row.enclosing) }),
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
    ...(citations.length === 0 ? {} : { citations }),
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
    async refs(id, options) {
      // Phase 1 (one read transaction, after the project context of that snapshot): the grammar result and what
      // the cache holds.
      // A store with no provider reads synchronously here, so the resolver is reached before this call yields.
      const started = readResolving(
        parts,
        worktree,
        (snap) => scopedRefs(snap, id).map((hit) => refRecord(snap, id, hit)),
        (records) => records.map((record) => record.site),
      );
      const first = started instanceof Promise ? await started : started;
      // Phase 2 (async): the resolver, bounded by the timeout. Phase 3: merge precise edges over the grammar ones.
      const resolved = await resolveSites(parts, worktree, first.value.input, options);
      return toAnswer(first, mergeRefs(first.value.grammar, id, resolved.edges), resolved.degraded);
    },
    async callers(id, options) {
      const hops = clampDepth(options?.hops);
      const started = readResolving(
        parts,
        worktree,
        (snap) => {
          const edges = collectCallEdges(snap, id, hops);
          const provenance = new Map(edges.map((edge) => [edge, siteProvenance(snap, edge.hit)] as const));
          return { edges, provenance };
        },
        ({ edges }) => edges.map((edge) => siteKeyOf(edge.hit)),
      );
      const first = started instanceof Promise ? await started : started;
      const { grammar: walk, input } = first.value;
      const { edges, provenance } = walk;
      const resolved = await resolveSites(parts, worktree, input, options);
      const walked = selectCallers(id, edges, hops, (edge) => standingEdge(resolved.edges, edge));
      const data = walked.map(({ edge, hops: at }) => {
        const known = provenance.get(edge);
        if (known === undefined) throw new Error('a walked call edge has no provenance');
        return mergeCaller(resolved.edges, edge, known, at);
      });
      return toAnswer(first, data, resolved.degraded);
    },
    async symbol(id) {
      return answer(parts, worktree, (snap) => {
        const found = findSymbol(snap, id);
        return found === null ? null : symbolRecord(snap, id.path, found.file, found.symbol);
      });
    },
    async importers(target, options) {
      const read = (emit: EmitLookup | undefined): Answer<readonly ImporterRecord[]> =>
        answer(
          parts,
          worktree,
          (snap) =>
            walkImporters(snap, target, clampDepth(options?.depth))
              .slice(0, limitOf(options?.limit))
              .map((edge) => importerRecord(snap, edge)),
          emit,
        );
      // A build output that a project's config says a source compiles to names that source (TSM-03). A store with no
      // provider reads at once, as in Phase 2.
      const emit = emitLookupFor(parts, worktree);
      return read(emit instanceof Promise ? await emit : emit);
    },
    async fileFacts(path) {
      return answer(parts, worktree, (snap) => {
        const fileId = fileIdAt(snap, path);
        return fileId === null ? null : rebuildFacts(snap, path, fileId);
      });
    },
    async emittedAs(path) {
      const pending = emitLookupFor(parts, worktree);
      const emit = pending instanceof Promise ? await pending : pending;
      return answer(parts, worktree, (snap): readonly string[] =>
        emit !== undefined && overlayView(snap).paths.has(path) ? emit.sourceToOutputs(path) : [],
      );
    },
  };
}
