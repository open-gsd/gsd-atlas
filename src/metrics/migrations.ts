import type { Db } from '../sqlite/index.ts';

/** One forward-only schema step. `up` runs inside a transaction together with the `user_version` bump. */
export interface Migration {
  readonly version: number;
  up(db: Db): void;
}

/**
 * Ordered, ascending, starting at 1. Never edit a shipped migration: add the next version. Version 1 holds
 * counters only (see types.ts): `counters` keyed by (grain, bucket, metric, dim), `gauges` for the latest
 * index-health values and `meta` for the module's own bookkeeping. Version 2 adds `ratings`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        create table counters (
          grain  text    not null check (grain in ('hour', 'day')),
          bucket text    not null,
          metric text    not null,
          dim    text    not null,
          value  integer not null,
          primary key (grain, bucket, metric, dim)
        ) without rowid;
        create table gauges (
          metric text    not null primary key,
          value  integer not null,
          at     integer not null
        ) without rowid;
        create table meta (
          key   text    not null primary key,
          value integer not null
        ) without rowid;
      `);
    },
  },
  {
    // Plan 03-17 (D-16): what a person rated, as ids and closed values only. One reference column per scope, enforced
    // here as well as by the event validation, so no row can hold free text or two references. There is no text column.
    version: 2,
    up(db) {
      db.exec(`
        create table ratings (
          at         integer not null,
          scope      text    not null check (scope in ('answer', 'feature', 'session')),
          value      text    not null check (value in ('up', 'meh', 'down')),
          answer_id  text    check (answer_id is null or length(answer_id) = 18),
          feature    text,
          session_id text    check (session_id is null or length(session_id) = 18),
          check (
            (scope = 'answer'  and answer_id is not null and feature is null     and session_id is null) or
            (scope = 'feature' and answer_id is null     and feature is not null and session_id is null) or
            (scope = 'session' and answer_id is null     and feature is null     and session_id is not null)
          )
        );
        create index ratings_at on ratings (at);
      `);
    },
  },
];

export type MigrationOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: 'newer_schema'; readonly found: number; readonly known: number }
  | { readonly ok: false; readonly reason: 'invalid_migrations' };

function isOrdered(migrations: readonly Migration[]): boolean {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) return false;
    previous = migration.version;
  }
  return migrations.length === 0 || migrations[0]?.version === 1;
}

/**
 * Bring `db` up to the highest known version. Each migration runs in its own transaction and sets
 * `PRAGMA user_version` before it commits, so a failure leaves the database at the last good version.
 * A database whose stored version is above the highest known one is left untouched and reported
 * (`newer_schema`): the caller disables recording rather than writing to a schema it does not understand.
 * Throws only when a migration itself throws.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationOutcome {
  if (!isOrdered(migrations)) return { ok: false, reason: 'invalid_migrations' };
  const known = migrations.length === 0 ? 0 : (migrations[migrations.length - 1]?.version ?? 0);
  const stored = db.pragma('user_version');
  const found = typeof stored === 'number' ? stored : Number(stored ?? 0);
  if (found > known) return { ok: false, reason: 'newer_schema', found, known };
  for (const migration of migrations) {
    if (migration.version <= found) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma('user_version', migration.version);
    });
  }
  return { ok: true, version: Math.max(found, known) };
}
