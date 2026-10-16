import { emptyReport } from './report.ts';
import type { Metrics } from './types.ts';

/** Placeholder for the red commit: claims to be recording. Replaced by the real noop. */
export function createNoopMetrics(): Metrics {
  return {
    record: () => undefined,
    flush: async () => undefined,
    report: async (range) => emptyReport(range),
    reset: async () => undefined,
    rollup: async () => undefined,
    status: () => ({ recording: true, queued: 0, dropped: 0, rejected: 0, writeFailures: 0 }),
    close: async () => undefined,
  };
}
