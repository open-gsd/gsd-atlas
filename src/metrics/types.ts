import type { Clock, DegradedCode } from '../facts/index.ts';
import type { DriverModule, DriverName } from '../sqlite/index.ts';
import type { Migration } from './migrations.ts';

/**
 * The closed vocabulary of the Metrics module (MET-01, D-17). Metrics stores counters and histograms, and since
 * plan 03-17 the ratings a person gave (a closed value and a random id or a feature name from a closed list):
 * every string that can reach metrics.db is a member of one of the lists below, a bucket label, a UTC hour or
 * day string derived from them, or a random answer or session id that matches its pattern. There is no free-text
 * field in any event type, so a path, a symbol name, a prompt or source text cannot be recorded by accident
 * (privacy prohibition).
 */

/** The MCP tools an answer can come from. */
export const TOOL_NAMES = [
  'code_find',
  'code_refs',
  'code_context',
  'code_impact',
  'atlas_status',
  'lang_list',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * What a person can rate (plan 03-17, D-16): any tool, the skill, the build and `init`. A closed list, so a rating
 * never names anything but a member of it.
 */
export const RATING_FEATURES = [...TOOL_NAMES, 'skill', 'build', 'init'] as const;
export type RatingFeature = (typeof RATING_FEATURES)[number];

/** What a rating is about: one answer, one feature, or one session. */
export const RATING_SCOPES = ['answer', 'feature', 'session'] as const;
export type RatingScope = (typeof RATING_SCOPES)[number];

/** The three values of a rating. There is no free-text note in this phase. */
export const RATING_VALUES = ['up', 'meh', 'down'] as const;
export type RatingValue = (typeof RATING_VALUES)[number];

/** Latency histogram upper edges in ms (a value equal to an edge counts in that bucket); one overflow bucket follows. */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000] as const;

/** Freshness lag histogram upper edges in ms; one overflow bucket follows. */
export const LAG_BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2000, 5000] as const;

/** Label of the bucket above the largest edge. */
export const OVERFLOW_LABEL = 'inf';

/** The label of the bucket holding `value`: the first edge at or above it, else the overflow label. */
export function bucketLabelFor(edges: readonly number[], value: number): string {
  for (const edge of edges) {
    if (value <= edge) return `le${edge}`;
  }
  return OVERFLOW_LABEL;
}

