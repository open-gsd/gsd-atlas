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
  DegradedCode,
  Diagnostic,
  FileFacts,
  ImportStyle,
  NoticingResolverPort,
  ProjectContextProvider,
  RefKind,
  RefSiteKey,
  RelationKind,
  ResolutionContext,
  Span,
  SymbolIdentity,
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

/**
 * A relation between two symbols that the compiler reported (plan 03-25): `from` extends or implements `to`, or the member
 * `from` overrides the member `to`. It is always precise and `EXTRACTED`. The provenance is the subtype's: `source_path` and
 * `span` are the definition of `from`, which is where the relation is written, and `debug` is the relation's own handle.
 */
export interface RelationRecord extends Provenance {
  readonly from: SymbolIdentity;
  readonly to: SymbolIdentity;
  readonly relation: RelationKind;
  readonly tier: 'precise';
}

/** What kind of fact a handle names (plan 03-26): a definition, a reference site, an import or export statement, or a compiler relation. */
export type FactKind = 'symbol' | 'reference' | 'import' | 'export' | 'relation';

/**
 * What the resolved-edge cache says about a reference site (or a relation) under the current overlay snapshot and resolution
 * context: a precise edge is stored (`hit`), the resolver was asked and found none (`asked_no_edge`), it could be asked and
 * was not yet (`not_asked`), or no resolver can answer for it (`not_applicable`).
 */
export type CacheState = 'hit' | 'asked_no_edge' | 'not_asked' | 'not_applicable';

/**
 * The explanation of one fact (plan 03-26, QRY-07). Every string is a fixed word, a version, a hash, a count or fact data
 * (a path, a name, a kind); nothing in it is repository prose.
 */
export interface FactExplanation {
  /** The handle in its canonical form. */
  readonly handle: string;
  readonly kind: FactKind;
  readonly fact: {
    /** The extractor that produced it: `grammar:<module>@<version>`, or `precise:<resolver>`. */
    readonly extractor: string;
    readonly tier: 'grammar' | 'precise';
    readonly confidence: Confidence;
    readonly module: string;
    /** The grammar version the file's facts were extracted at. */
    readonly grammarVersion: string;
    /** The grammar version the module reports now, when it differs from `grammarVersion`; set by Query, never by the store. */
    readonly currentGrammarVersion?: string;
    /** True when a newer grammar replaced the one that extracted this file (its facts still serve, flagged stale). */
    readonly stale: boolean;
    readonly path: string;
    /** Git blob id of the file version. */
    readonly contentHash: string;
    readonly firstSeen: number;
    readonly lastSeen: number;
    readonly span: Span;
  };
  /** The resolution under which a reference or relation was looked up; null for a definition, an import and an export. */
  readonly resolution: {
    readonly contextId: string;
    readonly configHashCount: number;
    /** The id of the overlay snapshot (a hash of the sorted path and content hash pairs) the cache was read under. */
    readonly snapshot: string;
    readonly cache: CacheState;
    /** The resolver that produced a stored edge or relation. */
    readonly resolver?: string;
    /** Where a stored edge or relation points. */
    readonly target?: { readonly name: string; readonly kind: string; readonly path: string };
  } | null;
  readonly overlay: {
    /** The base name of the worktree: never its absolute path. */
    readonly worktree: string;
    /** The overlay's watermark sequence number. */
    readonly seq: number;
    /** How many paths of the overlay are pending or hold facts a newer grammar replaced. */
    readonly stalePaths: number;
  };
}

/** Which relations of a symbol a read returns. */
export type RelationDirection = 'in' | 'out' | 'both';

export interface RelationsOptions extends ResolveOptions {
  /**
   * `in`: the relations whose `to` is the symbol (its subtypes, its implementers, the members that override it). `out`: the
   * relations whose `from` is the symbol and, for a class or an interface, the `overrides` of its members (its
   * supertypes). `both` is the two together. Default `both`.
   */
  readonly direction?: RelationDirection;
  /** Truncate after ordering by relation kind, then subtype path and position. */
  readonly limit?: number;
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

  /**
   * The `extends`, `implements` and `overrides` relations of a symbol that the compiler reported (plan 03-25, OQ1). They
   * come from the resolver's optional `relations` method, are cached per overlay snapshot and resolution context, and are
   * read lazily: the store asks only for the files that can contribute (the file of the symbol for its supertypes; the
   * files that hold a heritage reference to it, or to its container for a member, for its subtypes), within
   * `options.timeoutMs`. A resolver without the method gives empty data and no degraded code; a timeout, a failure and a
   * cache that cannot be written degrade the answer exactly as for `refs`, and the computation carries on in the
   * background. A relation whose endpoints the overlay does not hold is never returned.
   */
  relations(id: SymbolIdentity, options?: RelationsOptions): Promise<Answer<readonly RelationRecord[]>>;

  /** One symbol by identity; `data` is null when it does not exist in this overlay. */
  symbol(id: SymbolIdentity): Promise<Answer<SymbolRecord | null>>;

  /**
   * Why a fact is what it is (plan 03-26, QRY-07): the explanation of the fact a `debug` handle names. The handle is parsed
   * here and nowhere else, and looked up by (path, file content hash, ordinal) in this overlay only. `data` is null for a
   * handle that is malformed, longer than 2,048 characters, for a path the overlay does not hold, or for an ordinal that is
   * not a fact of that file; it is `'stale'` for a path the overlay holds at another file version. It reads what is already
   * stored (the file row, the fact row, the resolved-edge and relation caches): it never runs a resolver and never writes.
   */
  provenance(handle: string): Promise<Answer<FactExplanation | 'stale' | null>>;

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

