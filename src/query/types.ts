/**
 * The Query module's public types (query-and-policy ADR decisions 1 to 5, with the Phase 2 amendment).
 *
 * Query is the one place that answers: it owns ranking, the token budget and cursor, citations with debug
 * handles, the nonce-fenced `untrusted_text`, the watermark and the degraded codes. The MCP server, the CLI and
 * the hooks are adapters that hand it a `Request` and return the `Envelope` unchanged.
 */
import type { FactStore, Reader, StoreStatus } from '../fact-store/index.ts';
import type { Clock, DegradedCode, Diagnostic, Envelope, Request } from '../facts/index.ts';
import type { GovernorStatus } from '../governor/index.ts';
import type { SourceTree } from '../source-tree/index.ts';

/**
 * The relation a precise item names in its `edge` field (mcp-contract ADR amendment, point 9): `calls` and `references` come
 * from site resolution, `extends`, `implements` and `overrides` from the compiler's relations. An item from the grammar tier
 * has no `edge` at all: a name match is never presented as any of these.
 */
export type Edge = 'calls' | 'references' | 'extends' | 'implements' | 'overrides';

/** Tunables of Query. Defaults: `DEFAULT_QUERY_CONFIG`. */
export interface QueryConfig {
  /** `budget_tokens` when a request names none (QRY-02). */
  readonly defaultBudgetTokens: number;
  /** The most estimated tokens any response may carry, whatever budget was asked for. */
  readonly hardCeilingTokens: number;
  /** The width every line of `untrusted_text` is cut to, in UTF-16 code units. */
  readonly lineTextMaxChars: number;
  /** How many results a request gets when it names no `limit`. */
  readonly defaultLimit: number;
  /** The most results a request may ask for; a larger `limit` is clamped to this. */
  readonly maxLimit: number;
  /** The longest `more` cursor Query accepts, in characters. */
  readonly cursorMaxChars: number;
  /** How long Query waits for the Indexer when a request names `fresh` paths. */
  readonly ensureFreshWaitMs: number;
  /** The bound Query passes to `Reader.refs`: a resolver slower than this degrades the answer to grammar edges. */
  readonly resolveTimeoutMs: number;
  /** Hops `code_impact` follows when the request names no `depth` (user decision 3). */
  readonly impactDefaultDepth: number;
  /** The most hops `code_impact` follows whatever depth was asked for. */
  readonly impactMaxDepth: number;
  /** The most items one hop of `code_impact` keeps, for each seed; a hop that has more is cut and reported. */
  readonly impactRowCapPerHop: number;
}

/** What the Indexer answers to `ensureFresh` (structural, so Query does not import the Indexer). */
export interface FreshReport {
  /** True when every valid path is stored (or correctly absent) when the call answers. */
  readonly complete: boolean;
  /** Valid paths that are not stored yet. */
  readonly stalePaths: readonly string[];
  /** Paths that were refused without being read. */
  readonly invalid: readonly string[];
  /**
   * A follower's per-request overlay (D-03): the Reader this one request reads through instead of the store's. Absent
   * when the answer needs no overlay, which is every answer of a process that holds the writer lease.
   */
  readonly reader?: Reader;
}

/** The slice of the Indexer that Query uses: read-your-writes for the paths a request names (A26). */
export interface FreshPort {
  ensureFresh(worktree: string, paths: readonly string[], waitMs: number): Promise<FreshReport>;
}

/**
 * The part of the Indexer's status that `atlas_status` reports (structural, so Query does not import the Indexer;
 * the Indexer's own `IndexerStatus` satisfies it). `failed` is only counted: the paths in it are never reported.
 */
export interface IndexerStatusLike {
  readonly queued: number;
  readonly running: number;
  readonly failed: readonly unknown[];
  /** `Clock.now()` after the last commit, or null before any. */
  readonly lastIndexedAt: number | null;
  /** How file events arrive: `native`, `poll` or `reconcile-only`. */
  readonly watchMode: string;
  readonly reconciling: boolean;
  readonly lastReconcile: { readonly at: number } | null;
}

/** One tier of one language module and whether it is active. */
export interface TierActive {
  readonly tier: 'grammar' | 'precise' | 'platform';
  readonly active: boolean;
}

/** The Policy module does not exist until Phase 7, so the mode is `off` until then. */
export type PolicyMode = 'off';

/**
 * The state `atlas_status` reports, read through ports the Host injects. Query reads no repository content to
 * answer it, and the answer carries counts and flags only.
 */
export interface StatusPort {
  store(): Promise<StoreStatus>;
  /** Null when this process runs no Indexer. */
  indexer(): IndexerStatusLike | null;
  governor(): GovernorStatus;
  /** The loaded language modules and their tiers (from the module registry). */
  tiers(): readonly { readonly module: string; readonly tiers: readonly TierActive[] }[];
  policy(): PolicyMode;
  /**
   * True when one of the flight recorder's newest answers (plan 03-32: the newest 50) ended in an internal error. A flag
   * only: `atlas_status` turns it into the fixed `gsd-atlas bug` hint. Absent means the host keeps no recorder.
   */
  recentInternalError?(): boolean;
}

