/**
 * Grammar-tier resolution (D-06, LNG-03). Pure functions over one `Snapshot`: they scope reference sites by
 * file, import and export, report ambiguity as a candidate count, and never guess. Every edge they produce is
 * `INFERRED`; only a precise edge from the injected Resolver may be `EXTRACTED` (applied in the same module
 * once the resolver integration lands). Internal; not exported from index.ts.
 */
import { posix } from 'node:path';
import { DEFAULT_PROJECT_CONTEXT, RELATION_KINDS, degradedCodeOf, isRelationKind, isResolverNotice, symbolKey } from '../facts/index.ts';
import type {
  Answer,
  Clock,
  DegradedCode,
  EmitLookup,
  OverlaySnapshot,
  ProjectContext,
  RefKind,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  ResolvedRelation,
  ResolveScope,
  Span,
  SymbolIdentity,
  SymbolLookup,
} from '../facts/index.ts';
import { DbError } from '../sqlite/index.ts';
import type { Db } from '../sqlite/index.ts';
import {
  contextKey,
  ensureContextId,
  findContextId,
  liveSnapshotIds,
  overlaySnapshotId,
  pruneEdges,
  readAsked,
  readEdges,
  readRelationsAsked,
  readRelationsFrom,
  readRelationsTo,
  siteId,
  writeAsked,
  writeEdges,
  writeRelations,
  writeRelationsAsked,
} from './cache.ts';
import type { CachedEdge, CachedRelation } from './cache.ts';
import { StoreClosed, UnknownWorktree } from './errors.ts';
import { extractorOf } from './parts.ts';
import type { StoreParts } from './parts.ts';
import { stem } from './specifier.ts';
import {
  exportsOf,
  fileRow,
  fileSymbols,
  findRecords,
  findSymbol,
  identityOf,
  importRows,
  importsOf,
  num,
  overlayView,
  readSnapshot,
  resolveImport,
  spanOf,
  str,
  symbolsIn,
  toAnswer,
} from './snapshot.ts';
import type { FileSymbol, ImportRow, Snapshot, SnapshotRead } from './snapshot.ts';
import type {
  CallerRecord,
  ImporterRecord,
  Provenance,
  RefRecord,
  RelationDirection,
  RelationRecord,
  RelationsOptions,
  ResolveBatchOptions,
  ResolveOptions,
  ResolveResult,
  WorktreeId,
} from './types.ts';

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
  provenance: Provenance,
  callee: SymbolIdentity,
  caller: SymbolIdentity,
  hops: number,
): CallerRecord {
  return { ...provenance, caller, callee, hops, tier: 'grammar' };
}

// ---------------------------------------------------------------------------------------------------------
// The injected Resolver and the resolved-edge cache (STO-04, D-16, D-17).
//
// A read runs in three phases. Phase 1 is synchronous inside one read transaction: it computes the grammar
// result, the sites a resolver should be asked about, the overlay snapshot id and what the cache already holds.
// Phase 2 is asynchronous and outside any transaction: it asks the resolver for the sites the cache could not
// answer, bounded by the caller's timeout, and validates and stores what comes back. Phase 3 merges the precise
// edges over the grammar result. A resolver never makes a read throw: it can only add `resolver_timeout`,
// `resolver_failed` or `cache_unavailable` to the answer.
// ---------------------------------------------------------------------------------------------------------

/** What phase 1 learned about the cache for the sites a read needs resolved. */
export interface ResolveInput {
  /** Hash of the overlay's sorted (path, content hash) pairs: the cache key of its contents. */
  readonly snapshotId: string;
  /** The project context computed for this snapshot; its `context` keys the cache. */
  readonly project: ProjectContext;
  readonly context: ResolutionContext;
  /** The stored form of `context`. */
  readonly contextKey: string;
  /** The overlay snapshot the sites were read from: its id and its path to content hash map. */
  readonly overlay: OverlaySnapshot;
  /** The distinct sites to resolve, in request order. */
  readonly sites: readonly RefSiteKey[];
  /** Valid cached edges by `siteId`; a site is answered when it has at least one. */
  readonly cached: ReadonlyMap<string, readonly CachedEdge[]>;
  /** The `siteId`s that were asked of the resolver before under this snapshot and context (the negative marker). */
  readonly asked: ReadonlySet<string>;
  /**
   * True when no project context could be had for this snapshot (the provider failed or lost the race against a
   * commit twice). The resolver is not asked and nothing is cached: the answer is the grammar one.
   */
  readonly unavailable?: true;
}

export function siteKeyOf(hit: SiteHit): RefSiteKey {
  return { path: hit.path, span: hit.span, name: hit.name };
}

/** The id of the overlay's contents, memoised per worktree for the watermark seq it was computed at. */
function snapshotIdOf(snap: Snapshot): string {
  const known = snap.parts.snapshotIds.get(snap.worktree);
  if (known !== undefined && known.seq === snap.seq) return known.id;
  const id = overlaySnapshotId(overlayView(snap).hashes);
  snap.parts.snapshotIds.set(snap.worktree, { seq: snap.seq, id });
  return id;
}

/**
 * Phase 1: the snapshot id, the project context and the cached answers for `sites`. A cached edge whose target
 * the overlay does not hold is dropped (T-02-35), so a damaged row can never remove a real site. With no
 * `project` (null: none could be had for this snapshot) nothing is read from the cache and the input is marked
 * `unavailable`, so the cache is never consulted under a context that does not belong to the snapshot.
 */
