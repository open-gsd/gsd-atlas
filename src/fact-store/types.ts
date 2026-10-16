/**
 * The frozen Fact Store interface: types and documented semantics only (FND-05, D-09). There is no
 * implementation and no fake here. The real store arrives in Phase 2 (STO-01 to STO-10); its tests run real
 * SQLite in a temp dir with a fake clock and a fake `gitHas`, through this interface only
 * (fact-store-interface ADR decision 8).
 *
 * The seam is fact-level, not SQL: callers never see a table, a connection or a driver.
 */
import type {
  Answer,
  Clock,
  Confidence,
  Diagnostic,
  FileFacts,
  ImportStyle,
  RefKind,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  Span,
  SymbolIdentity,
  SymbolLookup,
} from '../facts/index.ts';

/** Names one worktree overlay of a repo (a checkout, or a branch overlay without a checkout). */
export type WorktreeId = string;

/**
 * Which resolution tier produced an edge (fact-store-interface ADR decision 4).
 * `precise` is a compiler or SCIP result (worktree overlays only); `base_commit` is a precise result mapped
 * from the base commit by symbol identity (branch overlays without a checkout); `grammar` is a name-only
 * match from the grammar tier and is always `INFERRED`.
 */
export type Tier = 'precise' | 'base_commit' | 'grammar';

/**
 * Provenance in gsd-graph's shape, on every fact (fact-model ADR decision 3). `span` is mandatory: a fact
 * without a span cannot exist. Times are `Clock.now()` milliseconds.
 */
export interface Provenance {
  readonly source_path: string;
  readonly span: Span;
  /** The extractor that produced the fact, for example `grammar:typescript@0.23.2` or `precise:typescript@6.0.3`. */
  readonly extractor: string;
  /** Git blob id of the file version the fact came from. */
  readonly content_hash: string;
  readonly first_seen: number;
  readonly last_seen: number;
  readonly confidence: Confidence;
  /** Opaque handle that `gsd-atlas explain` resolves. Callers pass it through and never parse it. */
  readonly debug: string;
}

/** A definition. `version` is the symbol's content hash; it is NOT part of its identity (fact-model decision 6). */
export interface SymbolRecord extends Provenance {
  readonly identity: SymbolIdentity;
  readonly version: string;
  /** Set when a rename or move was detected with a matching signature (A45). */
  readonly renamed_from?: SymbolIdentity;
  /** True when the definition is visible outside its file; absent when the extractor did not say. */
  readonly exported?: boolean;
}

/** A reference to a symbol. `target` is null for a site no tier could resolve. */
export interface RefRecord extends Provenance {
  readonly site: RefSiteKey;
  readonly target: SymbolIdentity | null;
  readonly tier: Tier;
  /** What the site does with the name (call, new, read, type, heritage or member); absent when the extractor did not say. */
  readonly kind?: RefKind;
  /** The innermost symbol that contains the site; `null` for a top-level site, absent when not known. */
  readonly enclosing?: SymbolIdentity | null;
  /**
   * Set only when the site could point at more than one definition (a specifier that matches two files, two
   * same-named definitions in scope): the number of alternatives, and every one of them receives the site.
   * Absent when exactly one definition is in scope. Nothing is guessed (LNG-03).
   */
  readonly candidates?: number;
}

/**
 * A file that imports another file. `importer` is the importing file's path, `specifier` the import path as
 * written, and `hops` how many import steps away it is (1 for a direct import). The edge from specifier to
 * file is a path match, so it is `INFERRED`; the import statement itself is the cited span.
 */
export interface ImporterRecord extends Provenance {
  readonly importer: string;
  readonly specifier: string;
  readonly style?: ImportStyle;
  readonly hops: number;
}

export interface ImportersOptions {
  /**
   * How many import hops to walk. Default 1, clamped to 1 to 5. Each importing file is reported once, at the
   * hop where it is first found; a cycle terminates.
   */
  readonly depth?: number;
  /** Truncate after ordering by hop, then importer path, then position. */
  readonly limit?: number;
}

/** A call edge, `hops` calls away from the symbol asked about. */
export interface CallerRecord extends Provenance {
  readonly caller: SymbolIdentity;
  readonly callee: SymbolIdentity;
  readonly hops: number;
  readonly tier: Tier;
}

