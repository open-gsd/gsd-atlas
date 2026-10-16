/**
 * Grammar-tier resolution (D-06, LNG-03). Pure functions over one `Snapshot`: they scope reference sites by
 * file, import and export, report ambiguity as a candidate count, and never guess. Every edge they produce is
 * `INFERRED`; only a precise edge from the injected Resolver may be `EXTRACTED` (applied in the same module
 * once the resolver integration lands). Internal; not exported from index.ts.
 */
import type { RefKind, Span, SymbolIdentity } from '../facts/index.ts';
import { extractorOf } from './parts.ts';
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
import type { FileSymbol, Snapshot } from './snapshot.ts';
import type { CallerRecord, Provenance, RefRecord } from './types.ts';

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