  /**
   * Where the project's compiler writes the output of the source at `path` (TSM-03): repository-relative POSIX paths,
   * code first, then declaration files. Empty for a path the overlay does not hold, a file no config includes, a
   * store with no project context provider and a provider that failed. The output files themselves need not be in
   * the overlay (they are usually ignored or dropped as emit outputs).
   */
  emittedAs(path: string): Promise<Answer<readonly string[]>>;
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
  /**
   * `compact` only, internal to `maintain`: a collect in this same call deleted files. It stands in for the
   * in-page measurement when this SQLite build has no `dbstat` table (the full request then vacuums after churn).
   * Not part of the public contract; callers outside the store leave it unset.
   */
  readonly afterChurn?: boolean;
}

/**
 * What `maintain` is asked to do beyond the default upkeep (STO-05, D-16). A full compaction is requested for the
 * compact step; it still vacuums only past the recorded thresholds, and only after the collect step of the same
 * call finished.
 */
export interface StoreMaintainOptions {
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

/** What {@link FactStore.resolve} is asked: the time box, and how many sites one resolver call may carry. */
export interface ResolveBatchOptions extends MaintenanceOptions {
  /**
   * The most reference sites one resolver call is given. Default 2000, the approved `precise.sitesPerRequest`. A whole
   * number of at least 1.
   */
  readonly batchSize?: number;
}

/**
 * Outcome of the eager resolution pass (plan 03-29). `processed` is the number of reference sites the resolver was asked
 * about in this call (a site that was settled before is not counted). `complete` is false when the time box ran out or the
 * resolver failed; the call can be repeated and resumes where the last one stopped.
 */
export interface ResolveResult extends MaintenanceResult {
  /** Sites asked in this call (the same number as `processed`). */
  readonly asked: number;
  /** Of those, the sites for which the resolver produced an edge the store kept. */
  readonly answered: number;
  /**
   * The degraded codes the resolver or the cache produced while the pass ran: a failure (`resolver_failed`,
   * `memory_budget`, `cache_unavailable`) that stopped the pass, or a state (`compiler_fallback`, `precise_unavailable`).
   */
  readonly degraded: readonly DegradedCode[];
  /**
   * Why an incomplete call stopped: `budget` (the time box ran out; the pass is only late) or `failure` (the resolver or the
   * cache failed; `degraded` names the code, and repeating the call asks again). Absent when `complete`.
   */
  readonly stopped?: 'budget' | 'failure';
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
  /** How many paths the worktree's overlay holds, pending ones included (`stalePaths` is a subset of them). */
  readonly files: number;
}

/** Store health, as its own method rather than a read variant. */
export interface StoreStatus {
  readonly schemaVersion: number;
  readonly worktrees: readonly WorktreeStatus[];
  readonly sizeBytes: number;
  /** Whether this process holds the writer lease. */
  readonly writerLeaseHeld: boolean;
  /**
   * Who holds the writer lease: this process when it holds it, otherwise what the holder wrote to `lease.json`.
   * Absent when the file is unreadable (no holder, or one that has not written yet) and when the store has no lease.
   * Diagnostics only, to name the process in a message; never used to decide who owns the lease.
   */
  readonly leaseHolder?: { readonly pid: number; readonly startedAt: number; readonly version: string };
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

  /**
   * The eager resolution pass (plan 03-29, research Pattern 10; amends ADR 7): ask the resolver about the reference sites of
   * `worktree`'s overlay, in path order and in batches of at most `options.batchSize`, validate the answers the way a read
   * does, and store the edges and the asked markers, so the first read after a build is a cache hit. It is time-boxed
   * (`options.budgetMs`, checked between batches; at least one batch runs per call), resumable (a cursor in `meta`, keyed by
   * overlay snapshot and resolution context, and the asked markers) and idempotent (a settled snapshot asks nothing).
   * Needs write authority like the other tasks: a follower gets `WriterBusy`. Throws `UnknownWorktree` for a worktree nobody
   * built. A resolver that fails never throws: the pass stops and reports the code in `degraded`.
   */
  resolve(worktree: WorktreeId, options: ResolveBatchOptions): Promise<ResolveResult>;

  /** Integrity check. */
  check(): Promise<CheckResult>;

  /**
   * A thin wrapper for the daemon's idle loop. Takes the writer lease itself. `IDLE_MAINTENANCE` asks for the
   * idle policy: a full compaction once the collect step finished and the file is past the vacuum thresholds.
   */
  maintain(budgetMs: number, options?: StoreMaintainOptions): Promise<MaintenanceResult>;

  status(): Promise<StoreStatus>;

  close(): Promise<void>;
}

/**
 * The injected resolver port: binds reference sites to target definitions. It reads symbols back through the
 * read-only `SymbolLookup` the store passes in, never through the store itself, and is told where it resolves
 * through the optional fourth `scope` argument (worktree, overlay snapshot, project context). Yields
 * `EXTRACTED` edges, and may yield notices among them: a `{ kind: 'notice', degraded }` adds that code to the answer
 * without failing the read (plan 03-23), and an error thrown with a `degradedCode` makes the answer carry that code
 * instead of `resolver_failed`. It is the kernel's `NoticingResolverPort`; every `ResolverPort`, including a resolver
 * written for the earlier three-argument shape, is assignable to it and keeps working.
 */
export type Resolver = NoticingResolverPort;

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
  /**
   * Computes the project context (the resolution context plus what a resolver needs to know about the project)
   * of one overlay snapshot, asynchronously. Called at most once per (worktree, snapshot id); cached edges are
   * keyed by the context it returns. Default: id `grammar`, no config hashes.
   */
  readonly projectContext?: ProjectContextProvider;
  /**
   * @deprecated Use `projectContext`. The synchronous resolution context of the current configuration, read on
   * every resolving read (it is not memoised, so it may change between calls). Ignored when `projectContext` is given.
   */
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