export function prepareResolution(snap: Snapshot, sites: readonly RefSiteKey[], project: ProjectContext | null): ResolveInput {
  const distinct = new Map<string, RefSiteKey>();
  for (const site of sites) distinct.set(siteId(site), site);
  const snapshotId = snapshotIdOf(snap);
  const overlay: OverlaySnapshot = { id: snapshotId, pathToHash: overlayView(snap).hashes };
  const cached = new Map<string, readonly CachedEdge[]>();
  if (project === null) {
    const context = DEFAULT_PROJECT_CONTEXT.context;
    return {
      snapshotId,
      project: DEFAULT_PROJECT_CONTEXT,
      context,
      contextKey: contextKey(context),
      overlay,
      sites: [...distinct.values()],
      cached,
      asked: new Set(),
      unavailable: true,
    };
  }
  const { context } = project;
  const key = contextKey(context);
  const contextId = distinct.size === 0 ? undefined : findContextId(snap.db, key);
  let asked: ReadonlySet<string> = new Set();
  if (contextId !== undefined) {
    for (const [id, edges] of readEdges(snap.db, snapshotId, contextId, [...distinct.values()], snap.parts.repo)) {
      const valid = edges.filter((edge) => findSymbol(snap, edge.target) !== null);
      if (valid.length > 0) cached.set(id, valid);
    }
    const unanswered = [...distinct].filter(([id]) => !cached.has(id)).map(([, site]) => site);
    asked = readAsked(snap.db, snapshotId, contextId, unanswered);
  }
  return { snapshotId, project, context, contextKey: key, overlay, sites: [...distinct.values()], cached, asked };
}

/**
 * Phase 1 for a read that may resolve: the grammar result (`grammar`, run inside the read transaction) and the
 * `ResolveInput` for the sites it names (`sitesOf`), with the project context of the snapshot the read used.
 *
 * The context is asynchronous, so it is computed before the read transaction, for the overlay snapshot a quick
 * read sees. The read then checks that the snapshot did not move; if it did, the context is recomputed once for
 * the snapshot the second read sees. A second loss, and a provider that fails, give an `unavailable` input: the
 * answer is the grammar one with `resolver_failed`, and no edge is ever cached under a context computed for
 * another snapshot (T-03-202). A provider never makes a read throw.
 */
export function readResolving<T>(
  parts: StoreParts,
  worktree: WorktreeId,
  grammar: (snap: Snapshot, project: ProjectContext | null) => T,
  sitesOf: (value: T) => readonly RefSiteKey[],
): ResolvingRead<T> | Promise<ResolvingRead<T>> {
  const attempt = (n: number): ResolvingRead<T> | Promise<ResolvingRead<T>> => {
    const seen = readSnapshot(parts, worktree, (snap) => ({
      id: snapshotIdOf(snap),
      pathToHash: overlayView(snap).hashes,
    })).value;
    const finish = (project: ProjectContext | null): ResolvingRead<T> | Promise<ResolvingRead<T>> => {
      const read = readSnapshot(
        parts,
        worktree,
        (snap) => {
          const moved = project !== null && snapshotIdOf(snap) !== seen.id;
          // The project context the read may use: null when none could be had or when it belongs to another snapshot.
          const usable = moved ? null : project;
          const value = grammar(snap, usable);
          return { grammar: value, input: prepareResolution(snap, sitesOf(value), usable), moved };
        },
        // The specifier rule asks the project's emit lookup (TSM-03); a snapshot that moved is read again.
        project?.emit,
      );
      return read.value.moved && n < 2 ? attempt(n + 1) : read;
    };
    const project = askProject(parts, worktree, seen);
    return project instanceof Promise ? project.then(finish) : finish(project);
  };
  return attempt(1);
}

/**
 * The emit lookup of the project context of the snapshot a read is about to see (TSM-03), for the reads that need it
 * but do not resolve (`importers`, `emittedAs`). A store with no provider answers undefined at once, without a read,
 * so its reads stay as they were in Phase 2. A provider that fails gives undefined: the plain specifier rule applies.
 */
export function emitLookupFor(parts: StoreParts, worktree: WorktreeId): EmitLookup | undefined | Promise<EmitLookup | undefined> {
  if (!parts.projectContext.provided) return undefined;
  const seen = readSnapshot(parts, worktree, (snap) => ({ id: snapshotIdOf(snap), pathToHash: overlayView(snap).hashes })).value;
  const project = askProject(parts, worktree, seen);
  return project instanceof Promise ? project.then((got) => got?.emit) : project?.emit;
}

/** What `readResolving` returns: the grammar result and the resolve input, read in one transaction. */
export type ResolvingRead<T> = SnapshotRead<{ readonly grammar: T; readonly input: ResolveInput }>;

/** The project context of a snapshot, or null when the source throws or rejects. Synchronous when the source is. */
function askProject(
  parts: StoreParts,
  worktree: WorktreeId,
  overlay: OverlaySnapshot,
): ProjectContext | null | Promise<ProjectContext | null> {
  try {
    const got = parts.projectContext({ worktree, overlay });
    return got instanceof Promise ? got.catch(() => null) : got;
  } catch {
    return null; // the source failed: answer from grammar facts
  }
}

/** The outcome of phase 2. */
export interface ResolvedSites {
  /** Edges by `siteId`: the cached ones plus the ones the resolver just answered. */
  readonly edges: ReadonlyMap<string, readonly CachedEdge[]>;
  readonly degraded: readonly DegradedCode[];
}

/** What one drained resolver call produced: its edges, and the codes its notices asked the answer to carry. */
interface Collected {
  readonly edges: ResolvedEdge[];
  readonly notices: ReadonlySet<DegradedCode>;
}

type Settled<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly code: DegradedCode };

/** The read-only lookup of the grammar tier's symbols a resolver is given (it never reads the store itself). */
function symbolLookupOf(parts: StoreParts, worktree: WorktreeId): SymbolLookup {
  return {
    // Read back through the read-only connection, one short transaction per call (never held across an await).
    find: async (name) =>
      readSnapshot(parts, worktree, (snap) => findRecords(snap, name, { mode: 'exact' }).map((record) => record.identity)).value,
    findIn: async (path, name) => readSnapshot(parts, worktree, (snap) => symbolsIn(snap, path, name)).value,
  };
}

/**
 * Drain the resolver for `sites`, telling it where it resolves (`scope`) and giving it a read-only lookup of the
 * grammar tier's symbols. Edges and notices (a condition the answer should say without failing, plan 03-23) arrive in
 * one stream and are separated here. Rejects when it throws, on the call or while iterating.
 */
