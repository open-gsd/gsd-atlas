import type { Metrics, MetricsDeps, MetricsOptions, MetricsRange, MetricsReport } from './types.ts';

const EMPTY_HISTOGRAM = { count: 0, p50UpperBoundMs: null, p95UpperBoundMs: null, overflow: false, buckets: {} } as const;

function emptyReport(range: MetricsRange): MetricsReport {
  return {
    range,
    answers: { total: 0, ok: 0, byTool: {}, truncated: 0, latency: EMPTY_HISTOGRAM },
    degraded: {},
    freshness: EMPTY_HISTOGRAM,
    indexHealth: null,
    tokens: { estimatedTotal: 0, byTool: {}, label: 'estimate' },
  };
}

/** Placeholder for the red commit: every method is inert. Replaced by the real recorder. */
export async function openMetrics(_path: string, _deps: MetricsDeps, _options: MetricsOptions = {}): Promise<Metrics> {
  return {
    record: () => undefined,
    flush: async () => undefined,
    report: async (range) => emptyReport(range),
    reset: async () => undefined,
    rollup: async () => undefined,
    status: () => ({ recording: false, reason: 'not_implemented', queued: 0, dropped: 0, rejected: 0, writeFailures: 0 }),
    close: async () => undefined,
  };
}
