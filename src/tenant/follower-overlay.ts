/**
 * The follower overlay (D-03, STO-08, IDX-04): what a process that does not hold the writer lease does with the
 * `fresh` paths of a request. It never writes and it never asks the leader for anything. It parses the named paths
 * itself, builds an in-memory overlay for that one request, merges it over the shared store's facts and answers from
 * the merge. Nothing is kept: the overlay is built inside the fresh port, handed to Query as the request's Reader and
 * dropped with the request (T-02-86).
 *
 * `createFollowerFresh` is the fresh port: it validates the paths like `Indexer.ensureFresh` does, reads and parses
 * them with the same module host, source-set filter and stat-before-and-after race handling as the Indexer, and
 * returns the outcome with the overlay Reader. `createOverlayReader` is the merge: for a patched path it takes the
 * patch's facts instead of the store's (a deleted or unreadable path hides the store's facts for it), and it derives
 * references, callers and importers from the merged facts with the store's own scoping rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { candidatePaths, resolveSpecifier } from '../fact-store/index.ts';
import type {
  CallerRecord,
  CitationRecord,
  FactStore,
  FindOptions,
  ImporterRecord,
  Reader,
  RefRecord,
  SymbolRecord,
} from '../fact-store/index.ts';
import { symbolKey } from '../facts/index.ts';
import type { Answer, Clock, DegradedCode, FileFacts, LocalSymbol, RefKind, SymbolIdentity, Watermark } from '../facts/index.ts';
import { DEFAULT_INDEXER_CONFIG, createPathFilter, isRepoRelative, realRoot, staysInside } from '../indexer/index.ts';
import type { ModuleHost } from '../indexer/index.ts';
import type { FreshPort, FreshReport } from '../query/index.ts';
import { SOURCE_TREE_CODES } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';

/** What the overlay Reader needs to build records that look like the store's. */
export interface OverlayContext {
  /** The repo name the store puts in symbol identities. */
  readonly repo: string;
  /** Stamps `first_seen` and `last_seen` of every record the overlay creates. */
  readonly clock: Clock;
  /** The extensions the loaded modules claim (lower-case, with the dot): used to generate candidate import targets. */
  readonly extensions: readonly string[];
}

/** The patch: parsed facts for a path that is source now, `null` for a path whose stored facts must be hidden. */
export type Patch = ReadonlyMap<string, FileFacts | null>;

/** `prefix` and `fuzzy` return at most this many rows unless the caller passes a limit (the store's default). */
const DEFAULT_FIND_LIMIT = 50;
const MIN_FUZZY_CHARS = 3;

/** The deepest a walk goes, whatever the caller asks for: the store's own bound (T-02-34), kept equal by a test. */
const MAX_WALK_DEPTH = 5;