/** Every bucket label of a histogram, in ascending order, overflow last. */
export function bucketLabels(edges: readonly number[]): readonly string[] {
  return [...edges.map((edge) => `le${edge}`), OVERFLOW_LABEL];
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The last instant a four-digit-year ISO string can name; times are clamped into [0, this] before formatting. */
const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function clampMs(ms: number): number {
  if (!Number.isFinite(ms)) return ms > 0 ? MAX_MS : 0;
  return Math.max(0, Math.min(MAX_MS, ms));
}

/** The UTC hour bucket of an instant, `YYYY-MM-DDTHH`. Fixed width, so string order is time order. */
export function hourBucket(ms: number): string {
  return new Date(clampMs(ms)).toISOString().slice(0, 13);
}

/** The UTC day bucket of an instant, `YYYY-MM-DD`. */
export function dayBucket(ms: number): string {
  return new Date(clampMs(ms)).toISOString().slice(0, 10);
}

/** Row grains of the counters table: hourly buckets are rolled into daily buckets. */
export const GRAINS = ['hour', 'day'] as const;
export type Grain = (typeof GRAINS)[number];

/** The metric names of the counters table. */
export const COUNTER_METRICS = [
  'answers_calls',
  'answers_ok',
  'answers_truncated',
  'answers_results',
  'tokens_estimated',
  'degraded',
  'latency_ms_bucket',
  'freshness_lag_ms_bucket',
  'dropped_events',
  'rejected_events',
] as const;
export type CounterMetric = (typeof COUNTER_METRICS)[number];

/** The metric names of the gauges table (latest index-health values). */
export const GAUGE_METRICS = ['index_files', 'index_error_files', 'index_stale_files', 'index_size_bytes'] as const;
export type GaugeMetric = (typeof GAUGE_METRICS)[number];

/** The keys of the meta table. */
export const META_KEYS = ['last_rollup_at'] as const;
export type MetaKey = (typeof META_KEYS)[number];

/** The dimension of a counter that has none. */
export const DIM_NONE = '-';

/** The approved constants (02-CONSTANTS.md: sqlite.busyTimeoutMs and the metrics.* keys). */
export const METRICS_DEFAULTS = {
  busyTimeoutMs: 5000,
  queueMax: 1000,
  flushIntervalMs: 5000,
  retentionDays: 30,
  rollupAfterDays: 7,
} as const;

/** One answered request. `degraded` holds codes from the closed DEGRADED_CODES set. */
export interface AnswerEvent {
  readonly kind: 'answer';
  readonly tool: ToolName;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly results: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  readonly degraded: readonly DegradedCode[];
}

/** How far the index lagged behind the working tree when an answer was served. */
export interface FreshnessEvent {
  readonly kind: 'freshness';
  readonly lagMs: number;
}

/** The latest index-health gauges; the newest event replaces the stored values. */
export interface IndexHealthEvent {
  readonly kind: 'index_health';
  readonly files: number;
  readonly errorFiles: number;
  readonly staleFiles: number;
  readonly sizeBytes: number;
}

/**
 * One rating a person gave at a terminal (plan 03-17, D-16). It holds the closed value and exactly one reference, by
 * scope: the answer id, the feature name from {@link RATING_FEATURES}, or the session id. Ids are random and hold no
 * content; there is no text field of any kind.
 */
export type RatingEvent =
  | { readonly kind: 'rating'; readonly scope: 'answer'; readonly value: RatingValue; readonly answerId: string }
  | { readonly kind: 'rating'; readonly scope: 'feature'; readonly value: RatingValue; readonly feature: RatingFeature }
  | { readonly kind: 'rating'; readonly scope: 'session'; readonly value: RatingValue; readonly sessionId: string };

/**
 * The allow-listed event union. A caller never supplies a time: the recorder stamps each accepted event
 * from the injected Clock, so an `at` key is an unknown key and the event is rejected.
 */
export type MetricsEvent = AnswerEvent | FreshnessEvent | IndexHealthEvent | RatingEvent;
export type MetricsEventKind = MetricsEvent['kind'];

export interface MetricsStatus {
  /** True while events are being accepted: false for a disabled, noop or closed instance. */
  readonly recording: boolean;
  /** Why recording is off, for example `newer_schema`. Absent while recording. */
  readonly reason?: string;
  /** Events waiting in memory for the next flush. */
  readonly queued: number;
  /** Events discarded by the bounded queue (oldest first) since this instance opened. */
  readonly dropped: number;
  /** Events refused by validation since this instance opened. */
  readonly rejected: number;
  /** Database operations that failed and were swallowed since this instance opened. */
  readonly writeFailures: number;
}

/** A report window in epoch milliseconds. Hour and day buckets overlapping it are included whole. */
export interface MetricsRange {
  readonly since: number;
  readonly until: number;
}

/** Counts per histogram bucket label, plus percentiles as bucket upper bounds. */
export interface HistogramReport {
  readonly count: number;
  /** Upper edge in ms of the bucket holding the 50th percentile, or null with no samples. */
  readonly p50UpperBoundMs: number | null;
  /** Upper edge in ms of the bucket holding the 95th percentile, or null with no samples. */
  readonly p95UpperBoundMs: number | null;
  /**
   * True when a percentile fell in the overflow bucket. The reported bound is then the largest finite edge
   * and is a lower bound ("at least"), not an upper one.
   */
  readonly overflow: boolean;
  readonly buckets: Readonly<Record<string, number>>;
}

export interface IndexHealthReport {
  readonly files: number;
  readonly errorFiles: number;
  readonly staleFiles: number;
  readonly sizeBytes: number;
  /** When the gauges were recorded, epoch ms. */
  readonly at: number;
}

/** The panel data `gsd-atlas status` prints: Answers, Freshness, Index health and Tokens served. */
export interface MetricsReport {
  readonly range: MetricsRange;
  readonly answers: {
    readonly total: number;
    readonly ok: number;
    readonly byTool: Readonly<Record<string, number>>;
    readonly truncated: number;
    readonly latency: HistogramReport;
  };
  readonly degraded: Readonly<Record<string, number>>;
  readonly freshness: HistogramReport;
  readonly indexHealth: IndexHealthReport | null;
  /** Token figures are estimates (characters divided by four), never measured, and never summed with measured values. */
  readonly tokens: {
    readonly estimatedTotal: number;
    readonly byTool: Readonly<Record<string, number>>;
    readonly label: 'estimate';
  };
}

export interface Metrics {
  /** Never blocks and never throws; an invalid event is rejected and counted. */
  record(event: MetricsEvent): void;
  /** Write the queued events now. Never rejects. */
  flush(): Promise<void>;
  /** Flushes first, then reads. An empty or unreadable database yields an all-zero report. Never rejects. */
  report(range: MetricsRange): Promise<MetricsReport>;
  /** Delete every counter and gauge and drop the queue. Keeps the schema and user_version. Never rejects. */
  reset(): Promise<void>;
  /** Merge old hourly rows into daily rows and delete expired days. Idempotent. Never rejects. */
  rollup(): Promise<void>;
  status(): MetricsStatus;
  /** Cancel the flush timer, flush once more, close the database. Idempotent. Never rejects. */
  close(): Promise<void>;
}

export interface MetricsDeps {
  readonly clock: Clock;
}

export interface MetricsOptions {
  /** A SQLite driver name or an injected driver module (tests). Default `'node:sqlite'`. */
  readonly driver?: DriverName | DriverModule;
  readonly busyTimeoutMs?: number;
  readonly queueMax?: number;
  readonly flushIntervalMs?: number;
  readonly retentionDays?: number;
  readonly rollupAfterDays?: number;
  /** Replaces the built-in migration list (tests). */
  readonly migrations?: readonly Migration[];
}
