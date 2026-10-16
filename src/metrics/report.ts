import type { Db } from '../sqlite/index.ts';
import { LAG_BUCKETS_MS, LATENCY_BUCKETS_MS, OVERFLOW_LABEL, bucketLabels, dayBucket, hourBucket } from './types.ts';
import type { HistogramReport, MetricsRange, MetricsReport } from './types.ts';

/** A histogram with every bucket at zero and no percentiles. */
export function emptyHistogram(edges: readonly number[]): HistogramReport {
  return {
    count: 0,
    p50UpperBoundMs: null,
    p95UpperBoundMs: null,
    overflow: false,
    buckets: Object.fromEntries(bucketLabels(edges).map((label) => [label, 0])),
  };
}

/** The report of a database with no rows: zero counters, an empty degraded map and null percentiles. */
export function emptyReport(range: MetricsRange): MetricsReport {
  return {
    range,
    answers: { total: 0, ok: 0, byTool: {}, truncated: 0, latency: emptyHistogram(LATENCY_BUCKETS_MS) },
    degraded: {},
    freshness: emptyHistogram(LAG_BUCKETS_MS),
    indexHealth: null,
    tokens: { estimatedTotal: 0, byTool: {}, label: 'estimate' },
  };
}

/** The bucket upper edge holding the `p`-th percentile (nearest rank), or null with no samples. */
function percentile(
  labels: readonly string[],
  edges: readonly number[],
  counts: ReadonlyMap<string, number>,
  total: number,
  p: number,
): { readonly bound: number | null; readonly overflow: boolean } {
  if (total === 0) return { bound: null, overflow: false };
  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (const label of labels) {
    seen += counts.get(label) ?? 0;
    if (seen >= rank) {
      if (label === OVERFLOW_LABEL) return { bound: edges[edges.length - 1] ?? null, overflow: true };
      return { bound: Number(label.slice(2)), overflow: false };
    }
  }
  return { bound: null, overflow: false };
}

/** Counts per bucket label, with nearest-rank percentiles reported as bucket upper bounds. */
export function histogramReport(edges: readonly number[], counts: ReadonlyMap<string, number>): HistogramReport {
  const labels = bucketLabels(edges);
  let count = 0;
  for (const label of labels) count += counts.get(label) ?? 0;
  const p50 = percentile(labels, edges, counts, count, 0.5);
  const p95 = percentile(labels, edges, counts, count, 0.95);
  return {
    count,
    p50UpperBoundMs: p50.bound,
    p95UpperBoundMs: p95.bound,
    overflow: p50.overflow || p95.overflow,
    buckets: Object.fromEntries(labels.map((label) => [label, counts.get(label) ?? 0])),
  };
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function nonZero(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map].filter(([, value]) => value > 0));
}

/**
 * Assemble the panel data over `range`. Hour and day buckets that overlap the window are included whole.
 * Token figures are the estimates the recorder stored (characters divided by four); the report labels them
 * as such and has no measured figure to add them to.
 */
export function buildReport(db: Db, range: MetricsRange): MetricsReport {
  const rows = db
    .prepare(
      `select metric, dim, sum(value) as v from counters
       where (grain = 'hour' and bucket between ? and ?) or (grain = 'day' and bucket between ? and ?)
       group by metric, dim`,
    )
    .all(hourBucket(range.since), hourBucket(range.until), dayBucket(range.since), dayBucket(range.until));

  const calls = new Map<string, number>();
  const oks = new Map<string, number>();
  const truncated = new Map<string, number>();
  const tokens = new Map<string, number>();
  const latency = new Map<string, number>();
  for (const row of rows) {
    const metric = String(row.metric);
    const dim = String(row.dim);
    const value = Number(row.v);
    if (metric === 'answers_calls') add(calls, dim, value);
    else if (metric === 'answers_ok') add(oks, dim, value);
    else if (metric === 'answers_truncated') add(truncated, dim, value);
    else if (metric === 'tokens_estimated') add(tokens, dim, value);
    else if (metric === 'latency_ms_bucket') add(latency, dim.slice(dim.indexOf('|') + 1), value);
  }
  const sum = (map: ReadonlyMap<string, number>): number => [...map.values()].reduce((a, b) => a + b, 0);

  return {
    range,
    answers: {
      total: sum(calls),
      ok: sum(oks),
      byTool: nonZero(calls),
      truncated: sum(truncated),
      latency: histogramReport(LATENCY_BUCKETS_MS, latency),
    },
    degraded: {},
    freshness: emptyHistogram(LAG_BUCKETS_MS),
    indexHealth: null,
    tokens: { estimatedTotal: sum(tokens), byTool: nonZero(tokens), label: 'estimate' },
  };
}
