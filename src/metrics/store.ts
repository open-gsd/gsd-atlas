import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../sqlite/index.ts';
import type { Db } from '../sqlite/index.ts';
import { MIGRATIONS, migrate } from './migrations.ts';
import { createNoopMetrics } from './noop.ts';
import { buildReport, emptyReport } from './report.ts';
import { rollupCounters } from './rollup.ts';
import { DIM_NONE, LAG_BUCKETS_MS, LATENCY_BUCKETS_MS, METRICS_DEFAULTS, bucketLabelFor, hourBucket } from './types.ts';
import type {
  AnswerEvent,
  CounterMetric,
  GaugeMetric,
  IndexHealthEvent,
  Metrics,
  MetricsDeps,
  MetricsEvent,
  MetricsOptions,
  MetricsReport,
  RatingEvent,
} from './types.ts';
import { validateEvent } from './validate.ts';

/** An accepted event with the instant the recorder stamped on it. */
interface Queued {
  readonly event: MetricsEvent;
  readonly at: number;
}

interface Resolved {
  readonly busyTimeoutMs: number;
  readonly queueMax: number;
  readonly flushIntervalMs: number;
  readonly retentionDays: number;
  readonly rollupAfterDays: number;
}

const isInt = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;

/** The approved defaults (02-CONSTANTS.md) overridden by `options`; null when an override is not usable. */
function resolveOptions(options: MetricsOptions): Resolved | null {
  const resolved: Resolved = {
    busyTimeoutMs: options.busyTimeoutMs ?? METRICS_DEFAULTS.busyTimeoutMs,
    queueMax: options.queueMax ?? METRICS_DEFAULTS.queueMax,
    flushIntervalMs: options.flushIntervalMs ?? METRICS_DEFAULTS.flushIntervalMs,
    retentionDays: options.retentionDays ?? METRICS_DEFAULTS.retentionDays,
    rollupAfterDays: options.rollupAfterDays ?? METRICS_DEFAULTS.rollupAfterDays,
  };
  const usable =
    isInt(resolved.busyTimeoutMs, 0) &&
    isInt(resolved.queueMax, 1) &&
    isInt(resolved.flushIntervalMs, 1) &&
    isInt(resolved.rollupAfterDays, 1) &&
    isInt(resolved.retentionDays, resolved.rollupAfterDays);
  return usable ? resolved : null;
}

type Delta = readonly [CounterMetric, string, number];

/** Counter increments for one answer; zero increments are skipped so rows stay few. */
function answerDeltas(event: AnswerEvent): Delta[] {
  const out: Delta[] = [
    ['answers_calls', event.tool, 1],
    ['answers_ok', event.tool, event.ok ? 1 : 0],
    ['answers_truncated', event.tool, event.truncated ? 1 : 0],
    ['answers_results', event.tool, Math.round(event.results)],
    ['tokens_estimated', event.tool, Math.round(event.estimatedTokens)],
    ['latency_ms_bucket', `${event.tool}|${bucketLabelFor(LATENCY_BUCKETS_MS, event.latencyMs)}`, 1],
    ...event.degraded.map((code): Delta => ['degraded', code, 1]),
  ];
  return out.filter(([, , delta]) => delta !== 0);
}

/** The gauge values an index-health event sets. */
function healthGauges(event: IndexHealthEvent): ReadonlyArray<readonly [GaugeMetric, number]> {
  return [
    ['index_files', Math.round(event.files)],
    ['index_error_files', Math.round(event.errorFiles)],
    ['index_stale_files', Math.round(event.staleFiles)],
    ['index_size_bytes', Math.round(event.sizeBytes)],
  ];
}

interface Pending {
  readonly dropped: number;
  readonly rejected: number;
}

/** Add one batch, and the drop and reject totals that have not been persisted yet, in one transaction. */
function writeBatch(db: Db, batch: readonly Queued[], pending: Pending, now: number): void {
  const sums = new Map<string, { bucket: string; metric: CounterMetric; dim: string; delta: number }>();
  const add = (bucket: string, [metric, dim, delta]: Delta): void => {
    const key = `${bucket}\n${metric}\n${dim}`;
    const entry = sums.get(key);
    if (entry === undefined) sums.set(key, { bucket, metric, dim, delta });
    else entry.delta += delta;
  };
  const gauges = new Map<GaugeMetric, { value: number; at: number }>();
  // Ratings are rows, not counters: each one is inserted as it came, never coalesced with another (plan 03-17).
  const ratings: Array<{ readonly event: RatingEvent; readonly at: number }> = [];
  for (const { event, at } of batch) {
    if (event.kind === 'answer') {
      for (const delta of answerDeltas(event)) add(hourBucket(at), delta);
    } else if (event.kind === 'freshness') {
      add(hourBucket(at), ['freshness_lag_ms_bucket', bucketLabelFor(LAG_BUCKETS_MS, event.lagMs), 1]);
    } else if (event.kind === 'rating') {
      ratings.push({ event, at });
    } else {
      // Batch order is arrival order, so the last event of a batch is the newest.
      for (const [metric, value] of healthGauges(event)) gauges.set(metric, { value, at });
    }
  }
  if (pending.dropped > 0) add(hourBucket(now), ['dropped_events', DIM_NONE, pending.dropped]);
  if (pending.rejected > 0) add(hourBucket(now), ['rejected_events', DIM_NONE, pending.rejected]);
  db.transaction(() => {
    const upsert = db.prepare(
      `insert into counters (grain, bucket, metric, dim, value) values ('hour', ?, ?, ?, ?)
       on conflict (grain, bucket, metric, dim) do update set value = value + excluded.value`,
    );
    for (const { bucket, metric, dim, delta } of sums.values()) upsert.run(bucket, metric, dim, delta);
    // Latest wins: a requeued older batch never overwrites newer gauges.
    const setGauge = db.prepare(
      `insert into gauges (metric, value, at) values (?, ?, ?)
       on conflict (metric) do update set value = excluded.value, at = excluded.at where excluded.at >= gauges.at`,
    );
    for (const [metric, { value, at }] of gauges) setGauge.run(metric, value, at);
    if (ratings.length > 0) {
      const insertRating = db.prepare(
        'insert into ratings (at, scope, value, answer_id, feature, session_id) values (?, ?, ?, ?, ?, ?)',
      );
      for (const { event, at } of ratings) {
        insertRating.run(
          at,
          event.scope,
          event.value,
          event.scope === 'answer' ? event.answerId : null,
          event.scope === 'feature' ? event.feature : null,
          event.scope === 'session' ? event.sessionId : null,
        );
      }
    }
  });
}

