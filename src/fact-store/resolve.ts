/**
 * Grammar-tier resolution (D-06, LNG-03). Pure functions over one `Snapshot`: they scope reference sites by
 * file, import and export, report ambiguity as a candidate count, and never guess. Every edge they produce is
 * `INFERRED`; only a precise edge from the injected Resolver may be `EXTRACTED` (applied in the same module
 * once the resolver integration lands). Internal; not exported from index.ts.
 */
import { posix } from 'node:path';
import { symbolKey } from '../facts/index.ts';
import type { RefKind, Span, SymbolIdentity } from '../facts/index.ts';
import { extractorOf } from './parts.ts';
import { stem } from './specifier.ts';
import {
  exportsOf,
  fileRow,
  fileSymbols,
  findSymbol,
  identityOf,
  importRows,
  importsOf,
  num,
  overlayView,
  resolveImport,
  spanOf,
  str,
} from './snapshot.ts';
import type { FileSymbol, ImportRow, Snapshot } from './snapshot.ts';
import type { CallerRecord, ImporterRecord, Provenance, RefRecord } from './types.ts';

/** One reference site of the overlay, with the identity of the symbol that contains it. */
export interface SiteHit {
  readonly path: string;
  readonly fileId: number;
  readonly ord: number;
  /** The name written at the site: the local alias for an aliased import, not the definition's name. */
  readonly name: string;
  readonly kind: RefKind | null;
  readonly span: Span;
  readonly enclosing: SymbolIdentity | null;
  /** How many definitions the site could point at (1 when unambiguous). */
  readonly candidates: number;
}

/** A definition inside the overlay: its path (not just its file, since identical bytes can sit at two paths). */
interface Def {
  readonly path: string;
  readonly fileId: number;
  readonly symbol: FileSymbol;
}

const defKey = (def: Def): string => `${def.path}\u0000${def.symbol.ord}`;

const SITES_BY_NAME_SQL = `SELECT o.path AS path, r.file_id AS file_id, r.ord AS ord, r.kind AS kind, r.start_line AS start_line,
       r.start_col AS start_col, r.end_line AS end_line, r.end_col AS end_col, r.enclosing AS enclosing
       FROM names n
       JOIN refs r ON r.name_id = n.id
       JOIN overlay_files o ON o.file_id = r.file_id AND o.worktree = ?
       WHERE n.name = ?
       ORDER BY o.path, r.start_line, r.start_col, r.ord`;

/** Definitions of `name` in the file at `path`; `topLevelOnly` keeps symbols that have no parent. */
function definitionsNamed(snap: Snapshot, path: string, name: string, topLevelOnly: boolean): Def[] {
  const fileId = overlayView(snap).fileIds.get(path);
  if (fileId === undefined || fileId === null) return [];
  return fileSymbols(snap, fileId)
    .filter((symbol) => symbol.name === name && (!topLevelOnly || symbol.parent === null))
    .map((symbol) => ({ path, fileId, symbol }));
}

/**
 * The definitions the file at `path` exposes under the export name `exportName`. An export entry maps the name
 * to its local symbol (a plain entry maps to the symbol of the same name); a re-export (`from`) is not followed.
 * With no entry at all, a top-level definition of that name that is not marked private is taken, because a
 * Phase 1 shaped file carries no export entries. A default import of a module with no default export maps to
 * nothing.
 */
function exportDefs(snap: Snapshot, path: string, exportName: string): Def[] {
  const fileId = overlayView(snap).fileIds.get(path);
  if (fileId === undefined || fileId === null) return [];
  const entries = exportsOf(snap, fileId).filter((entry) => entry.name === exportName);
  if (entries.length > 0) {
    const out: Def[] = [];
    for (const entry of entries) {
      if (entry.from !== null) continue;
      out.push(...definitionsNamed(snap, path, entry.local ?? entry.name, true));
    }
    return out;
  }
  if (exportName === 'default') return [];
  return definitionsNamed(snap, path, exportName, true).filter((def) => def.symbol.exported !== false);
}

