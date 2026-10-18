/**
 * Grammar-tier resolution (D-06, LNG-03). Pure functions over one `Snapshot`: they scope reference sites by
 * file, import and export, report ambiguity as a candidate count, and never guess. Every edge they produce is
 * `INFERRED`; only a precise edge from the injected Resolver may be `EXTRACTED` (applied in the same module
 * once the resolver integration lands). Internal; not exported from index.ts.
 */
import { posix } from 'node:path';
import { DEFAULT_PROJECT_CONTEXT, symbolKey } from '../facts/index.ts';
import type {
  Clock,
  DegradedCode,
  OverlaySnapshot,
  ProjectContext,
  RefKind,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  ResolveScope,
  Span,
  SymbolIdentity,
  SymbolLookup,
} from '../facts/index.ts';
import { DbError } from '../sqlite/index.ts';
import {
  contextKey,
  ensureContextId,
  findContextId,
  liveSnapshotIds,
  overlaySnapshotId,
  pruneEdges,
  readEdges,
  siteId,
  writeEdges,
} from './cache.ts';
import type { CachedEdge } from './cache.ts';
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
} from './snapshot.ts';
import type { FileSymbol, ImportRow, Snapshot, SnapshotRead } from './snapshot.ts';
import type { CallerRecord, ImporterRecord, Provenance, RefRecord, ResolveOptions, WorktreeId } from './types.ts';

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
      unavailable: true,
    };
  }
  const { context } = project;
  const key = contextKey(context);
  const contextId = distinct.size === 0 ? undefined : findContextId(snap.db, key);
  if (contextId !== undefined) {
    for (const [id, edges] of readEdges(snap.db, snapshotId, contextId, [...distinct.values()], snap.parts.repo)) {
      const valid = edges.filter((edge) => findSymbol(snap, edge.target) !== null);
      if (valid.length > 0) cached.set(id, valid);
    }
  }
  return { snapshotId, project, context, contextKey: key, overlay, sites: [...distinct.values()], cached };
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
  grammar: (snap: Snapshot) => T,
  sitesOf: (value: T) => readonly RefSiteKey[],
): ResolvingRead<T> | Promise<ResolvingRead<T>> {
  const attempt = (n: number): ResolvingRead<T> | Promise<ResolvingRead<T>> => {
    const seen = readSnapshot(parts, worktree, (snap) => ({
      id: snapshotIdOf(snap),
      pathToHash: overlayView(snap).hashes,
    })).value;
    const finish = (project: ProjectContext | null): ResolvingRead<T> | Promise<ResolvingRead<T>> => {
      const read = readSnapshot(parts, worktree, (snap) => {
        const value = grammar(snap);
        const moved = project !== null && snapshotIdOf(snap) !== seen.id;
        return { grammar: value, input: prepareResolution(snap, sitesOf(value), moved ? null : project), moved };
      });
      return read.value.moved && n < 2 ? attempt(n + 1) : read;
    };
    const project = askProject(parts, worktree, seen);
    return project instanceof Promise ? project.then(finish) : finish(project);
  };
  return attempt(1);
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

type Settled =
  | { readonly kind: 'done'; readonly edges: readonly ResolvedEdge[] }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed' };

/**
 * Drain the resolver for `sites`, telling it where it resolves (`scope`) and giving it a read-only lookup of the
 * grammar tier's symbols. Rejects when it throws, on the call or while iterating.
 */
async function collectEdges(
  parts: StoreParts,
  sites: readonly RefSiteKey[],
  scope: ResolveScope,
): Promise<ResolvedEdge[]> {
  const { worktree } = scope;
  const lookup: SymbolLookup = {
    // Read back through the read-only connection, one short transaction per call (never held across an await).
    find: async (name) =>
      readSnapshot(parts, worktree, (snap) => findRecords(snap, name, { mode: 'exact' }).map((record) => record.identity)).value,
    findIn: async (path, name) => readSnapshot(parts, worktree, (snap) => symbolsIn(snap, path, name)).value,
  };
  const out: ResolvedEdge[] = [];
  for await (const edge of parts.deps.resolver(sites, scope.project.context, lookup, scope)) out.push(edge);
  return out;
}

/** Race the resolver against the caller's timeout on the injected clock. The resolver keeps running after a timeout. */
function settle(run: Promise<ResolvedEdge[]>, clock: Clock, timeoutMs: number | undefined): Promise<Settled> {
  return new Promise<Settled>((resolve) => {
    let done = false;
    let cancel = (): void => {};
    const finish = (outcome: Settled): void => {
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
      (edges) => {
        finish({ kind: 'done', edges });
      },
      () => {
        finish({ kind: 'failed' });
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
 * Write validated edges to the cache when this process may (`canCache`, the writer-lease holder, D-16) and the
 * overlay still has the contents they were computed for. True when nothing needed writing or the edges were
 * stored or are stale on purpose; false when this process could not write them.
 */
function store(parts: StoreParts, input: ResolveInput, edges: readonly ResolvedEdge[], currentSnapshotId: string): boolean {
  if (edges.length === 0) return true;
  if (!parts.canCache()) return false;
  if (currentSnapshotId !== input.snapshotId) return true; // the overlay moved on: these edges describe a state that is gone
  try {
    parts.writeDb.transaction(() => {
      const live = liveSnapshotIds(parts.writeDb);
      if (!live.has(input.snapshotId)) return;
      writeEdges(parts.writeDb, input.snapshotId, ensureContextId(parts.writeDb, input.contextKey), edges);
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
  const pending = input.sites.filter((site) => !input.cached.has(siteId(site)));
  if (pending.length === 0) return { edges, degraded: [] };
  // No project context for this snapshot: the resolver is not asked, and nothing is cached.
  if (input.unavailable === true) return { edges, degraded: ['resolver_failed'] };
  const asked = new Set(pending.map(siteId));

  const run = collectEdges(parts, pending, { worktree, overlay: input.overlay, project: input.project });
  const outcome = await settle(run, parts.deps.clock, options?.timeoutMs);

  if (outcome.kind === 'failed') return { edges, degraded: ['resolver_failed'] };
  if (outcome.kind === 'timeout') {
    run.then(
      (fresh) => {
        try {
          const accepted = validate(parts, worktree, asked, fresh);
          if (accepted !== null) store(parts, input, accepted.edges, accepted.snapshotId);
        } catch {
          // Background work has no caller to tell; the next call computes again.
        }
      },
      () => undefined,
    );
    return { edges, degraded: ['resolver_timeout'] };
  }

  const accepted = validate(parts, worktree, asked, outcome.edges);
  if (accepted === null) return { edges, degraded: [] };
  groupBySite(accepted.edges, edges);
  const stored = store(parts, input, accepted.edges, accepted.snapshotId);
  return { edges, degraded: stored ? [] : ['cache_unavailable'] };
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
