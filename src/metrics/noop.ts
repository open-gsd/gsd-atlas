import { emptyReport } from './report.ts';
import type { Metrics, MetricsStatus } from './types.ts';

/**
 * A Metrics that records nothing, with the full interface: for tenants where recording is off, and the
 * instance `openMetrics` returns when the database cannot be used. `reason` is what `status()` reports.
 */
export function createNoopMetrics(reason = 'noop'): Metrics {
  const status: MetricsStatus = { recording: false, reason, queued: 0, dropped: 0, rejected: 0, writeFailures: 0 };
  return {
    record: () => undefined,
    flush: async () => undefined,
    report: async (range) => emptyReport(range),
    reset: async () => undefined,
    rollup: async () => undefined,
    status: () => status,
    close: async () => undefined,
  };
}
