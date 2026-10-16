/**
 * The Query module's public types (query-and-policy ADR decisions 1 to 5, with the Phase 2 amendment).
 *
 * Query is the one place that answers: it owns ranking, the token budget and cursor, citations with debug
 * handles, the nonce-fenced `untrusted_text`, the watermark and the degraded codes. The MCP server, the CLI and
 * the hooks are adapters that hand it a `Request` and return the `Envelope` unchanged.
 */
import type { FactStore, StoreStatus } from '../fact-store/index.ts';
import type { Clock, Envelope, Request } from '../facts/index.ts';
import type { GovernorStatus } from '../governor/index.ts';
import type { SourceTree } from '../source-tree/index.ts';

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
}

export interface QueryDeps {
  /** Reads only: Query asks for a Reader per request and never writes. */
  readonly store: Pick<FactStore, 'at'>;
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
