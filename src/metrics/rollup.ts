import type { Db } from '../sqlite/index.ts';
import { DAY_MS, dayBucket, hourBucket } from './types.ts';

/**
 * Keep the counters table small (D-17): hourly rows older than `rollupAfterDays` are merged into one daily
 * row per (metric, dim) with summed values and then deleted, and daily rows older than `retentionDays` are
 * deleted. Everything runs in one transaction, so a reader never sees a half-merged day and an event is in
 * exactly one bucket. Hours before the cutoff hour merge; a day that straddles the cutoff keeps its newer
 * hours hourly until they age out, and the daily row simply gains their sums later. Idempotent: with nothing
 * old left, a second run changes nothing and writes nothing, not even the bookkeeping row.
 *
 * Returns true when it changed any row.
 */
export function rollupCounters(db: Db, now: number, rollupAfterDays: number, retentionDays: number): boolean {
  const cutoffHour = hourBucket(now - rollupAfterDays * DAY_MS);
  const cutoffDay = dayBucket(now - retentionDays * DAY_MS);
  return db.transaction(() => {
    const merged = db
      .prepare(
        `insert into counters (grain, bucket, metric, dim, value)
         select 'day', substr(bucket, 1, 10), metric, dim, sum(value) from counters
         where grain = 'hour' and bucket < ?
         group by substr(bucket, 1, 10), metric, dim
         on conflict (grain, bucket, metric, dim) do update set value = value + excluded.value`,
      )
      .run(cutoffHour);
    const hours = db.prepare(`delete from counters where grain = 'hour' and bucket < ?`).run(cutoffHour);
    const days = db.prepare(`delete from counters where grain = 'day' and bucket < ?`).run(cutoffDay);
    const changed = Number(merged.changes) + Number(hours.changes) + Number(days.changes) > 0;
    if (changed) {
      db.prepare(
        `insert into meta (key, value) values ('last_rollup_at', ?)
         on conflict (key) do update set value = excluded.value`,
      ).run(now);
    }
    return changed;
  });
}