/** The state of the precise tier as `code_explain` reports it (plan 03-26). All are fixed words. */
export type PreciseState = 'active' | 'degraded' | 'inactive' | 'needs_approval' | 'disabled';

/**
 * What a Tenant says about the precise tier of one worktree, from state it already holds (the module registry, the user's
 * `providers` setting, the project description and what the last answers reported): it never probes the compiler and never
 * starts a worker. Every string is a fixed sentence; the compiler's name, version, source and case are data of a closed set.
 */
export interface TierInfo {
  readonly precise: PreciseState;
  /** A fixed sentence that says why the tier is not `active`. */
  readonly reason?: string;
  /** `degraded` only: the degraded code the worker's last failure carried. */
  readonly code?: DegradedCode;
  /** The compiler the tier resolves with, when it has one: the project's own (`project`) or the bundled one (`bundled`). */
  readonly compiler?: {
    readonly name: string;
    readonly version: string;
    readonly source: 'project' | 'bundled';
    /** The install case (`none`, `project-6`, `project-7-unstable`, ...). */
    readonly case: string;
    /** The fixed reason a bundled compiler was used instead of the project's; absent for a project compiler. */
    readonly reason?: string;
  };
}

/** One answer the flight recorder remembers, as `code_explain` needs it (the Tenant maps its recorder events to this). */
export interface RecordedAnswer {
  readonly id: string;
  readonly tool: string;
  readonly outcome: string;
  /** The latency bucket label (`le50`, `inf`). */
  readonly ms: string;
  readonly degraded: readonly string[];
  readonly count: number;
  /** The citation handles of the answer, at most the recorder's cap. */
  readonly handles: readonly string[];
}

/**
 * The state `code_explain` reads beyond the Fact Store, through ports the Tenant injects (the same pattern as
 * {@link StatusPort}): the tier information of a worktree, the answers the flight recorder holds, and the grammar version a
 * module reports now. Absent, `code_explain` still explains the facts, with the tier `inactive`, no answer lookup and no
 * grammar comparison.
 */
export interface ExplainPort {
  tierInfo(worktree: string): Promise<TierInfo>;
  /** The recorded answer with this id, or null when the recorder does not hold it (it is capped and per repository). */
  answer(id: string): RecordedAnswer | null;
  /** The grammar version the loaded module reports now, or undefined when it is not loaded. */
  grammarVersion(module: string): string | undefined;
}

/** How a citation number relates to the repository's ADR files (plan 03-28, D-20): one file, several (duplicate ids), or none. */
export type AdrStatus = 'resolved' | 'ambiguous' | 'unresolved';

/**
 * The ADR file or files a number names in one worktree. `files` are repo-relative paths sorted by code unit; only names are ever
 * known, never file content. `listTruncated` is set only on an `unresolved` answer whose directory listing was cut or could not be
 * made, so "no file" must not be read as "no such ADR".
 */
export interface AdrLookup {
  readonly status: AdrStatus;
  readonly files: readonly string[];
  readonly listTruncated?: true;
  /** Notes about how the ADR directories were chosen (fixed text, no repository words); Query adds them to the answer. */
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * The part of the Tenant that knows the repository's ADR directory (found from the module manifests and the repository's own
 * config), through the Source Tree seam. Absent: no ADR directory is known, so every number is `unresolved` and no file is listed.
 */
export interface AdrPort {
  lookup(worktree: string, number: number): Promise<AdrLookup>;
}

export interface QueryDeps {
  /** Reads only: Query asks for a Reader per request and never writes. */
  readonly store: Pick<FactStore, 'at'>;
  /** Absent: `kind: adr` answers have no ADR file to link to (every number is `unresolved`). */
  readonly adr?: AdrPort;
  /** Absent: `code_explain` reports the precise tier as inactive and cannot look an answer id up. */
  readonly explain?: ExplainPort;
  /** Absent: `atlas_status` answers `unavailable`. */
  readonly status?: StatusPort;
  /** The only way Query sees file text: confined to the worktree, no symlink escape, size capped. */
  readonly text: Pick<SourceTree, 'readText'>;
  /** Absent: a request that names `fresh` paths degrades with `fresh_timeout` instead of failing. */
  readonly fresh?: FreshPort;
  readonly clock: Clock;
  readonly config?: Partial<QueryConfig>;
  /** TEST HOOK. Supplies the per-response nonce so a test can plant it in a source line. Production omits it. */
  readonly nonce?: () => string;
}

export interface Query {
  /** Answer one request. Every outcome, including every error, is an envelope; only a bug rejects. */
  ask(request: Request): Promise<Envelope>;
}