export type FindMode = 'exact' | 'prefix' | 'fuzzy';

export interface FindOptions {
  /**
   * Default `exact`. `prefix` matches names that start with the query (case-sensitive). `fuzzy` matches names
   * that contain the query, case-insensitively for ASCII; a query shorter than three characters returns no
   * rows. An empty query returns no rows in every mode.
   */
  readonly mode?: FindMode;
  /** Truncate after ordering by path, line, column and definition order. `prefix` and `fuzzy` default to 50. */
  readonly limit?: number;
}

export interface ResolveOptions {
  /**
   * Bound on resolver latency for this call, in milliseconds. Query passes about 1500. See `Reader.refs`.
   */
  readonly timeoutMs?: number;
}

export interface CallersOptions extends ResolveOptions {
  /**
   * How many call hops to walk. Default 1, clamped to 1 to 5; atlas queries are one or two hops. Each caller
   * is reported once, at the hop where it is first found; a cycle terminates.
   */
  readonly hops?: number;
}

/**
 * A read-only view of one worktree overlay: cheap, lock-free, on a read-only connection.
 *
 * Every method returns `Answer<T>`: `{ data, watermark, degraded? }`. Reads report `stalePaths` in the
 * watermark and never wait for pending index work (read-your-writes is `Indexer.ensureFresh`, which Query
 * calls before it reads).
 *
 * Reads never throw for missing data: they return empty `data` with a `degraded` code. They throw only
 * `UnknownWorktree` and `StoreClosed`.
 */
export interface Reader {
  /** Find definitions by name. */
  find(name: string, options?: FindOptions): Promise<Answer<readonly SymbolRecord[]>>;

  /**
   * References to a symbol, each tagged with the tier that produced its edge.
   *
   * There is no `warm(worktree)` (D-17). Resolution is lazy: the first call per overlay snapshot and
   * resolution context pays resolver latency. That latency is bounded by `options.timeoutMs`. When it
   * overruns, the answer carries grammar-tier `INFERRED` edges and `degraded: ['resolver_timeout']` while the
   * computation continues in the background. When the resolver fails outright, the answer carries the same
   * edges and `degraded: ['resolver_failed']`; a resolver failure is never an error.
   *
   * Cache fills are done by the writer-lease holder (D-16). A reader in a process without the lease computes
   * and returns uncached results with `degraded: ['cache_unavailable']`; it never writes the cache itself.
   */
  refs(id: SymbolIdentity, options?: ResolveOptions): Promise<Answer<readonly RefRecord[]>>;

  /**
   * Callers of a symbol, `options.hops` calls deep. Resolver latency, the `timeoutMs` bound, the
   * `resolver_timeout`, `resolver_failed` and `cache_unavailable` degradations, and the absence of `warm`
   * are exactly as for `refs`.
   */
  callers(id: SymbolIdentity, options?: CallersOptions): Promise<Answer<readonly CallerRecord[]>>;

  /** One symbol by identity; `data` is null when it does not exist in this overlay. */
  symbol(id: SymbolIdentity): Promise<Answer<SymbolRecord | null>>;

  /** The local facts of one file as the overlay sees it; `data` is null when the path is not in the overlay. */
  fileFacts(path: string): Promise<Answer<FileFacts | null>>;

  /**
   * The files of this overlay that import `path`, `options.depth` import steps deep. A relative import
   * specifier, resolved against the importing file's directory with POSIX normalisation, names the files the
   * specifier rule matches (exact path, extension-stripped path, extension-stripped specifier, directory index
   * file); a specifier that names exactly one file is `EXTRACTED`, one that names several is `INFERRED` and
   * the importer appears for each of them. Non-relative specifiers never match. Ordered by hop, then importer
   * path, then position; no match is empty data.
   */
  importers(path: string, options?: ImportersOptions): Promise<Answer<readonly ImporterRecord[]>>;
}

export interface CommitFileInput {
  readonly worktree: WorktreeId;
  readonly path: string;
  /** Git blob id of the file content the facts were extracted from. */
  readonly hash: string;
  /** The facts, or `null` when the path was deleted. */
  readonly facts: FileFacts | null;
}