async function collectEdges(
  parts: StoreParts,
  sites: readonly RefSiteKey[],
  scope: ResolveScope,
): Promise<Collected> {
  const { worktree } = scope;
  const lookup = symbolLookupOf(parts, worktree);
  const edges: ResolvedEdge[] = [];
  const notices = new Set<DegradedCode>();
  for await (const item of parts.deps.resolver(sites, scope.project.context, lookup, scope)) {
    if (isResolverNotice(item)) notices.add(item.degraded);
    else edges.push(item);
  }
  return { edges, notices };
}

/** Race the resolver against the caller's timeout on the injected clock. The resolver keeps running after a timeout. */
function settle<T>(run: Promise<T>, clock: Clock, timeoutMs: number | undefined): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    let cancel = (): void => {};
    const finish = (outcome: Settled<T>): void => {
      if (done) return;
      done = true;
      cancel();
      resolve(outcome);
    };
    if (timeoutMs !== undefined && !Number.isNaN(timeoutMs)) {
      cancel = clock.after(Math.max(0, timeoutMs), () => {
        finish({ kind: 'timeout' });
      });
    }
    run.then(
      (collected) => {
        finish({ kind: 'done', value: collected });
      },
      (error: unknown) => {
        // A typed failure asks for its own code (`memory_budget`); anything else is `resolver_failed`.
        finish({ kind: 'failed', code: degradedCodeOf(error) });
      },
    );
  });
}

function isEdgeShaped(value: unknown): value is ResolvedEdge {
  const edge = value as Partial<ResolvedEdge> | null | undefined;
  return (
    typeof edge === 'object' &&
    edge !== null &&
    typeof edge.site?.path === 'string' &&
    typeof edge.site.name === 'string' &&
    typeof edge.site.span === 'object' &&
    typeof edge.target?.path === 'string' &&
    typeof edge.target.qualifiedName === 'string' &&
    typeof edge.target.kind === 'string' &&
    typeof edge.resolver === 'string'
  );
}

/**
 * Keep the edges that answer a site we asked about and bind it to a definition the overlay holds (T-02-35),
 * and report the overlay's snapshot id as it is now. Null when the overlay or the store is gone.
 */
function validate(
  parts: StoreParts,
  worktree: WorktreeId,
  asked: ReadonlySet<string>,
  fresh: readonly ResolvedEdge[],
): { readonly edges: readonly ResolvedEdge[]; readonly snapshotId: string } | null {
  try {
    return readSnapshot(parts, worktree, (snap) => ({
      edges: fresh.filter(
        (edge) => isEdgeShaped(edge) && asked.has(siteId(edge.site)) && findSymbol(snap, edge.target) !== null,
      ),
      snapshotId: snapshotIdOf(snap),
    })).value;
  } catch (error) {
    if (error instanceof UnknownWorktree || error instanceof StoreClosed) return null;
    throw error;
  }
}

/**
 * Write validated edges, and the asked marker of every site the completed resolver call was asked about, to the
 * cache in one transaction, when this process may (`canCache`, the writer-lease holder, D-16) and the overlay
 * still has the contents they were computed for. The markers are what stop a site that legitimately has no edge
 * from being asked again (Pitfall 6). True when nothing needed writing or the rows were stored or are stale on
 * purpose; false when this process could not write edges it holds. A process that may not write the cache and
 * has no edge to keep says nothing, exactly as before the markers existed.
 */
function store(
  parts: StoreParts,
  input: ResolveInput,
  edges: readonly ResolvedEdge[],
  askedSites: readonly RefSiteKey[],
  currentSnapshotId: string,
): boolean {
  if (edges.length === 0 && askedSites.length === 0) return true;
  if (!parts.canCache()) return edges.length === 0;
  if (currentSnapshotId !== input.snapshotId) return true; // the overlay moved on: these rows describe a state that is gone
  try {
    parts.writeDb.transaction(() => {
      const live = liveSnapshotIds(parts.writeDb);
      if (!live.has(input.snapshotId)) return;
      const contextId = ensureContextId(parts.writeDb, input.contextKey);
      writeEdges(parts.writeDb, input.snapshotId, contextId, edges);
      writeAsked(parts.writeDb, input.snapshotId, contextId, askedSites);
      pruneEdges(parts.writeDb, live);
    });
    return true;
  } catch (error) {
    if (error instanceof DbError) return false; // busy, read-only or closed: the cache is not ours to write
    throw error;
  }
}

function groupBySite(edges: readonly ResolvedEdge[], into: Map<string, CachedEdge[]>): void {
  for (const edge of edges) {
    const id = siteId(edge.site);
    const list = into.get(id) ?? [];
    if (!list.some((known) => symbolKey(known.target) === symbolKey(edge.target))) {
      list.push({ site: edge.site, target: edge.target, resolver: edge.resolver });
    }
    into.set(id, list);
  }
}

/**
 * Phase 2: ask the resolver about the sites the cache could not answer. Within `timeoutMs` the answer carries
 * the precise edges; past it the answer carries nothing from the resolver and `resolver_timeout`, while the run
 * continues in the background and fills the cache for the next call. A resolver that throws gives
 * `resolver_failed`. A process that may not write the cache still returns the precise edges and says
 * `cache_unavailable`.
 */
export async function resolveSites(
  parts: StoreParts,
  worktree: WorktreeId,
  input: ResolveInput,
  options: ResolveOptions | undefined,
): Promise<ResolvedSites> {
  const edges = new Map<string, CachedEdge[]>();
  for (const [id, list] of input.cached) edges.set(id, [...list]);
  // A site is settled when the cache holds an edge for it or the resolver was already asked about it (the marker).
  const pending = input.sites.filter((site) => !input.cached.has(siteId(site)) && !input.asked.has(siteId(site)));
  if (pending.length === 0) return { edges, degraded: tierState(input, edges) };
  // No project context for this snapshot: the resolver is not asked, and nothing is cached.
  if (input.unavailable === true) return { edges, degraded: ['resolver_failed'] };
  const asked = new Set(pending.map(siteId));

  const run = collectEdges(parts, pending, { worktree, overlay: input.overlay, project: input.project });
  const outcome = await settle(run, parts.deps.clock, options?.timeoutMs);

  if (outcome.kind === 'failed') return { edges, degraded: withState([outcome.code], input, edges) };
  if (outcome.kind === 'timeout') {
    run.then(
      (fresh) => {
        try {
          const accepted = validate(parts, worktree, asked, fresh.edges);
          if (accepted !== null) store(parts, input, accepted.edges, pending, accepted.snapshotId);
        } catch {
          // Background work has no caller to tell; the next call computes again.
        }
      },
      () => undefined,
    );
    return { edges, degraded: withState(['resolver_timeout'], input, edges) };
  }

  const accepted = validate(parts, worktree, asked, outcome.value.edges);
  if (accepted === null) return { edges, degraded: withState([...outcome.value.notices], input, edges) };
  groupBySite(accepted.edges, edges);
  const stored = store(parts, input, accepted.edges, pending, accepted.snapshotId);
  return { edges, degraded: withState([...outcome.value.notices, ...(stored ? [] : ['cache_unavailable' as const])], input, edges) };
}