/**
 * Every definition a site could point at, by the three scope rules: a definition of the same name in the
 * site's own file; the local symbol behind an export alias of its own file (`export { parse as run }` and a
 * site `run`); and, through the file's relative imports, the definition a binding resolves to in every file
 * the specifier can name. A named binding matches non-member sites of its local name; a namespace binding
 * matches member sites of the exported name. A site that reaches nothing returns an empty map.
 */
function targetsOf(snap: Snapshot, path: string, fileId: number, name: string, kind: RefKind | null): Map<string, Def> {
  const targets = new Map<string, Def>();
  const add = (def: Def): void => {
    targets.set(defKey(def), def);
  };
  for (const symbol of fileSymbols(snap, fileId)) if (symbol.name === name) add({ path, fileId, symbol });
  for (const entry of exportsOf(snap, fileId)) {
    if (entry.name !== name || entry.local === null || entry.local === entry.name || entry.from !== null) continue;
    for (const def of definitionsNamed(snap, path, entry.local, true)) add(def);
  }
  for (const imp of importsOf(snap, path)) {
    for (const binding of imp.bindings) {
      if (binding.imported === '*') {
        if (kind !== 'member') continue;
        for (const candidate of resolveImport(snap, path, imp.specifier)) {
          for (const def of exportDefs(snap, candidate, name)) add(def);
        }
      } else if (binding.local === name && kind !== 'member') {
        for (const candidate of resolveImport(snap, path, imp.specifier)) {
          for (const def of exportDefs(snap, candidate, binding.imported)) add(def);
        }
      }
    }
  }
  return targets;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareSites(a: SiteHit, b: SiteHit): number {
  return (
    compareCodeUnits(a.path, b.path) ||
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    a.ord - b.ord
  );
}

/**
 * The name-matched reference sites that are in scope for `target`, ordered by path then span (D-06). A site is
 * in scope when it sits in the defining file, when its name is an import binding that resolves (through the
 * specifier rule) to the target's file and exported name, or when it uses an export name of the defining file.
 * When a site could point at more than one definition, every candidate receives it and `candidates` is the
 * number of alternatives; nothing is guessed. An identity the overlay does not hold has no sites.
 */
export function scopedRefs(snap: Snapshot, target: SymbolIdentity): readonly SiteHit[] {
  const found = findSymbol(snap, target);
  if (found === null) return [];
  const { file, symbol } = found;
  const targetKey = defKey({ path: target.path, fileId: file.id, symbol });

  // The names a site of this definition can carry: its own, its export aliases, and the local names of the
  // bindings that import it. This is a superset; targetsOf makes the final decision per site.
  const names = new Set<string>([symbol.name]);
  for (const entry of exportsOf(snap, file.id)) {
    if (entry.local === symbol.name && entry.name !== symbol.name && entry.from === null) names.add(entry.name);
  }
  for (const imp of importRows(snap)) {
    if (!resolveImport(snap, imp.importer, imp.specifier).includes(target.path)) continue;
    for (const binding of imp.bindings) {
      if (binding.imported === '*') continue;
      if (exportDefs(snap, target.path, binding.imported).some((def) => defKey(def) === targetKey)) {
        names.add(binding.local);
      }
    }
  }

  const hits: SiteHit[] = [];
  const statement = snap.db.prepare(SITES_BY_NAME_SQL);
  for (const name of names) {
    for (const row of statement.all(snap.worktree, name)) {
      const fileId = num(row.file_id);
      const path = str(row.path);
      const kind = row.kind === null ? null : (str(row.kind) as RefKind);
      const targets = targetsOf(snap, path, fileId, name, kind);
      if (!targets.has(targetKey)) continue;
      const container = row.enclosing === null ? undefined : fileSymbols(snap, fileId)[num(row.enclosing)];
      hits.push({
        path,
        fileId,
        ord: num(row.ord),
        name,
        kind,
        span: spanOf(row),
        enclosing: container === undefined ? null : identityOf(snap, path, container),
        candidates: targets.size,
      });
    }
  }
  return hits.sort(compareSites);
}

/** The deepest a walk goes, whatever the caller asks for (T-02-34); the visited sets bound the rest. */
export const MAX_WALK_DEPTH = 5;

/** A requested hop count or depth as a whole number from 1 to `MAX_WALK_DEPTH`; absent or not a number is 1. */
export function clampDepth(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return 1;
  return Math.min(MAX_WALK_DEPTH, Math.max(1, Math.floor(requested)));
}

/** One call edge of the walk: a call site, the symbol it calls and the symbol that contains it. */
export interface CallEdge {
  readonly callee: SymbolIdentity;
  readonly calleeKey: string;
  readonly caller: SymbolIdentity;
  readonly callerKey: string;
  readonly hit: SiteHit;
}

/**
 * Every call edge within `hops` calls of `start`, grammar tier: a breadth-first expansion over the scoped
 * references of kind `call` of each frontier symbol. Each symbol is expanded once (the visited set), so a cycle
 * terminates. The result can be a superset of what is finally reported: a precise edge may later remove a
 * site, and `selectCallers` then walks only the edges that remain.
 */
export function collectCallEdges(snap: Snapshot, start: SymbolIdentity, hops: number): readonly CallEdge[] {
  const edges: CallEdge[] = [];
  const expanded = new Set<string>();
  let frontier: SymbolIdentity[] = [start];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
    const next = new Map<string, SymbolIdentity>();
    for (const callee of frontier) {
      const calleeKey = symbolKey(callee);
      if (expanded.has(calleeKey)) continue;
      expanded.add(calleeKey);
      for (const hit of scopedRefs(snap, callee)) {
        if (hit.kind !== 'call' || hit.enclosing === null) continue;
        const callerKey = symbolKey(hit.enclosing);
        edges.push({ callee, calleeKey, caller: hit.enclosing, callerKey, hit });
        next.set(callerKey, hit.enclosing);
      }
    }
    frontier = [...next.values()];
  }
  return edges;
}

