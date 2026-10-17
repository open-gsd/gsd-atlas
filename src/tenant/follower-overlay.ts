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
 * patch's facts instead of the store's (a deleted or unreadable path hides the store's facts for it).
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  CallerRecord,
  CallersOptions,
  FactStore,
  FindOptions,
  ImporterRecord,
  ImportersOptions,
  Reader,
  RefRecord,
  ResolveOptions,
  SymbolRecord,
} from '../fact-store/index.ts';
import { symbolKey } from '../facts/index.ts';
import type { Answer, Clock, DegradedCode, FileFacts, LocalSymbol, SymbolIdentity, Watermark } from '../facts/index.ts';
import { DEFAULT_INDEXER_CONFIG, isRepoRelative, realRoot, staysInside } from '../indexer/index.ts';
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

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const noop = (): void => {};

const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const extractorOf = (module: string, grammarVersion: string): string => `grammar:${module}@${grammarVersion}`;

/** One definition of a patched file, with the record the store would hold for it. */
interface Definition {
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

const laterOf = (a: Watermark, b: Watermark): Watermark => (b.seq > a.seq ? b : a);

/** The degraded codes of `answers` plus `follower`: every answer of the overlay says it came from a follower. */
function degradedOf(...answers: ReadonlyArray<Answer<unknown>>): readonly DegradedCode[] {
  const codes = new Set<DegradedCode>(['follower']);
  for (const answer of answers) for (const code of answer.degraded ?? []) codes.add(code);
  return [...codes];
}

/** A follower's answer: the data, the later of the two watermarks and the degraded codes. */
function answerOf<T>(data: T, watermark: Watermark, ...from: ReadonlyArray<Answer<unknown>>): Answer<T> {
  return { data, watermark, degraded: degradedOf(...from) };
}

/** `limit` as a whole number of rows, or all of them when absent. */
function limitOf(limit: number | undefined, fallback: number): number {
  return limit === undefined || Number.isNaN(limit) ? fallback : Math.max(0, Math.floor(limit));
}

function nameMatches(mode: NonNullable<FindOptions['mode']>, query: string, name: string): boolean {
  if (mode === 'prefix') return name.startsWith(query);
  if (mode === 'fuzzy') return asciiLower(name).includes(asciiLower(query));
  return name === query;
}

/**
 * The Reader of one request: `base` (the store's reader) with `patch` laid over it. The whole Reader interface is
 * implemented by merging; every record the overlay creates carries the shape of the store's records.
 */
export function createOverlayReader(base: Reader, patch: Patch, context: OverlayContext): Reader {
  const now = context.clock.now();
  const { repo } = context;

  /** The store's facts of a patched path, once: needed for the hiding rules and for the answer's watermark. */
  const baseProbes = new Map<string, Promise<Answer<FileFacts | null>>>();
  const probeBase = (filePath: string): Promise<Answer<FileFacts | null>> => {
    let probe = baseProbes.get(filePath);
    if (probe === undefined) {
      probe = base.fileFacts(filePath);
      baseProbes.set(filePath, probe);
    }
    return probe;
  };

  const patchedDefinitions = (): Definition[] => {
    const out: Definition[] = [];
    for (const facts of patch.values()) if (facts !== null) out.push(...definitionsOf(facts, repo, now));
    return out;
  };

  return {
    async find(name, options) {
      const mode = options?.mode ?? 'exact';
      if (name === '' || (mode === 'fuzzy' && name.length < MIN_FUZZY_CHARS)) {
        return answerOf([], (await base.find(name, options)).watermark);
      }
      const wanted = limitOf(options?.limit, mode === 'exact' ? Number.POSITIVE_INFINITY : DEFAULT_FIND_LIMIT);
      // The store truncates before the merge, so it is asked for enough rows to survive dropping the patched paths'.
      let hidden = 0;
      const probes = await Promise.all([...patch.keys()].map((filePath) => probeBase(filePath)));
      for (const probe of probes) hidden += probe.data?.symbols.length ?? 0;
      const baseOptions: FindOptions = {
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
        ...(Number.isFinite(wanted) ? { limit: wanted + hidden } : {}),
      };
      const stored = await base.find(name, baseOptions);

      const rows: SymbolRecord[] = stored.data.filter((record) => !patch.has(record.source_path));
      for (const definition of patchedDefinitions()) {
        if (nameMatches(mode, name, definition.symbol.name)) rows.push(definition.record);
      }
      rows.sort(
        (a, b) =>
          compareCodeUnits(a.source_path, b.source_path) ||
          a.span.startLine - b.span.startLine ||
          a.span.startColumn - b.span.startColumn,
      );
      return answerOf(rows.slice(0, wanted), stored.watermark, stored);
    },

    async symbol(id) {
      if (!patch.has(id.path)) {
        const stored = await base.symbol(id);
        return answerOf(stored.data, stored.watermark, stored);
      }
      const probe = await probeBase(id.path);
      const facts = patch.get(id.path) ?? null;
      const found =
        facts === null || id.repo !== repo
          ? null
          : (definitionsOf(facts, repo, now).find((definition) => symbolKey(definition.identity) === symbolKey(id))?.record ?? null);
      return answerOf(found, probe.watermark, probe);
    },

    async fileFacts(filePath) {
      if (!patch.has(filePath)) {
        const stored = await base.fileFacts(filePath);
        return answerOf(stored.data, stored.watermark, stored);
      }
      const probe = await probeBase(filePath);
      return answerOf(patch.get(filePath) ?? null, probe.watermark, probe);
    },

    // Task 2 merges these; until then they read the store unchanged.
    async refs(id: SymbolIdentity, options?: ResolveOptions) {
      const stored = await base.refs(id, options);
      return answerOf<readonly RefRecord[]>(stored.data, stored.watermark, stored);
    },
    async callers(id: SymbolIdentity, options?: CallersOptions) {
      const stored = await base.callers(id, options);
      return answerOf<readonly CallerRecord[]>(stored.data, stored.watermark, stored);
    },
    async importers(target: string, options?: ImportersOptions) {
      const stored = await base.importers(target, options);
      return answerOf<readonly ImporterRecord[]>(stored.data, stored.watermark, stored);
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
    let cancelWait: () => void = () => {};
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
      // `patch` and `stale` are what the work has settled so far; `closed` stops a late finisher from touching them.
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

      /** One pass over `rel`s; returns those whose file changed under the read (to be read again). */
      const attempt = async (rels: readonly string[]): Promise<string[]> => {
        const claimed = new Set(deps.modules.extensions());
        const wanted = rels.filter((rel) => claimed.has(extensionOf(rel)));
        for (const rel of rels) if (!claimed.has(extensionOf(rel))) await hide(rel);
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
      work.catch(() => {});
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