/** A requested hop count or depth as a whole number from 1 to `MAX_WALK_DEPTH`; absent or not a number is 1. */
function clampDepth(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return 1;
  return Math.min(MAX_WALK_DEPTH, Math.max(1, Math.floor(requested)));
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const noop = (): void => {};

const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const extractorOf = (module: string, grammarVersion: string): string => `grammar:${module}@${grammarVersion}`;

/** A path with its last extension removed: `src/a.ts` and `src/a.js` both become `src/a`. */
function stemOf(filePath: string): string {
  const ext = path.posix.extname(filePath);
  return ext === '' ? filePath : filePath.slice(0, filePath.length - ext.length);
}

/** One definition of a file, with the identity and the record the store would hold for it. */
interface Definition {
  /** The index in `FileFacts.symbols`, which is the store's `ord`. */
  readonly ord: number;
  readonly symbol: LocalSymbol;
  readonly identity: SymbolIdentity;
  readonly record: SymbolRecord;
}

const definitionCache = new WeakMap<FileFacts, readonly Definition[]>();

/**
 * The definitions of `facts` in definition order, with the discriminator the store assigns: the zero-based index
 * among the symbols that share a qualified name (or name) and kind, set only when more than one share them.
 */
function definitionsOf(facts: FileFacts, repo: string, now: number): readonly Definition[] {
  const known = definitionCache.get(facts);
  if (known !== undefined) return known;
  const groupKey = (symbol: LocalSymbol): string => `${symbol.qualifiedName ?? symbol.name}\u0000${symbol.kind}`;
  const sizes = new Map<string, number>();
  for (const symbol of facts.symbols) sizes.set(groupKey(symbol), (sizes.get(groupKey(symbol)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const definitions = facts.symbols.map((symbol, ord): Definition => {
    const key = groupKey(symbol);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const base = { repo, path: facts.path, qualifiedName: symbol.qualifiedName ?? symbol.name, kind: symbol.kind };
    const identity: SymbolIdentity = (sizes.get(key) ?? 0) > 1 ? { ...base, discriminator: String(index) } : base;
    const record: SymbolRecord = {
      identity,
      version: facts.contentHash,
      source_path: facts.path,
      span: symbol.span,
      extractor: extractorOf(facts.module, facts.grammarVersion),
      content_hash: facts.contentHash,
      first_seen: now,
      last_seen: now,
      confidence: 'EXTRACTED',
      debug: `sym/${encodeURIComponent(facts.path)}/${facts.contentHash}/${String(ord)}`,
      ...(symbol.exported === undefined ? {} : { exported: symbol.exported }),
    };
    return { ord, symbol, identity, record };
  });
  definitionCache.set(facts, definitions);
  return definitions;
}

/** A definition inside the merged view: its path and its index in that file's symbols. */
interface Def {
  readonly path: string;
  readonly ord: number;
  readonly symbol: LocalSymbol;
}

const defKey = (def: { readonly path: string; readonly ord: number }): string => `${def.path}\u0000${String(def.ord)}`;

/** Definitions of `name` in `facts`; `topLevelOnly` keeps symbols that have no parent. */
function definitionsNamed(facts: FileFacts, name: string, topLevelOnly: boolean): Def[] {
  const out: Def[] = [];
  facts.symbols.forEach((symbol, ord) => {
    if (symbol.name === name && (!topLevelOnly || symbol.parent === undefined)) out.push({ path: facts.path, ord, symbol });
  });
  return out;
}

const laterOf = (a: Watermark, b: Watermark): Watermark => (b.seq > a.seq ? b : a);

/** `limit` as a whole number of rows, or `fallback` when absent. */
function limitOf(limit: number | undefined, fallback: number): number {
  return limit === undefined || Number.isNaN(limit) ? fallback : Math.max(0, Math.floor(limit));
}

function nameMatches(mode: NonNullable<FindOptions['mode']>, query: string, name: string): boolean {
  if (mode === 'prefix') return name.startsWith(query);
  if (mode === 'fuzzy') return asciiLower(name).includes(asciiLower(query));
  return name === query;
}

/** Order of the store's reads: path, then position. Stable, so records of one file keep the order they arrived in. */
function bySite(a: { readonly source_path: string; readonly span: { readonly startLine: number; readonly startColumn: number } }, b: typeof a): number {
  return compareCodeUnits(a.source_path, b.source_path) || a.span.startLine - b.span.startLine || a.span.startColumn - b.span.startColumn;
}

/**
 * The Reader of one request: `base` (the store's reader) with `patch` laid over it. The whole Reader interface is
 * implemented by merging, and every record the overlay creates carries the shape of the store's records:
 *
 * - `find`, `symbol` and `fileFacts` take the patched file's facts instead of the store's for patched paths.
 * - `refs` drops the store's sites that sit in patched files and adds the patched files' sites that are in scope for
 *   the target (same file, an export alias, or an import binding that resolves to the target's file and name).
 * - `callers` and `importers` walk the merged `refs` and the merged import statements breadth first, with the
 *   store's depth clamp and visited sets.
 *
 * Import specifiers resolve with the store's pure rule over the patched paths plus the candidate paths that exist in
 * the store, each probed with `Reader.fileFacts`.
 *
 * Known limits, all in the direction of showing less rather than something wrong: a site in an unpatched file keeps
 * the scoping the store computed against the store's version of a patched file's exports; a patched file's sites
 * never carry precise-tier edges.
 */
export function createOverlayReader(base: Reader, patch: Patch, context: OverlayContext): Reader {
  const now = context.clock.now();
  const { repo, extensions } = context;

  // What the store answered during this request: the latest watermark and every degraded code, plus `follower`.
  let watermark: Watermark | undefined;
  const codes = new Set<DegradedCode>(['follower']);
  const observe = <T>(answer: Answer<T>): T => {
    watermark = watermark === undefined ? answer.watermark : laterOf(watermark, answer.watermark);
    for (const code of answer.degraded ?? []) codes.add(code);
    return answer.data;
  };
  const result = <T>(data: T): Answer<T> => ({ data, watermark: watermark ?? { seq: 0, stalePaths: [] }, degraded: [...codes] });

  /** The facts of a path in the merged view, once: the patch's for a patched path, else the store's. */
  const factsMemo = new Map<string, Promise<FileFacts | null>>();
  const factsOf = (filePath: string): Promise<FileFacts | null> => {
    let known = factsMemo.get(filePath);
    if (known === undefined) {
      known = patch.has(filePath) ? Promise.resolve(patch.get(filePath) ?? null) : base.fileFacts(filePath).then(observe);
      factsMemo.set(filePath, known);
    }
    return known;
  };
  /** The store's own facts of a path (what the patch hides), for the row bound of `find` and the watermark. */
  const storedMemo = new Map<string, Promise<FileFacts | null>>();
  const storedFactsOf = (filePath: string): Promise<FileFacts | null> => {
    let known = storedMemo.get(filePath);
    if (known === undefined) {
      known = base.fileFacts(filePath).then(observe);
      storedMemo.set(filePath, known);
    }
    return known;
  };

  /** The merged view's paths a relative specifier names: the store's rule over the candidates that exist. */
  const resolvedMemo = new Map<string, Promise<readonly string[]>>();
  const resolveImport = (importer: string, specifier: string): Promise<readonly string[]> => {
    const key = `${importer}\u0000${specifier}`;
    let known = resolvedMemo.get(key);
    if (known === undefined) {
      known = (async () => {
        const candidates = candidatePaths(importer, specifier, extensions);
        const present = await Promise.all(candidates.map(async (candidate) => ((await factsOf(candidate)) === null ? null : candidate)));
        return resolveSpecifier(importer, specifier, new Set(present.filter((candidate): candidate is string => candidate !== null)));
      })();
      resolvedMemo.set(key, known);
    }
    return known;
  };

  /** The definitions a file exposes under the export name `exportName` (the store's `exportDefs`, over facts). */
  async function exportDefs(filePath: string, exportName: string): Promise<Def[]> {
    const facts = await factsOf(filePath);
    if (facts === null) return [];
    const entries = (facts.exports ?? []).filter((entry) => entry.name === exportName);
    if (entries.length > 0) {
      const out: Def[] = [];
      for (const entry of entries) {
        if (entry.from !== undefined) continue;
        out.push(...definitionsNamed(facts, entry.local ?? entry.name, true));
      }
      return out;
    }
    if (exportName === 'default') return [];
    return definitionsNamed(facts, exportName, true).filter((def) => def.symbol.exported !== false);
  }

  /**
   * Every definition a site of `name` and `kind` in `facts` could point at (the store's `targetsOf`): a definition of
   * the same name in the file, the local symbol behind an export alias of the file, and, through the file's relative
   * imports, the definition a binding resolves to in every file the specifier can name.
   */
  async function targetsOf(facts: FileFacts, name: string, kind: RefKind | undefined): Promise<Map<string, Def>> {
    const targets = new Map<string, Def>();
    const add = (def: Def): void => {
      targets.set(defKey(def), def);
    };
    facts.symbols.forEach((symbol, ord) => {
      if (symbol.name === name) add({ path: facts.path, ord, symbol });
    });
    for (const entry of facts.exports ?? []) {
      if (entry.name !== name || entry.local === undefined || entry.local === entry.name || entry.from !== undefined) continue;
      for (const def of definitionsNamed(facts, entry.local, true)) add(def);
    }
    for (const imp of facts.imports) {
      for (const binding of imp.bindings ?? []) {
        if (binding.imported === '*') {
          if (kind !== 'member') continue;
          for (const candidate of await resolveImport(facts.path, imp.path)) {
            for (const def of await exportDefs(candidate, name)) add(def);
          }
        } else if (binding.local === name && kind !== 'member') {
          for (const candidate of await resolveImport(facts.path, imp.path)) {
            for (const def of await exportDefs(candidate, binding.imported)) add(def);
          }
        }
      }
    }
    return targets;
  }

  const targetsMemo = new Map<string, Promise<Map<string, Def>>>();
  const targetsOfMemo = (facts: FileFacts, name: string, kind: RefKind | undefined): Promise<Map<string, Def>> => {
    const key = `${facts.path}\u0000${name}\u0000${kind ?? ''}`;
    let known = targetsMemo.get(key);
    if (known === undefined) {
      known = targetsOf(facts, name, kind);
      targetsMemo.set(key, known);
    }
    return known;
  };

  /** The definition `id` names in the merged view, with its file's facts; null when it does not exist there. */
  async function locate(id: SymbolIdentity): Promise<{ readonly facts: FileFacts; readonly definition: Definition } | null> {
    if (id.repo !== repo) return null;
    const facts = await factsOf(id.path);
    if (facts === null) return null;
    const definition = definitionsOf(facts, repo, now).find((candidate) => symbolKey(candidate.identity) === symbolKey(id));
    return definition === undefined ? null : { facts, definition };
  }

  /** The references to `id`: the store's, minus the sites of patched files, plus the patched files' sites in scope. */
  async function refsOf(id: SymbolIdentity, options: Parameters<Reader['refs']>[1]): Promise<RefRecord[]> {
    const stored = observe(await base.refs(id, options)).filter((record) => !patch.has(record.source_path));
    const located = await locate(id);
    // A definition the patch removed or renamed has no references left; one the store alone holds keeps the store's.
    if (located === null) return patch.has(id.path) ? [] : stored;
    const targetKey = defKey({ path: id.path, ord: located.definition.ord });

    const added: Array<{ readonly ord: number; readonly record: RefRecord }> = [];
    for (const facts of patch.values()) {
      if (facts === null) continue;
      const defs = definitionsOf(facts, repo, now);
      for (const [ord, site] of facts.refSites.entries()) {
        const targets = await targetsOfMemo(facts, site.name, site.kind);
        if (!targets.has(targetKey)) continue;
        const container = site.enclosing === undefined ? undefined : defs[site.enclosing];
        added.push({
          ord,
          record: {
            source_path: facts.path,
            span: site.span,
            extractor: extractorOf(facts.module, facts.grammarVersion),
            content_hash: facts.contentHash,
            first_seen: now,
            last_seen: now,
            confidence: 'INFERRED',
            debug: `ref/${encodeURIComponent(facts.path)}/${facts.contentHash}/${String(ord)}`,
            site: { path: facts.path, span: site.span, name: site.name },
            target: id,
            tier: 'grammar',
            enclosing: container === undefined ? null : container.identity,
            ...(targets.size > 1 ? { candidates: targets.size } : {}),
            ...(site.kind === undefined ? {} : { kind: site.kind }),
          },
        });
      }
    }
    added.sort((a, b) => bySite(a.record, b.record) || a.ord - b.ord);
    return [...stored, ...added.map((entry) => entry.record)].sort(bySite);
  }

  return {
    async find(name, options) {
      const mode = options?.mode ?? 'exact';
      if (name === '' || (mode === 'fuzzy' && name.length < MIN_FUZZY_CHARS)) {
        observe(await base.find(name, options));
        return result([]);
      }
      const wanted = limitOf(options?.limit, mode === 'exact' ? Number.POSITIVE_INFINITY : DEFAULT_FIND_LIMIT);
      // The store truncates before the merge, so it is asked for enough rows to survive dropping the patched paths'.
      let hidden = 0;
      for (const stored of await Promise.all([...patch.keys()].map((filePath) => storedFactsOf(filePath)))) {
        hidden += stored?.symbols.length ?? 0;
      }
      const baseOptions: FindOptions = {
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
        ...(Number.isFinite(wanted) ? { limit: wanted + hidden } : {}),
      };
      const rows: SymbolRecord[] = observe(await base.find(name, baseOptions)).filter((record) => !patch.has(record.source_path));
      for (const facts of patch.values()) {
        if (facts === null) continue;
        for (const definition of definitionsOf(facts, repo, now)) {
          if (nameMatches(mode, name, definition.symbol.name)) rows.push(definition.record);
        }
      }
      rows.sort(bySite);
      return result(rows.slice(0, wanted));
    },

    async symbol(id) {
      if (!patch.has(id.path)) return result(observe(await base.symbol(id)));
      await storedFactsOf(id.path); // the watermark of the answer
      return result((await locate(id))?.definition.record ?? null);
    },

    async fileFacts(filePath) {
      if (!patch.has(filePath)) return result(observe(await base.fileFacts(filePath)));
      await storedFactsOf(filePath);
      return result(patch.get(filePath) ?? null);
    },

    async emittedAs(filePath) {
      // The store's project context knows the configs; a path the patch holds is a source the store may not have yet.
      return result(observe(await base.emittedAs(filePath)));
    },

    async provenance(handle) {
      // `code_explain` takes no `fresh` paths, so a request that explains is never given an overlay; this keeps the whole Reader
      // interface honest anyway. A handle is explained from the store's own facts, which is also what the patch hides.
      return result(observe(await base.provenance(handle)));
    },

    async refs(id, options) {
      return result(await refsOf(id, options));
    },

    async citations(query, options) {
      // The store's citations minus the patched files', plus the patched files' own (read from their facts, as the store would).
      const stored = observe(await base.citations(query, options)).filter((record) => !patch.has(record.source_path));
      const added: CitationRecord[] = [];
      for (const facts of patch.values()) {
        if (facts === null || facts.citations === undefined) continue;
        const defs = definitionsOf(facts, repo, now);
        facts.citations.forEach((site, ord) => {
          const enclosing = site.enclosing === undefined ? undefined : defs[site.enclosing];
          const wanted =
            query.number !== undefined
              ? site.number === query.number
              : query.symbol !== undefined && enclosing !== undefined && symbolKey(enclosing.identity) === symbolKey(query.symbol);
          if (!wanted) return;
          added.push({
            source_path: facts.path,
            span: site.span,
            extractor: extractorOf(facts.module, facts.grammarVersion),
            content_hash: facts.contentHash,
            first_seen: now,
            last_seen: now,
            confidence: 'EXTRACTED',
            debug: `cit/${encodeURIComponent(facts.path)}/${facts.contentHash}/${String(ord)}`,
            number: site.number,
            ...(site.detail === undefined ? {} : { detail: site.detail }),
            enclosing: enclosing === undefined ? null : enclosing.identity,
          });
        });
      }
      return result([...stored, ...added].sort(bySite).slice(0, limitOf(options?.limit, Number.POSITIVE_INFINITY)));
    },

    async citationGaps(options) {
      // The store's count, with each patched path's own gap taken from its facts instead of the store's row (a hidden path has none).
      let files = observe(await base.citationGaps(options)).files;
      const patched = options?.path === undefined ? [...patch.keys()] : patch.has(options.path) ? [options.path] : [];
      for (const filePath of patched) {
        const stored = observe(await base.citationGaps({ path: filePath })).files;
        files += (patch.get(filePath)?.citationGaps === undefined ? 0 : 1) - stored;
      }
      return result({ files });
    },

    async relations(id, options) {
      // The store's relations, minus the ones that start or end in a patched file: the compiler saw the store's version of
      // that file, so a relation that touches it may be stale. Like a patched file's sites, a patched file has none.
      const stored = observe(await base.relations(id, options)).filter((record) => !patch.has(record.source_path) && !patch.has(record.to.path));
      return result(stored);
    },

    async callers(id, options) {
      const hops = clampDepth(options?.hops);
      const startKey = symbolKey(id);
      const expanded = new Set<string>();
      const seen = new Set<string>();
      const out: CallerRecord[] = [];
      let frontier: SymbolIdentity[] = [id];
      for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
        const found = new Map<string, SymbolIdentity>();
        const records: CallerRecord[] = [];
        for (const callee of frontier) {
          const calleeKey = symbolKey(callee);
          if (expanded.has(calleeKey)) continue;
          expanded.add(calleeKey);
          for (const ref of await refsOf(callee, options)) {
            if (ref.kind !== 'call' || ref.enclosing === undefined || ref.enclosing === null) continue;
            const callerKey = symbolKey(ref.enclosing);
            if (seen.has(callerKey)) continue;
            records.push({
              source_path: ref.source_path,
              span: ref.span,
              extractor: ref.extractor,
              content_hash: ref.content_hash,
              first_seen: ref.first_seen,
              last_seen: ref.last_seen,
              confidence: ref.confidence,
              debug: ref.debug,
              caller: ref.enclosing,
              callee,
              hops: hop,
              tier: ref.tier,
            });
            found.set(callerKey, ref.enclosing);
          }
        }
        records.sort(bySite);
        out.push(...records);
        // The start symbol is reported only at hop 1, where a self call is a real caller; a caller is reported once.
        if (hop === 1) seen.add(startKey);
        for (const key of found.keys()) seen.add(key);
        frontier = [...found.values()];
      }
      return result(out);
    },

    async importers(target, options) {
      const depth = clampDepth(options?.depth);
      const wanted = path.posix.normalize(target);
      // The files `target` names in the merged view: the path itself or, written without its extension, the paths it stems.
      const startPaths = new Set<string>();
      for (const candidate of [wanted, ...extensions.map((extension) => wanted + extension)]) {
        if ((await factsOf(candidate)) !== null) startPaths.add(candidate);
      }
      for (const [patched, facts] of patch) if (facts !== null && stemOf(patched) === wanted) startPaths.add(patched);

      const seen = new Set<string>();
      const out: ImporterRecord[] = [];
      let frontier: readonly string[] = [...startPaths];
      for (let hop = 1; hop <= depth && (frontier.length > 0 || hop === 1); hop += 1) {
        const edges = new Map<string, ImporterRecord>();
        // The store's statements that reach the frontier, except those of files the patch replaces.
        for (const file of hop === 1 ? [wanted, ...frontier.filter((each) => each !== wanted)] : frontier) {
          for (const record of observe(await base.importers(file, { depth: 1 }))) {
            if (patch.has(record.importer) || seen.has(record.importer)) continue;
            edges.set(record.debug, { ...record, hops: hop });
          }
        }
        // The patched files' statements that reach it.
        const reached = new Set(frontier);
        for (const facts of patch.values()) {
          if (facts === null || seen.has(facts.path)) continue;
          for (const [ord, imp] of facts.imports.entries()) {
            const named = await resolveImport(facts.path, imp.path);
            if (!named.some((candidate) => reached.has(candidate))) continue;
            edges.set(`imp/${encodeURIComponent(facts.path)}/${facts.contentHash}/${String(ord)}`, {
              source_path: facts.path,
              span: imp.span,
              extractor: extractorOf(facts.module, facts.grammarVersion),
              content_hash: facts.contentHash,
              first_seen: now,
              last_seen: now,
              confidence: named.length === 1 ? 'EXTRACTED' : 'INFERRED',
              debug: `imp/${encodeURIComponent(facts.path)}/${facts.contentHash}/${String(ord)}`,
              importer: facts.path,
              specifier: imp.path,
              hops: hop,
              ...(imp.style === undefined ? {} : { style: imp.style }),
            });
          }
        }
        const records = [...edges.values()].sort(
          (a, b) => compareCodeUnits(a.importer, b.importer) || a.span.startLine - b.span.startLine || a.span.startColumn - b.span.startColumn,
        );
        out.push(...records);
        if (hop === 1) {
          seen.add(wanted);
          for (const file of startPaths) seen.add(file);
        }
        const found = new Set(records.map((record) => record.importer));
        for (const file of found) seen.add(file);
        frontier = [...found];
      }
      return result(out.slice(0, limitOf(options?.limit, Number.POSITIVE_INFINITY)));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The follower's fresh port.
// ---------------------------------------------------------------------------------------------------------

export interface FollowerFreshDeps {
  readonly tree: SourceTree;
  readonly modules: ModuleHost;
  /** Read-only: the follower asks the store for readers and nothing else. */
  readonly store: Pick<FactStore, 'at'>;
  readonly clock: Clock;
  /** How many more times a file that changed while it was read is read again (the Indexer's `maxRaceRetries`). */
  readonly maxRaceRetries: number;
  /** The repo name the store puts in symbol identities (its `repo` option; by default the store directory's name). */
  readonly repo: string;
  /** Files larger than this are not read. Default: the Indexer's `maxFileBytes`. */
  readonly maxFileBytes?: number;
}

/** What `lstat` said about a file: enough to tell that its bytes may have changed. */
interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

async function stampOf(worktree: string, rel: string): Promise<Stamp | undefined> {
  try {
    const stat = await fs.promises.lstat(path.join(worktree, rel));
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
  } catch {
    return undefined;
  }
}

const sameStamp = (a: Stamp | undefined, b: Stamp | undefined): boolean =>
  a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

/** The lower-case extension of the last path segment, with its dot, or '' (`.gitignore` has none). Source Tree's rule. */
function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** The fresh port of a process that does not hold the writer lease. */
export function createFollowerFresh(deps: FollowerFreshDeps): FreshPort {
  const maxBytes = deps.maxFileBytes ?? DEFAULT_INDEXER_CONFIG.maxFileBytes;

  async function ensureFresh(worktree: string, paths: readonly string[], waitMs: number): Promise<FreshReport> {
    // The wait starts now, before anything is awaited, so a caller that advances the clock right away is counted.
    let cancelWait: () => void = noop;
    const timedOut = new Promise<'timeout'>((resolve) => {
      cancelWait = deps.clock.after(waitMs, () => {
        resolve('timeout');
      });
    });
    try {
      const root = await realRoot(worktree);
      const invalid: string[] = [];
      const valid = new Set<string>();
      const seen = new Set<string>();
      for (const rel of paths) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        // Refused here, before any read or hash: agent-supplied strings never reach the file system unchecked (T-02-84).
        if (root !== undefined && isRepoRelative(rel) && (await staysInside(root, rel))) valid.add(rel);
        else invalid.push(rel);
      }
      const sorted = [...valid].sort(compareCodeUnits);
      if (sorted.length === 0) return { complete: true, stalePaths: [], invalid };

      const base = deps.store.at(worktree);
      // The Indexer's own ignore filter, made for this request alone (a follower keeps no memory between requests): a path
      // the Indexer would not index is not indexed here either (quick task 261021-re7; this also closes the same gap for
      // `.gitignore`, which the follower never consulted).
      const filter = createPathFilter(deps.tree);
      // `patch` and `settled` are what the work has decided so far; `closed` stops a late finisher from touching them.
      const patch = new Map<string, FileFacts | null>();
      const settled = new Set<string>();
      let closed = false;

      /** Hide the store's facts for `rel` when it holds any; a path the store never held needs no entry. */
      const hide = async (rel: string): Promise<void> => {
        const stored = await base.fileFacts(rel);
        if (closed) return;
        if (stored.data !== null) patch.set(rel, null);
        settled.add(rel);
      };

      /** One pass over `rels`; returns those whose file changed under the read (to be read again). */
      const attempt = async (rels: readonly string[]): Promise<string[]> => {
        const claimed = new Set(deps.modules.extensions());
        const ofModules = rels.filter((rel) => claimed.has(extensionOf(rel)));
        for (const rel of rels) if (!claimed.has(extensionOf(rel))) await hide(rel);
        // A path under a built-in default, named by `.atlasignore` or `.gitignore`, or that is not a regular file takes the
        // route of a path that stopped being source: the store's facts for it are hidden and it is settled.
        const verdict = ofModules.length === 0 ? { kept: [] as string[], dropped: [] as string[] } : await filter.keep(worktree, ofModules);
        for (const rel of verdict.dropped) await hide(rel);
        const wanted = [...verdict.kept].sort(compareCodeUnits);
        if (wanted.length === 0) return [];

        const stamps = new Map<string, Stamp | undefined>();
        for (const rel of wanted) stamps.set(rel, await stampOf(worktree, rel));
        const hashed = await deps.tree.hashPaths(worktree, wanted);
        const set =
          hashed.files.size === 0
            ? undefined
            : await deps.tree.sourceSet(worktree, hashed.files, { extensions: [...claimed], maxBytes });
        const survivors = set?.files ?? new Map<string, string>();
        const tooLarge = new Set(
          (set?.skipped ?? [])
            .filter((d) => d.code === SOURCE_TREE_CODES.sourceTooLarge && d.subject !== undefined)
            .map((d) => d.subject as string),
        );

        const raced: string[] = [];
        for (const rel of wanted) {
          if (closed) return raced;
          const hash = survivors.get(rel);
          if (tooLarge.has(rel)) continue; // stays unsettled: reported stale, the store's facts keep serving
          if (hash === undefined) {
            await hide(rel); // gone, or no longer source (binary, generated, vendored, an LFS pointer)
            continue;
          }
          if (!sameStamp(stamps.get(rel), await stampOf(worktree, rel))) {
            raced.push(rel);
            continue;
          }
          const read = await deps.tree.readText(worktree, rel, { maxBytes });
          if (read.kind === 'too_large') continue;
          if (read.kind !== 'ok') {
            await hide(rel);
            continue;
          }
          // The stamp after the read must equal the stamp before the hash, or the text may not be what was hashed.
          if (!sameStamp(stamps.get(rel), await stampOf(worktree, rel))) {
            raced.push(rel);
            continue;
          }
          const extracted = await deps.modules.extract(rel, read.text, hash);
          if (extracted.kind === 'unclaimed') {
            await hide(rel);
            continue;
          }
          if (extracted.kind === 'failed') continue; // stays unsettled: reported stale
          const stored = await base.fileFacts(rel);
          if (closed) return raced;
          // The store already holds exactly this file (the leader indexed the edit): it is the authority, no patch.
          if (stored.data?.contentHash !== hash) patch.set(rel, extracted.facts);
          settled.add(rel);
        }
        return raced;
      };

      const work = (async (): Promise<void> => {
        let remaining: readonly string[] = sorted;
        for (let retry = 0; remaining.length > 0 && !closed; retry += 1) {
          remaining = await attempt(remaining);
          if (retry >= deps.maxRaceRetries) break;
        }
      })();
      // After a timeout the work carries on in the background; its failure must not become an unhandled rejection.
      await Promise.race([work.then(noop, noop), timedOut]);
      closed = true;

      // Anything the work did not settle (timed out, failed to parse, never stopped changing) is stale: the store's
      // facts for it keep serving and Query marks the answer.
      const stalePaths = sorted.filter((rel) => !settled.has(rel));
      const frozen: Patch = new Map(patch);
      const reader =
        frozen.size === 0
          ? undefined
          : createOverlayReader(base, frozen, { repo: deps.repo, clock: deps.clock, extensions: deps.modules.extensions() });
      return {
        complete: stalePaths.length === 0,
        stalePaths,
        invalid,
        ...(reader === undefined ? {} : { reader }),
      };
    } finally {
      cancelWait();
    }
  }

  return { ensureFresh };
}
