import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../sqlite/index.ts';
import type { Db } from '../sqlite/index.ts';
import { MIGRATIONS, migrate } from './migrations.ts';
import { buildReport, emptyReport } from './report.ts';
import { LATENCY_BUCKETS_MS, METRICS_DEFAULTS, bucketLabelFor, hourBucket } from './types.ts';
import type {
  AnswerEvent,
  CounterMetric,
  Metrics,
  MetricsDeps,
  MetricsEvent,
  MetricsOptions,
  MetricsRange,
  MetricsReport,
  MetricsStatus,
} from './types.ts';

/** An accepted event with the instant the recorder stamped on it. */
interface Queued {
  readonly event: MetricsEvent;
  readonly at: number;
}

/** A metrics instance that records nothing: recording is off, or the database could not be used. */
function disabled(reason: string): Metrics {
  const status: MetricsStatus = { recording: false, reason, queued: 0, dropped: 0, rejected: 0, writeFailures: 0 };
  return {
    record: () => undefined,
    flush: async () => undefined,
    report: async (range: MetricsRange) => emptyReport(range),
    reset: async () => undefined,
    rollup: async () => undefined,
    status: () => status,
    close: async () => undefined,
  };
}

interface Resolved {
  readonly busyTimeoutMs: number;
}

function resolveOptions(options: MetricsOptions): Resolved {
  return { busyTimeoutMs: options.busyTimeoutMs ?? METRICS_DEFAULTS.busyTimeoutMs };
}

/** Rows to add to `counters` for one answer; zero deltas are skipped so rows stay few. */
function answerDeltas(event: AnswerEvent): Array<readonly [CounterMetric, string, number]> {
  const out: Array<readonly [CounterMetric, string, number]> = [
    ['answers_calls', event.tool, 1],
    ['answers_ok', event.tool, event.ok ? 1 : 0],
    ['answers_results', event.tool, Math.round(event.results)],
    ['tokens_estimated', event.tool, Math.round(event.estimatedTokens)],
    ['latency_ms_bucket', `${event.tool}|${bucketLabelFor(LATENCY_BUCKETS_MS, event.latencyMs)}`, 1],
  ];
  return out.filter(([, , delta]) => delta !== 0);
}

function writeBatch(db: Db, batch: readonly Queued[]): void {
  const sums = new Map<string, { bucket: string; metric: CounterMetric; dim: string; delta: number }>();
  for (const { event, at } of batch) {
    if (event.kind !== 'answer') continue;
    const bucket = hourBucket(at);
    for (const [metric, dim, delta] of answerDeltas(event)) {
      const key = `${bucket}\n${metric}\n${dim}`;
      const entry = sums.get(key);
      if (entry === undefined) sums.set(key, { bucket, metric, dim, delta });
      else entry.delta += delta;
    }
  }
  db.transaction(() => {
    const upsert = db.prepare(
      `insert into counters (grain, bucket, metric, dim, value) values ('hour', ?, ?, ?, ?)
       on conflict (grain, bucket, metric, dim) do update set value = value + excluded.value`,
    );
    for (const { bucket, metric, dim, delta } of sums.values()) upsert.run(bucket, metric, dim, delta);
  });
}

function createRecorder(db: Db, deps: MetricsDeps): Metrics {
  const queue: Queued[] = [];
  let closed = false;
  let writeFailures = 0;
  let chain: Promise<unknown> = Promise.resolve();

  /** Serialise every database operation; a failure is counted and replaced by `fallback`. */
  const enqueue = <T>(op: () => T, fallback: T): Promise<T> => {
    const next = chain.then(() => {
      try {
        return op();
      } catch {
        writeFailures += 1;
        return fallback;
      }
    });
    chain = next;
    return next;
  };

  const flushNow = (): void => {
    const batch = queue.splice(0);
    if (batch.length === 0) return;
    writeBatch(db, batch);
  };

  return {
    record(event) {
      if (closed) return;
      queue.push({ event, at: deps.clock.now() });
    },
    flush: async () => enqueue(flushNow, undefined),
    report: async (range): Promise<MetricsReport> =>
      enqueue(() => {
        flushNow();
        return buildReport(db, range);
      }, emptyReport(range)),
    reset: async () => undefined,
    rollup: async () => undefined,
    status: () => ({
      recording: !closed,
      ...(closed ? { reason: 'closed' } : {}),
      queued: queue.length,
      dropped: 0,
      rejected: 0,
      writeFailures,
    }),
    async close() {
      if (closed) return;
      await enqueue(flushNow, undefined);
      closed = true;
      await enqueue(() => {
        db.close();
      }, undefined);
    },
  };
}

/**
 * Open (creating if needed) the metrics database at `file` and bring it to the latest schema. Never throws:
 * on any failure it returns an instance that records nothing and whose `status().reason` names the cause
 * (`newer_schema`, `invalid_migrations` or `open_failed`).
 */
export async function openMetrics(file: string, deps: MetricsDeps, options: MetricsOptions = {}): Promise<Metrics> {
  const resolved = resolveOptions(options);
  let db: Db | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = await openDatabase(file, {
      timeoutMs: resolved.busyTimeoutMs,
      ...(options.driver === undefined ? {} : { driver: options.driver }),
    });
    const outcome = migrate(db, options.migrations ?? MIGRATIONS);
    if (!outcome.ok) {
      db.close();
      return disabled(outcome.reason);
    }
    return createRecorder(db, deps);
  } catch {
    try {
      db?.close();
    } catch {
      // The handle is already unusable; nothing more to release.
    }
    return disabled('open_failed');
  }
}