export interface CommitResult {
  /**
   * `committed`: the facts are stored and the watermark advanced. `unchanged`: this (worktree, path, hash) was
   * already committed, so nothing changed (idempotent). `rejected`: the facts failed `validateFileFacts`
   * (for example a fact without a span); nothing was written.
   */
  readonly status: 'committed' | 'unchanged' | 'rejected';
  /** The worktree's watermark `seq` after this call. */
  readonly seq: number;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The single writer. `store.writer()` throws `WriterBusy` while another writer holds the lease; call
 * `release()` when done. The Indexer is the only writer client.
 *
 * A reader sees all or none of a file's facts. The watermark `seq` is monotonic per worktree and advances
 * only after a commit.
 */
export interface Writer {
  /**
   * Store one file's facts in one transaction: upsert the facts by hash, remap the overlay, retire the
   * previous hash if nothing else references it, assign symbol identity (with `renamed_from`), invalidate
   * only the affected resolved-edge slice and advance the watermark.
   *
   * Idempotent on (worktree, path, hash). Facts are checked with `validateFileFacts` first; a fact without a
   * span is rejected (`status: 'rejected'`) and nothing is written. The watermark is monotonic per worktree.
   */
  commitFile(input: CommitFileInput): Promise<CommitResult>;

  /**
   * Attach an existing content hash to a path without new facts: branch switches and renames re-use facts
   * the store already holds. `committed` when the path now maps to `hash`; `unchanged` when it already did
   * (idempotent); `rejected` with the diagnostic code `hash_unknown` when the store holds no facts for
   * `hash` (a collected or never-committed hash), in which case nothing is written. Advances the watermark
   * only on `committed`.
   */
  link(worktree: WorktreeId, path: string, hash: string): Promise<CommitResult>;

  /**
   * Replace a worktree overlay: the ref it tracks and its path to content-hash map. Paths missing from the
   * map are removed. A path whose hash has no facts yet is recorded as pending: it has no facts, it is
   * listed in `watermark.stalePaths` of later reads, and a later `commitFile` of that hash clears it in
   * every worktree that was waiting on it. An overlay identical to the stored one changes nothing.
   */
  setOverlay(worktree: WorktreeId, ref: string, pathToHash: ReadonlyMap<string, string>): Promise<void>;

  /** Drop a worktree overlay (the worktree was removed). Its facts are collected later. */
  dropOverlay(worktree: WorktreeId): Promise<void>;

  /**
   * Mark every file extracted by `module` at an older `grammarVersion` as stale, so it is re-indexed lazily
   * while its still-valid facts keep serving with `degraded: ['stale']`. Returns how many files were marked.
   */
  markStale(selector: { readonly module: string; readonly grammarVersion: string }): Promise<number>;

  /** Give up the writer lease. Safe to call twice. */
  release(): void;
}

/** What Source Tree says is true on disk, for `reconcile`. */
export interface ReconcileTruth {
  readonly worktree: WorktreeId;
  readonly pathToHash: ReadonlyMap<string, string>;
}

/** Paths whose stored hash differs from the truth; the Indexer re-indexes them. */
export interface ReconcileResult {
  readonly reindex: readonly string[];
  /** False when the time box ran out; call again to resume. */
  readonly complete: boolean;
}

export interface MaintenanceOptions {
  readonly budgetMs: number;
  /**
   * `compact` only: allow a full `VACUUM` when the free pages are more than a quarter of the file. Without it a
   * full `VACUUM` never runs, because it rewrites the whole file while it holds the writer.
   */
  readonly full?: boolean;
}

/** Outcome of a time-boxed, resumable, idempotent maintenance task. */
export interface MaintenanceResult {
  /** False when the time box ran out; call again to resume. */
  readonly complete: boolean;
  readonly spentMs: number;
  /** Rows or files processed, whatever the task counts. */
  readonly processed: number;
}

export interface CheckResult {
  readonly ok: boolean;
  /** One line per problem found. A failed `quick_check` also moves the file aside and rebuilds (A17). */
  readonly problems: readonly string[];
}

export interface WorktreeStatus {
  readonly worktree: WorktreeId;
  readonly seq: number;
  readonly stalePaths: number;
}

/** Store health, as its own method rather than a read variant. */
export interface StoreStatus {
  readonly schemaVersion: number;
  readonly worktrees: readonly WorktreeStatus[];
  readonly sizeBytes: number;
  /** Whether this process holds the writer lease. */
  readonly writerLeaseHeld: boolean;
  /** Set when corruption was found, the file moved aside and the store rebuilt (A17). */
  readonly rebuiltAfterCorruption?: { readonly movedTo: string; readonly at: number };
}

/**
 * The Fact Store. One module owns local facts, resolved edges, overlays, symbol identity, the
 * live, retired, collected lifecycle, maintenance, staleness, schema-version refusal and watermarks.
 */
export interface FactStore {
  /** A reader for one worktree overlay. Throws `UnknownWorktree` and `StoreClosed` only, at call time. */
  at(worktree: WorktreeId): Reader;