/**
 * The callers to report: a breadth-first walk from `start` over the edges `keep` accepts, each edge at the hop
 * where its callee was first reached. A caller is reported at the hop it is first found, once; a caller found
 * again at a later hop (a cycle, a diamond) is skipped, but several call sites of one caller at the same hop
 * are all kept. The start symbol itself is reported only at hop 1, where a self call is a real caller. Ordered
 * by hop, then caller path, then span.
 */
export function selectCallers(
  start: SymbolIdentity,
  edges: readonly CallEdge[],
  hops: number,
  keep: (edge: CallEdge) => boolean,
): ReadonlyArray<{ readonly edge: CallEdge; readonly hops: number }> {
  const byCallee = new Map<string, CallEdge[]>();
  for (const edge of edges) {
    if (!keep(edge)) continue;
    const list = byCallee.get(edge.calleeKey) ?? [];
    list.push(edge);
    byCallee.set(edge.calleeKey, list);
  }
  const startKey = symbolKey(start);
  const seen = new Set<string>();
  const out: Array<{ edge: CallEdge; hops: number }> = [];
  let frontier = [startKey];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
    const found = new Set<string>();
    const records: Array<{ edge: CallEdge; hops: number }> = [];
    for (const calleeKey of frontier) {
      for (const edge of byCallee.get(calleeKey) ?? []) {
        if (seen.has(edge.callerKey)) continue;
        records.push({ edge, hops: hop });
        found.add(edge.callerKey);
      }
    }
    records.sort((a, b) => compareSites(a.edge.hit, b.edge.hit));
    out.push(...records);
    if (hop === 1) seen.add(startKey);
    for (const key of found) seen.add(key);
    frontier = [...found];
  }
  return out;
}