/**
 * The codes a read carries because of the state of the precise tier, whether or not a resolver ran (plan 03-23): the
 * codes the project context itself names, `precise_unavailable` when a site's path needs a config that no config
 * covers, and `compiler_fallback` when precise edges are in use under the bundled compiler. A cached answer says what a
 * fresh one would, so a fallback is never hidden by the cache.
 */
function tierState(input: ResolveInput, edges: ReadonlyMap<string, readonly CachedEdge[]>): DegradedCode[] {
  const codes = new Set<DegradedCode>();
  if (input.sites.length === 0 || input.unavailable === true) return [];
  for (const code of input.project.degraded ?? []) codes.add(code);
  const precise = input.project.precise;
  if (precise !== undefined) {
    if (input.sites.some((site) => precise.requiresOwner(site.path) && precise.ownerOf(site.path) === undefined)) {
      codes.add('precise_unavailable');
    }
    if (precise.compiler.source === 'bundled' && [...edges.values()].some((list) => list.length > 0)) codes.add('compiler_fallback');
  }
  return [...codes];
}

/** `codes` followed by the state codes, each once. */
function withState(
  codes: readonly DegradedCode[],
  input: ResolveInput,
  edges: ReadonlyMap<string, readonly CachedEdge[]>,
): DegradedCode[] {
  return [...new Set([...codes, ...tierState(input, edges)])];
}

/** What the precise edges say about one grammar edge of `target` at `site`. */
type Verdict = { readonly kind: 'grammar' } | { readonly kind: 'removed' } | { readonly kind: 'precise'; readonly resolver: string };

/**
 * A precise edge at the site supersedes the grammar candidate (tier precise, confidence EXTRACTED); one that
 * binds the site to a different symbol removes it from this target's edges; a site the resolver did not answer
 * keeps its grammar result.
 */
function verdictFor(edges: ReadonlyMap<string, readonly CachedEdge[]>, site: RefSiteKey, target: SymbolIdentity): Verdict {
  const found = edges.get(siteId(site));
  if (found === undefined || found.length === 0) return { kind: 'grammar' };
  const key = symbolKey(target);
  const match = found.find((edge) => symbolKey(edge.target) === key);
  return match === undefined ? { kind: 'removed' } : { kind: 'precise', resolver: match.resolver };
}