  /** Take the single writer lease. Throws `WriterBusy` when it is held and `StoreClosed` after `close()`. */
  writer(): Writer;

  /** Compare stored hashes with the truth and report the paths to re-index. */
  reconcile(truth: ReconcileTruth): Promise<ReconcileResult>;

  /** Collect retired versions that git no longer needs (`gitHas`), within the budget. */
  collect(options: MaintenanceOptions): Promise<MaintenanceResult>;

  /** Compact the file (incremental vacuum, checkpoint) within the budget. */
  compact(options: MaintenanceOptions): Promise<MaintenanceResult>;

  /** Integrity check. */
  check(): Promise<CheckResult>;

  /** A thin wrapper for the daemon's idle loop. Takes the writer lease itself. */
  maintain(budgetMs: number): Promise<MaintenanceResult>;

  status(): Promise<StoreStatus>;

  close(): Promise<void>;
}

/**
 * The injected resolver port: binds reference sites to target definitions. It reads symbols back through the
 * read-only `SymbolLookup` the store passes in, never through the store itself. Yields `EXTRACTED` edges.
 */
export type Resolver = (
  sites: readonly RefSiteKey[],
  context: ResolutionContext,
  symbols: SymbolLookup,
) => AsyncIterable<ResolvedEdge>;

/** Injected dependencies. Each has a production adapter and a test adapter. */
export interface StoreDeps {
  readonly resolver: Resolver;
  readonly clock: Clock;
  /** Whether git still has this blob; the collection rule of A20. */
  readonly gitHas: (hash: string) => Promise<boolean>;
}

/**
 * Options of the real constructor, `openFactStore` (open.ts). All optional. The SQL engine choice is an
 * extra option of `openFactStore` itself and is deliberately not declared here, so this file stays free of
 * any engine vocabulary.
 */
export interface StoreOptions {
  /** The repo name used in symbol identities. Default: the base name of the store directory. */
  readonly repo?: string;
  /** How long a writer waits on a locked database. Default: the approved `sqlite.busyTimeoutMs`. */
  readonly busyTimeoutMs?: number;
  /** The version of this build, recorded as `meta.created_by` when the store is created. */
  readonly version?: string;
  /**
   * Whether this process may write derived caches (the resolved-edge cache). Plan 02-12 wires it to the
   * writer lease. Default: always true.
   */
  readonly canCache?: () => boolean;
  /** The resolution context of the current configuration (plan 02-11 reads it). Default: id `grammar`, no config hashes. */
  readonly resolutionContext?: () => ResolutionContext;
  /**
   * TEST ONLY. Set `false` to force the bounded LIKE scan for fuzzy find even where the FTS5 trigram
   * capability exists, so tests can compare both paths. It can not switch trigram on where the open-time
   * capability probe found it missing. Default: use the detected capability.
   */
  readonly trigram?: boolean;
  /**
   * How long a retired file version is kept when git does not have its blob (D-16), in milliseconds.
   * Default: the approved `gc.graceMs` (24 hours).
   */
  readonly graceMs?: number;
  /** How many retired files `collect` deletes in one transaction. Default 50; a test override. */
  readonly chunkSize?: number;
  /** The longest single pause `compact` may cause, in milliseconds. Default: the approved `maintenance.sliceMs`. */
  readonly sliceMs?: number;
}

/**
 * The shape of the constructor. Throws `SchemaTooNew` when the store on disk is newer than this build.
 * `openFactStore` (open.ts) is assignable to it: its extra third parameter is optional.
 */
export type OpenStore = (dir: string, deps: StoreDeps) => Promise<FactStore>;