/** One import statement that reaches a target, with how many overlay paths its specifier named. */
export interface ImportEdge {
  readonly row: ImportRow;
  /** How many overlay paths the specifier matched: 1 is exact, more is ambiguous. */
  readonly matched: number;
  readonly hops: number;
}

/**
 * The import statements that reach `target` within `depth` import steps, ordered by hop, then importer path,
 * then position. A statement reaches a file when its specifier (through the specifier rule) names it; a
 * statement that names several files reaches each of them. The target is an overlay path, or a path without
 * its extension that names overlay paths; a target the overlay does not hold has no importers. Each importing
 * file is reported at the hop it is first found, once per statement; the walk keeps a visited set, so an import
 * cycle terminates. The start file is reported only at hop 1.
 */
export function walkImporters(snap: Snapshot, target: string, depth: number): readonly ImportEdge[] {
  const view = overlayView(snap);
  const wanted = posix.normalize(target);
  const start = view.paths.has(wanted) ? [wanted] : [...view.paths].filter((overlayPath) => stem(overlayPath) === wanted);
  if (start.length === 0) return [];
  const rows = importRows(snap);
  const seen = new Set<string>();
  const out: ImportEdge[] = [];
  let frontier = new Set(start);
  for (let hop = 1; hop <= depth && frontier.size > 0; hop += 1) {
    const found = new Set<string>();
    const edges: ImportEdge[] = [];
    for (const row of rows) {
      if (seen.has(row.importer)) continue;
      const named = resolveImport(snap, row.importer, row.specifier);
      if (!named.some((candidate) => frontier.has(candidate))) continue;
      edges.push({ row, matched: named.length, hops: hop });
      found.add(row.importer);
    }
    edges.sort(
      (a, b) =>
        compareCodeUnits(a.row.importer, b.row.importer) ||
        a.row.span.startLine - b.row.span.startLine ||
        a.row.span.startColumn - b.row.span.startColumn ||
        a.row.ord - b.row.ord,
    );
    out.push(...edges);
    if (hop === 1) for (const path of start) seen.add(path);
    for (const path of found) seen.add(path);
    frontier = found;
  }
  return out;
}

/** An `ImporterRecord` for one import statement: `EXTRACTED` when the specifier named exactly one path. */
export function importerRecord(snap: Snapshot, edge: ImportEdge): ImporterRecord {
  const { row } = edge;
  const file = fileRow(snap, row.fileId);
  const record: ImporterRecord = {
    source_path: row.importer,
    span: row.span,
    extractor: extractorOf(file.module, file.grammarVersion),
    content_hash: file.hash,
    first_seen: file.firstSeen,
    last_seen: file.lastSeen,
    confidence: edge.matched === 1 ? 'EXTRACTED' : 'INFERRED',
    debug: `imp/${encodeURIComponent(row.importer)}/${file.hash}/${row.ord}`,
    importer: row.importer,
    specifier: row.specifier,
    hops: edge.hops,
  };
  return row.style === null ? record : { ...record, style: row.style };
}

/** Provenance of a grammar-tier edge: it names the site, never the definition, and is always `INFERRED`. */
export function siteProvenance(snap: Snapshot, hit: SiteHit): Provenance {
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

export function refRecord(snap: Snapshot, target: SymbolIdentity, hit: SiteHit): RefRecord {
  const record: RefRecord = {
    ...siteProvenance(snap, hit),
    site: { path: hit.path, span: hit.span, name: hit.name },
    target,
    tier: 'grammar',
    enclosing: hit.enclosing,
    ...(hit.candidates > 1 ? { candidates: hit.candidates } : {}),
  };
  return hit.kind === null ? record : { ...record, kind: hit.kind };
}

export function callerRecord(
  snap: Snapshot,
  callee: SymbolIdentity,
  hit: SiteHit,
  caller: SymbolIdentity,
  hops: number,
): CallerRecord {
  return { ...siteProvenance(snap, hit), caller, callee, hops, tier: 'grammar' };
}