function createRecorder(db: Db, deps: MetricsDeps, options: Resolved): Metrics {
  let queue: Queued[] = [];
  let closed = false;
  let dbClosed = false;
  let closing: Promise<void> | undefined;
  let writeFailures = 0;
  let dropped = 0;
  let rejected = 0;
  let pendingDropped = 0;
  let pendingRejected = 0;
  let cancelTimer: (() => void) | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  /** Serialise every database operation so batches never interleave; a failure is counted and replaced by `fallback`. */
  const enqueue = <T>(op: () => T, fallback: T): Promise<T> => {
    const next = chain.then(() => {
      if (dbClosed) return fallback;
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

  const disarm = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
  };

  /** Arm the single flush timer unless one is pending or the instance is closing. */
  const arm = (): void => {
    if (closed || cancelTimer !== undefined) return;
    cancelTimer = deps.clock.after(options.flushIntervalMs, () => {
      cancelTimer = undefined;
      void enqueue(flushNow, undefined);
    });
  };

  /**
   * Write everything queued. On failure the batch goes back in front of newer events (bounded by queueMax,
   * oldest dropped and counted), the totals stay pending, and the timer is re-armed so recovery resumes
   * writing. Never throws.
   */
  function flushNow(): void {
    const batch = queue;
    const pending: Pending = { dropped: pendingDropped, rejected: pendingRejected };
    if (batch.length === 0 && pending.dropped === 0 && pending.rejected === 0) return;
    queue = [];
    pendingDropped = 0;
    pendingRejected = 0;
    try {
      writeBatch(db, batch, pending, deps.clock.now());
    } catch {
      writeFailures += 1;
      pendingDropped += pending.dropped;
      pendingRejected += pending.rejected;
      const merged = batch.concat(queue);
      const overflow = merged.length - options.queueMax;
      if (overflow > 0) {
        merged.splice(0, overflow);
        dropped += overflow;
        pendingDropped += overflow;
      }
      queue = merged;
      arm();
    }
  }

  return {
    record(event) {
      if (closed) return;
      try {
        const checked = validateEvent(event);
        if (!checked.ok) {
          rejected += 1;
          pendingRejected += 1;
          return;
        }
        queue.push({ event: checked.event, at: deps.clock.now() });
        if (queue.length > options.queueMax) {
          queue.shift();
          dropped += 1;
          pendingDropped += 1;
        }
        arm();
      } catch {
        rejected += 1;
        pendingRejected += 1;
      }
    },
    flush: () => {
      disarm();
      return enqueue(flushNow, undefined);
    },
    report: async (range): Promise<MetricsReport> => {
      disarm();
      return enqueue(() => {
        flushNow();
        return buildReport(db, range);
      }, emptyReport(range));
    },
    reset: () => {
      // The queue and the unpersisted totals go now, so nothing recorded earlier is written after the delete.
      queue = [];
      pendingDropped = 0;
      pendingRejected = 0;
      disarm();
      return enqueue(() => {
        db.transaction(() => {
          db.exec('delete from counters');
          db.exec('delete from gauges');
        });
      }, undefined);
    },
    rollup: () =>
      enqueue(() => {
        rollupCounters(db, deps.clock.now(), options.rollupAfterDays, options.retentionDays);
      }, undefined),
    status: () => ({
      recording: !closed,
      ...(closed ? { reason: 'closed' } : {}),
      queued: queue.length,
      dropped,
      rejected,
      writeFailures,
    }),
    close() {
      if (closing !== undefined) return closing;
      closed = true;
      disarm();
      closing = (async () => {
        await enqueue(flushNow, undefined);
        await enqueue(() => {
          db.close();
        }, undefined);
        dbClosed = true;
      })();
      return closing;
    },
  };
}

/**
 * Open (creating if needed) the metrics database at `file` and bring it to the latest schema. Never throws:
 * on any failure it returns a noop instance whose `status().reason` names the cause (`invalid_options`,
 * `newer_schema`, `invalid_migrations` or `open_failed`).
 */
export async function openMetrics(file: string, deps: MetricsDeps, options: MetricsOptions = {}): Promise<Metrics> {
  const resolved = resolveOptions(options);
  if (resolved === null) return createNoopMetrics('invalid_options');
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
      return createNoopMetrics(outcome.reason);
    }
    return createRecorder(db, deps, resolved);
  } catch {
    try {
      db?.close();
    } catch {
      // The handle is already unusable; nothing more to release.
    }
    return createNoopMetrics('open_failed');
  }
}