/** Phase 3 for `refs`: merge the precise edges over the grammar records of `target`. */
export function mergeRefs(
  records: readonly RefRecord[],
  target: SymbolIdentity,
  edges: ReadonlyMap<string, readonly CachedEdge[]>,
): RefRecord[] {
  const out: RefRecord[] = [];
  for (const record of records) {
    const verdict = verdictFor(edges, record.site, target);
    if (verdict.kind === 'removed') continue;
    if (verdict.kind === 'grammar') {
      out.push(record);
      continue;
    }
    const { candidates, ...rest } = record;
    void candidates; // a precise edge is not ambiguous
    out.push({ ...rest, extractor: `precise:${verdict.resolver}`, confidence: 'EXTRACTED', tier: 'precise' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Relations: extends, implements and overrides (plan 03-25, OQ1).
//
// A relation binds two grammar symbols and has no reference site, so it travels through the resolver's optional
// `relations` method and is cached in its own table, keyed like an edge by overlay snapshot and resolution context and
// settled per file (the file a relation's `from` symbol is declared in). The read has the same three phases as `refs`:
// the plan and the cache inside one read transaction, the resolver outside any transaction within the caller's timeout,
// and the records built from the validated rows in a last short read. A resolver without the method gives no relations
// and no degraded code.
// ---------------------------------------------------------------------------------------------------------

/** What phase 1 of a relations read learned: whether the symbol exists, the files that can contribute and the cache. */
interface RelationPlan {
  readonly found: boolean;
  /** The files whose relations can contribute, in code-unit order. */
  readonly files: readonly string[];
  /** The cached relations that may concern the symbol, before the direction is applied. */
  readonly cached: readonly CachedRelation[];
  /** The files, among `files`, that were asked before under this snapshot and context. */
  readonly asked: ReadonlySet<string>;
}

/**
 * The files that may declare a subtype of `target` (a class or an interface), and the types those references sit in. A
 * subtype names its base in a heritage clause, so a heritage reference is the sign; so is any other reference that sits
 * directly in a class or an interface and not in one of its members, because a heritage clause can be an expression the
 * grammar tier does not tag (`extends Mixin(Base)`). A candidate that is not a subtype costs one extra file and never a
 * wrong relation, because the compiler decides.
 */
function heritageOf(snap: Snapshot, target: SymbolIdentity): { readonly files: readonly string[]; readonly subtypes: readonly SymbolIdentity[] } {
  const files = new Set<string>();
  const subtypes: SymbolIdentity[] = [];
  for (const hit of scopedRefs(snap, target)) {
    const inType = hit.enclosing !== null && (hit.enclosing.kind === 'class' || hit.enclosing.kind === 'interface');
    if (hit.kind !== 'heritage' && !inType) continue;
    files.add(hit.path);
    if (inType && hit.enclosing !== null) subtypes.push(hit.enclosing);
  }
  return { files: [...files], subtypes };
}

/**
 * The files that import `filePath` and declare a class or an interface. A heritage clause the grammar tier does not tag
 * (`extends ns.Base`, a namespace import's member) can only name a type that its file can reach, so these files are the
 * candidates that no reference of the grammar tier shows. A candidate that is not a subtype costs one file.
 */
function typeFilesImporting(snap: Snapshot, filePath: string): string[] {
  const out: string[] = [];
  for (const edge of walkImporters(snap, filePath, 1)) {
    const fileId = overlayView(snap).fileIds.get(edge.row.importer);
    if (fileId === undefined || fileId === null) continue;
    if (fileSymbols(snap, fileId).some((symbol) => symbol.kind === 'class' || symbol.kind === 'interface')) out.push(edge.row.importer);
  }
  return out;
}

/**
 * The files that may declare a subtype of `root`, found from the grammar tier's heritage references and from the files that
 * import the file of a type and declare classes or interfaces, followed `depth` levels down. This only chooses which files
 * the compiler is asked about, so a candidate that turns out not to be a subtype costs one extra file and never a wrong
 * relation.
 */
function subtypeFiles(snap: Snapshot, root: SymbolIdentity, depth: number): readonly string[] {
  const files = new Set<string>();
  const seen = new Set<string>([symbolKey(root)]);
  let frontier: SymbolIdentity[] = [root];
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: SymbolIdentity[] = [];
    for (const type of frontier) {
      const found = heritageOf(snap, type);
      for (const file of found.files) files.add(file);
      for (const file of typeFilesImporting(snap, type.path)) files.add(file);
      for (const subtype of found.subtypes) {
        const key = symbolKey(subtype);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(subtype);
      }
    }
    frontier = next;
  }
  return [...files];
}

/** The identity of the symbol that contains `symbol` (a method's class), or null for a top-level symbol. */
function containerOf(snap: Snapshot, id: SymbolIdentity, found: { readonly file: { readonly id: number }; readonly symbol: FileSymbol }): SymbolIdentity | null {
  if (found.symbol.parent === null) return null;
  const parent = fileSymbols(snap, found.file.id).find((candidate) => candidate.ord === found.symbol.parent);
  return parent === undefined ? null : identityOf(snap, id.path, parent);
}

/**
 * Phase 1 of a relations read: the files whose relations can answer the question and what the cache holds for them. The
 * supertypes of a symbol (`out`) come from its own file. Its subtypes (`in`) come from the files that refer to it in a
 * heritage clause; for a member, the subtypes of its container, followed down the hierarchy, because a member is overridden
 * by a subtype that need not be a direct one.
 */
function planRelations(snap: Snapshot, id: SymbolIdentity, direction: RelationDirection, project: ProjectContext | null): RelationPlan {
  const located = findSymbol(snap, id);
  if (located === null) return { found: false, files: [], cached: [], asked: new Set() };
  const wanted = new Set<string>();
  // Only a class, an interface or a member of one can have a supertype, and a type alias can also have implementers; for
  // any other symbol (a function, a variable) there is nothing to ask, so a plain `code_refs` pays nothing for relations.
  const container = containerOf(snap, id, located);
  const hasSupertypes = container !== null || id.kind === 'class' || id.kind === 'interface';
  const hasSubtypes = hasSupertypes || id.kind === 'type';
  if (direction !== 'in' && hasSupertypes) wanted.add(id.path);
  if (direction !== 'out' && hasSubtypes) {
    for (const file of subtypeFiles(snap, container ?? id, container === null ? 1 : MAX_WALK_DEPTH)) wanted.add(file);
  }
  const files = [...wanted].sort(compareCodeUnits);
  if (project === null || files.length === 0) return { found: true, files, cached: [], asked: new Set() };
  const contextId = findContextId(snap.db, contextKey(project.context));
  if (contextId === undefined) return { found: true, files, cached: [], asked: new Set() };
  const snapshot = snapshotIdOf(snap);
  const repo = snap.parts.repo;
  const cached: CachedRelation[] = [];
  if (direction !== 'out') cached.push(...readRelationsTo(snap.db, snapshot, contextId, id, repo));
  if (direction !== 'in') cached.push(...readRelationsFrom(snap.db, snapshot, contextId, id.path, repo));
  return { found: true, files, cached, asked: readRelationsAsked(snap.db, snapshot, contextId, files) };
}

const relationKey = (item: { readonly relation: string; readonly from: SymbolIdentity; readonly to: SymbolIdentity }): string =>
  `${item.relation}\u0000${symbolKey(item.from)}\u0000${symbolKey(item.to)}`;

/** The members of the class or interface `id` have the qualified name `id.qualifiedName` plus a dot and a name. */
function isMemberOf(member: SymbolIdentity, container: SymbolIdentity): boolean {
  return member.path === container.path && member.qualifiedName.startsWith(`${container.qualifiedName}.`);
}

/**
 * The relations among `rows` that answer a question about `id` in `direction`: `in` the ones that end at it, `out` the ones
 * that start at it and, for a class or an interface, the `overrides` that start at one of its members.
 */
function concerning(rows: readonly CachedRelation[], id: SymbolIdentity, direction: RelationDirection): CachedRelation[] {
  const key = symbolKey(id);
  return rows.filter((row) => {
    const incoming = symbolKey(row.to) === key;
    const outgoing = symbolKey(row.from) === key || (row.relation === 'overrides' && isMemberOf(row.from, id));
    return direction === 'in' ? incoming : direction === 'out' ? outgoing : incoming || outgoing;
  });
}

function isRelationShaped(value: unknown): value is ResolvedRelation {
  const item = value as Partial<ResolvedRelation> | null | undefined;
  const endpoint = (side: Partial<SymbolIdentity> | undefined): boolean =>
    typeof side === 'object' && side !== null && typeof side.path === 'string' && typeof side.qualifiedName === 'string' && typeof side.kind === 'string';
  return typeof item === 'object' && item !== null && endpoint(item.from) && endpoint(item.to) && isRelationKind(item.relation) && typeof item.resolver === 'string';
}

/**
 * Keep the relations that start in a file we asked about and end at symbols the overlay holds (T-03-251), once each, and
 * report the overlay's snapshot id as it is now. Null when the overlay or the store is gone.
 */
function validateRelations(
  parts: StoreParts,
  worktree: WorktreeId,
  asked: ReadonlySet<string>,
  fresh: readonly ResolvedRelation[],
): { readonly relations: readonly ResolvedRelation[]; readonly snapshotId: string } | null {
  try {
    return readSnapshot(parts, worktree, (snap) => {
      const seen = new Set<string>();
      const relations: ResolvedRelation[] = [];
      for (const item of fresh) {
        if (!isRelationShaped(item) || !asked.has(item.from.path)) continue;
        if (symbolKey(item.from) === symbolKey(item.to)) continue;
        if (findSymbol(snap, item.from) === null || findSymbol(snap, item.to) === null) continue;
        const key = relationKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push(item);
      }
      return { relations, snapshotId: snapshotIdOf(snap) };
    }).value;
  } catch (error) {
    if (error instanceof UnknownWorktree || error instanceof StoreClosed) return null;
    throw error;
  }
}

/**
 * Write validated relations, and the asked marker of every file the completed call was asked about, in one transaction,
 * when this process may and the overlay still has the contents they were computed for (the rules of {@link store}).
 */
function storeRelations(
  parts: StoreParts,
  input: ResolveInput,
  relations: readonly ResolvedRelation[],
  askedFiles: readonly string[],
  currentSnapshotId: string,
): boolean {
  if (relations.length === 0 && askedFiles.length === 0) return true;
  if (!parts.canCache()) return relations.length === 0;
  if (currentSnapshotId !== input.snapshotId) return true;
  try {
    parts.writeDb.transaction(() => {
      const live = liveSnapshotIds(parts.writeDb);
      if (!live.has(input.snapshotId)) return;
      const contextId = ensureContextId(parts.writeDb, input.contextKey);
      writeRelations(parts.writeDb, input.snapshotId, contextId, relations);
      writeRelationsAsked(parts.writeDb, input.snapshotId, contextId, askedFiles);
      pruneEdges(parts.writeDb, live);
    });
    return true;
  } catch (error) {
    if (error instanceof DbError) return false;
    throw error;
  }
}

/** What one drained `relations` call produced: its relations, and the codes its notices asked the answer to carry. */
interface CollectedRelations {
  readonly relations: ResolvedRelation[];
  readonly notices: ReadonlySet<DegradedCode>;
}

async function collectRelations(parts: StoreParts, files: readonly string[], scope: ResolveScope): Promise<CollectedRelations> {
  const relations: ResolvedRelation[] = [];
  const notices = new Set<DegradedCode>();
  const resolver = parts.deps.resolver;
  if (resolver.relations === undefined) return { relations, notices };
  for await (const item of resolver.relations(files, scope.project.context, symbolLookupOf(parts, scope.worktree), scope)) {
    if (isResolverNotice(item)) notices.add(item.degraded);
    else relations.push(item);
  }
  return { relations, notices };
}

/**
 * The codes a relations read carries because of the state of the precise tier, whether or not the resolver ran: the codes
 * the project context names, `precise_unavailable` for a file that needs a config and has none, and `compiler_fallback`
 * when relations are in use under the bundled compiler.
 */
function relationTierState(input: ResolveInput, files: readonly string[], anyRelation: boolean): DegradedCode[] {
  if (files.length === 0 || input.unavailable === true) return [];
  const codes = new Set<DegradedCode>(input.project.degraded ?? []);
  const precise = input.project.precise;
  if (precise !== undefined) {
    if (files.some((file) => precise.requiresOwner(file) && precise.ownerOf(file) === undefined)) codes.add('precise_unavailable');
    if (precise.compiler.source === 'bundled' && anyRelation) codes.add('compiler_fallback');
  }
  return [...codes];
}

/** The provenance-carrying records of the rows whose endpoints the snapshot holds, in the order relations are listed. */
function relationRecords(snap: Snapshot, rows: readonly CachedRelation[], limit: number | undefined): RelationRecord[] {
  const ranked: Array<{ readonly rank: number; readonly record: RelationRecord }> = [];
  for (const row of rows) {
    const from = findSymbol(snap, row.from);
    const to = findSymbol(snap, row.to);
    if (from === null || to === null) continue;
    ranked.push({
      rank: RELATION_KINDS.indexOf(row.relation),
      record: {
        source_path: row.from.path,
        span: from.symbol.span,
        extractor: `precise:${row.resolver}`,
        content_hash: from.file.hash,
        first_seen: from.file.firstSeen,
        last_seen: from.file.lastSeen,
        confidence: 'EXTRACTED',
        debug: `rel/${row.relation}/${encodeURIComponent(row.from.path)}/${from.file.hash}/${String(from.symbol.ord)}/${encodeURIComponent(row.to.path)}/${String(to.symbol.ord)}`,
        from: row.from,
        to: row.to,
        relation: row.relation,
        tier: 'precise',
      },
    });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareCodeUnits(a.record.source_path, b.record.source_path) ||
      a.record.span.startLine - b.record.span.startLine ||
      a.record.span.startColumn - b.record.span.startColumn ||
      compareCodeUnits(a.record.to.path, b.record.to.path) ||
      compareCodeUnits(a.record.to.qualifiedName, b.record.to.qualifiedName) ||
      compareCodeUnits(a.record.debug, b.record.debug),
  );
  const cap = limit === undefined || Number.isNaN(limit) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(limit));
  return ranked.slice(0, cap).map((entry) => entry.record);
}

/**
 * `Reader.relations`: the relations of `id` in `options.direction`, from the cache and the resolver. Phase 2 asks the
 * resolver only for the files the cache has not settled, within `options.timeoutMs`; past it the answer carries what the
 * cache holds and `resolver_timeout` while the run carries on in the background and fills the cache. A resolver that
 * throws gives its own code (`resolver_failed` unless the error carries another). No resolver, or one without the
 * method, gives the cached relations (none) and no code.
 */
export async function resolveRelations(
  parts: StoreParts,
  worktree: WorktreeId,
  id: SymbolIdentity,
  options: RelationsOptions | undefined,
): Promise<Answer<readonly RelationRecord[]>> {
  const direction = options?.direction ?? 'both';
  const started = readResolving(parts, worktree, (snap, project) => planRelations(snap, id, direction, project), () => []);
  const first = started instanceof Promise ? await started : started;
  const { grammar: plan, input } = first.value;
  if (!plan.found) return toAnswer(first, []);

  const rows = new Map<string, CachedRelation>();
  const take = (found: readonly CachedRelation[]): void => {
    for (const row of concerning(found, id, direction)) rows.set(relationKey(row), row);
  };
  take(plan.cached);

  const codes: DegradedCode[] = [];
  if (parts.deps.resolver.relations !== undefined) {
    const pending = plan.files.filter((file) => !plan.asked.has(file));
    if (pending.length > 0) {
      if (input.unavailable === true) {
        // No project context for this snapshot: the resolver is not asked, and nothing is cached.
        codes.push('resolver_failed');
      } else {
        const asked = new Set(pending);
        const run = collectRelations(parts, pending, { worktree, overlay: input.overlay, project: input.project });
        const outcome = await settle(run, parts.deps.clock, options?.timeoutMs);
        if (outcome.kind === 'failed') {
          codes.push(outcome.code);
        } else if (outcome.kind === 'timeout') {
          run.then(
            (fresh) => {
              try {
                const accepted = validateRelations(parts, worktree, asked, fresh.relations);
                if (accepted !== null) storeRelations(parts, input, accepted.relations, pending, accepted.snapshotId);
              } catch {
                // Background work has no caller to tell; the next call computes again.
              }
            },
            () => undefined,
          );
          codes.push('resolver_timeout');
        } else {
          codes.push(...outcome.value.notices);
          const accepted = validateRelations(parts, worktree, asked, outcome.value.relations);
          if (accepted !== null) {
            take(accepted.relations.map((item) => ({ from: item.from, to: item.to, relation: item.relation, resolver: item.resolver })));
            if (!storeRelations(parts, input, accepted.relations, pending, accepted.snapshotId)) codes.push('cache_unavailable');
          }
        }
      }
    }
    codes.push(...relationTierState(input, plan.files, rows.size > 0));
  }

  const final = readSnapshot(parts, worktree, (snap) => relationRecords(snap, [...rows.values()], options?.limit));
  return toAnswer(final, final.value, [...new Set(codes)]);
}

/** The edges of a caller walk that precise edges leave standing. */
export function standingEdge(edges: ReadonlyMap<string, readonly CachedEdge[]>, edge: CallEdge): boolean {
  return verdictFor(edges, siteKeyOf(edge.hit), edge.callee).kind !== 'removed';
}

/** Phase 3 for `callers`: a caller record for one walked edge, precise when a precise edge binds its site. */
export function mergeCaller(
  edges: ReadonlyMap<string, readonly CachedEdge[]>,
  edge: CallEdge,
  provenance: Provenance,
  hops: number,
): CallerRecord {
  const verdict = verdictFor(edges, siteKeyOf(edge.hit), edge.callee);
  const grammar = callerRecord(provenance, edge.callee, edge.caller, hops);
  return verdict.kind === 'precise'
    ? { ...grammar, extractor: `precise:${verdict.resolver}`, confidence: 'EXTRACTED', tier: 'precise' }
    : grammar;
}

// ---------------------------------------------------------------------------------------------------------
// The eager pass (plan 03-29, research Pattern 10 and Pitfall 5).
//
// `FactStore.resolve` asks the resolver about EVERY reference site of an overlay, in path order and in batches, through the
// same phase 1 / phase 2 / store path a read uses (`readResolving`, `resolveSites`, `validate`, `store`). The asked markers
// are what make it idempotent and resumable: a settled site is never asked again. The cursor in `meta` is a shortcut over
// them, so a resumed or repeated call does not walk the settled part of the overlay. It is keyed by the overlay snapshot and
// the resolution context, so an edit (a new snapshot) or another configuration starts again, as the cache itself does.
// ---------------------------------------------------------------------------------------------------------

/** The sites one resolver call of the pass carries when the caller does not say: the approved `precise.sitesPerRequest`. */
export const DEFAULT_RESOLVE_BATCH = 2000;

/** The names of the cursors in `meta` start with this; the rest is `<snapshot id>:<resolution context row id>`. */
export const RESOLVE_CURSOR_PREFIX = 'resolve_cursor:';

/** Where the pass stands: every site was asked (`done`), or the last site asked is the `ord`-th reference of `path`. */
type PassCursor = { readonly done: true } | { readonly done: false; readonly path: string; readonly ord: number };

/** A position the running call holds in memory, valid only for the snapshot and context it was reached under. */
interface PassPosition {
  readonly snapshotId: string;
  readonly contextKey: string;
  readonly path: string;
  readonly ord: number;
}

const cursorName = (snapshotId: string, contextId: number): string => `${RESOLVE_CURSOR_PREFIX}${snapshotId}:${String(contextId)}`;

/** The stored cursor, or undefined when there is none or it cannot be read (the pass then starts at the beginning). */
function readPassCursor(db: Db, name: string): PassCursor | undefined {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
    if (row === undefined) return undefined;
    const value = JSON.parse(str(row.value)) as { readonly done?: unknown; readonly path?: unknown; readonly ord?: unknown } | null;
    if (value?.done === true) return { done: true };
    if (typeof value?.path === 'string' && typeof value.ord === 'number' && Number.isInteger(value.ord)) {
      return { done: false, path: value.path, ord: value.ord };
    }
  } catch (error) {
    if (!(error instanceof DbError) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

/**
 * Store the cursor of the pass for the snapshot and context `input` was read under, and forget the cursors of snapshots that no
 * live overlay has any more. Best effort: a cursor that cannot be written only costs the next call a walk over settled sites.
 */
function savePassCursor(parts: StoreParts, input: ResolveInput, cursor: PassCursor): void {
  if (!parts.canCache() || input.unavailable === true) return;
  try {
    parts.writeDb.transaction(() => {
      const live = liveSnapshotIds(parts.writeDb);
      if (!live.has(input.snapshotId)) return;
      const contextId = ensureContextId(parts.writeDb, input.contextKey);
      // ':' is followed by ';' in code-unit order, so this is exactly the names that start with the prefix.
      const upper = `${RESOLVE_CURSOR_PREFIX.slice(0, -1)};`;
      for (const row of parts.writeDb.prepare('SELECT name FROM meta WHERE name >= ? AND name < ?').all(RESOLVE_CURSOR_PREFIX, upper)) {
        const name = str(row.name);
        const snapshot = name.slice(RESOLVE_CURSOR_PREFIX.length).split(':')[0] ?? '';
        if (!live.has(snapshot)) parts.writeDb.prepare('DELETE FROM meta WHERE name = ?').run(name);
      }
      parts.writeDb.prepare('INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)').run(cursorName(input.snapshotId, contextId), JSON.stringify(cursor));
    });
  } catch (error) {
    if (!(error instanceof DbError)) throw error; // busy, read-only or closed: the cursor is not ours to write
  }
}

const NEXT_PASS_SITES_SQL = `SELECT o.path AS path, r.ord AS ord, n.name AS name, r.start_line AS start_line, r.start_col AS start_col,
       r.end_line AS end_line, r.end_col AS end_col
       FROM overlay_files o
       JOIN refs r ON r.file_id = o.file_id
       JOIN names n ON n.id = r.name_id
       WHERE o.worktree = ? AND (o.path > ? OR (o.path = ? AND r.ord > ?))
       ORDER BY o.path, r.ord
       LIMIT ?`;

/** What phase 1 of one batch of the pass found. */
type PassStep =
  /** No project context could be had for this snapshot: nothing can be asked. */
  | { readonly kind: 'unavailable' }
  /** The project has no compiler configuration, so there is nothing a precise tier could be asked. */
  | { readonly kind: 'nothing' }
  /** The stored cursor of this snapshot and context says every site was asked. */
  | { readonly kind: 'settled' }
  /** The next sites after the cursor (none at the end of the overlay) and the position of the last of them. */
  | { readonly kind: 'batch'; readonly sites: readonly RefSiteKey[]; readonly last: { readonly path: string; readonly ord: number } | undefined };

function readPassStep(snap: Snapshot, project: ProjectContext | null, batchSize: number, local: PassPosition | undefined): PassStep {
  if (project === null) return { kind: 'unavailable' };
  if (project.precise !== undefined && project.precise.configs.length === 0) return { kind: 'nothing' };
  const snapshotId = snapshotIdOf(snap);
  const key = contextKey(project.context);
  let from: { readonly path: string; readonly ord: number } = { path: '', ord: -1 };
  if (local !== undefined && local.snapshotId === snapshotId && local.contextKey === key) {
    from = local;
  } else {
    const contextId = findContextId(snap.db, key);
    const saved = contextId === undefined ? undefined : readPassCursor(snap.db, cursorName(snapshotId, contextId));
    if (saved?.done === true) return { kind: 'settled' };
    if (saved !== undefined) from = saved;
  }
  const rows = snap.db.prepare(NEXT_PASS_SITES_SQL).all(snap.worktree, from.path, from.path, from.ord, batchSize);
  const sites = rows.map((row): RefSiteKey => ({ path: str(row.path), span: spanOf(row), name: str(row.name) }));
  const end = rows[rows.length - 1];
  return { kind: 'batch', sites, last: end === undefined ? undefined : { path: str(end.path), ord: num(end.ord) } };
}

/** The codes that stop the pass: the resolver or the cache failed, so what the call asked is not settled. */
const PASS_FAILURES: ReadonlySet<DegradedCode> = new Set<DegradedCode>(['resolver_failed', 'resolver_timeout', 'memory_budget', 'cache_unavailable']);

/**
 * `FactStore.resolve`: see the interface. The time box is checked between batches, and one batch always runs per call, so a
 * call makes progress whatever the budget. A batch is awaited whole: its own bound is the resolver's (the compiler worker's
 * request time-out), not the budget's.
 */
export async function resolveAllSites(parts: StoreParts, worktree: WorktreeId, options: ResolveBatchOptions): Promise<ResolveResult> {
  const { clock } = parts.deps;
  const startedAt = clock.now();
  const batchSize = options.batchSize ?? DEFAULT_RESOLVE_BATCH;
  const noted = new Set<DegradedCode>();
  let asked = 0;
  let answered = 0;
  let batches = 0;
  let local: PassPosition | undefined;
  const report = (complete: boolean, stopped?: 'budget' | 'failure'): ResolveResult => ({
    complete,
    spentMs: Math.max(0, clock.now() - startedAt),
    processed: asked,
    asked,
    answered,
    degraded: [...noted],
    ...(complete || stopped === undefined ? {} : { stopped }),
  });
  if (!parts.canCache()) {
    // A process that may not write the cache can not settle anything; asking would only repeat the work next time.
    noted.add('cache_unavailable');
    return report(false, 'failure');
  }
  for (;;) {
    if (batches > 0 && clock.now() - startedAt >= options.budgetMs) return report(false, 'budget');
    const begun = readResolving(
      parts,
      worktree,
      (snap, project) => readPassStep(snap, project, batchSize, local),
      (step) => (step.kind === 'batch' ? step.sites : []),
    );
    const first = begun instanceof Promise ? await begun : begun;
    const { grammar: step, input } = first.value;
    if (step.kind === 'nothing' || step.kind === 'settled') return report(true);
    if (step.kind === 'unavailable') {
      noted.add('resolver_failed');
      return report(false, 'failure');
    }
    if (step.last === undefined) {
      savePassCursor(parts, input, { done: true });
      return report(true);
    }
    // The sites this batch really asks: the ones neither the cache nor a marker settled before (a resumed call meets some).
    const pending = input.sites.filter((site) => !input.cached.has(siteId(site)) && !input.asked.has(siteId(site)));
    const resolved = await resolveSites(parts, worktree, input, undefined);
    for (const code of resolved.degraded) noted.add(code);
    if (resolved.degraded.some((code) => PASS_FAILURES.has(code))) return report(false, 'failure');
    asked += pending.length;
    answered += pending.filter((site) => (resolved.edges.get(siteId(site))?.length ?? 0) > 0).length;
    batches += 1;
    local = { snapshotId: input.snapshotId, contextKey: input.contextKey, path: step.last.path, ord: step.last.ord };
    savePassCursor(parts, input, { done: false, path: step.last.path, ord: step.last.ord });
  }
}
