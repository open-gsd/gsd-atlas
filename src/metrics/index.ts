/**
 * Metrics: counters and histograms in their own database (MET-01, MET-02, D-17). Private SQLite owner beside
 * the fact store. The vocabulary is closed and no free text can be recorded.
 */
export { openMetrics } from './store.ts';
export { createNoopMetrics } from './noop.ts';
export {
  COUNTER_METRICS,
  DIM_NONE,
  GAUGE_METRICS,
  LAG_BUCKETS_MS,
  LATENCY_BUCKETS_MS,
  METRICS_DEFAULTS,
  TOOL_NAMES,
  bucketLabelFor,
} from './types.ts';
export type {
  AnswerEvent,
  FreshnessEvent,
  HistogramReport,
  IndexHealthEvent,
  IndexHealthReport,
  Metrics,
  MetricsDeps,
  MetricsEvent,
  MetricsOptions,
  MetricsRange,
  MetricsReport,
  MetricsStatus,
  ToolName,
} from './types.ts';
export type { Migration } from './migrations.ts';
