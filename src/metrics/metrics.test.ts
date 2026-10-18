import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DEGRADED_CODES } from '../facts/index.ts';
import type { Clock } from '../facts/index.ts';
import { DbError, loadDriver, openDatabase } from '../sqlite/index.ts';
import type { Db, DriverModule, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { createNoopMetrics, openMetrics } from './index.ts';
import type { AnswerEvent, Metrics, MetricsEvent, MetricsOptions, MetricsRange, Migration } from './index.ts';
import { MIGRATIONS } from './migrations.ts';
import {
  COUNTER_METRICS,
  DIM_NONE,
  GAUGE_METRICS,
  GRAINS,
  LAG_BUCKETS_MS,
  LATENCY_BUCKETS_MS,
  META_KEYS,
  RATING_FEATURES,
  RATING_SCOPES,
  RATING_VALUES,
  TOOL_NAMES,
  bucketLabels,
} from './types.ts';
import { validateEvent } from './validate.ts';

const DRIVERS: readonly DriverName[] = ['node:sqlite', 'better-sqlite3'];

const START = Date.UTC(2026, 9, 16, 10, 30, 0);
const ALL: MetricsRange = { since: 0, until: Number.MAX_SAFE_INTEGER };

function answer(over: Partial<AnswerEvent> = {}): AnswerEvent {
  return {
    kind: 'answer',
    tool: 'code_find',
    ok: true,
    latencyMs: 7,
    results: 3,
    estimatedTokens: 120,
    truncated: false,
    degraded: [],
    ...over,
  };
}

/** Let queued promise continuations and I/O callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A clock that counts the `after` timers still pending, to prove nothing is left armed. */
function countingClock(inner: FakeClock): { readonly clock: Clock; readonly live: () => number } {
  let live = 0;
  const clock: Clock = {
    now: () => inner.now(),
    sleep: (ms) => inner.sleep(ms),
    after: (ms, fn) => {
      live += 1;
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          live -= 1;
        }
      };
      const cancel = inner.after(ms, () => {
        finish();
        fn();
      });
      return () => {
        finish();
        cancel();
      };
    },
  };
  return { clock, live: () => live };
}

/** Wrap a real driver so tests can make every write transaction fail, then recover. */
function flaky(real: DriverModule, control: { fail: boolean }): DriverModule {
  return {
    name: real.name,
    open(file, options) {
      const db = real.open(file, options);
      const wrapped: Db = {
        driver: db.driver,
        path: db.path,
        sqliteVersion: db.sqliteVersion,
        exec: (sql) => db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        pragma: (name, value) => db.pragma(name, value),
        transaction: (fn) => {
          if (control.fail) throw new DbError('readonly', 'attempt to write a readonly database', 8);
          return db.transaction(fn);
        },
        savepoint: (name, fn) => db.savepoint(name, fn),
        close: () => {
          db.close();
        },
      };
      return wrapped;
    },
  };
}

describe('validateEvent', () => {
  it('accepts the event shapes and returns a copy', () => {
    const events: MetricsEvent[] = [
      answer({ degraded: ['stale', 'follower'] }),
      { kind: 'freshness', lagMs: 12 },
      { kind: 'index_health', files: 10, errorFiles: 1, staleFiles: 2, sizeBytes: 4096 },
      { kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_0123456789abcdef' },
      { kind: 'rating', scope: 'feature', value: 'meh', feature: 'skill' },
      { kind: 'rating', scope: 'session', value: 'down', sessionId: 's_0123456789abcdef' },
    ];
    for (const event of events) {
      const result = validateEvent(event);
      assert.equal(result.ok, true);
      if (result.ok) assert.deepStrictEqual(result.event, event);
    }
    const source = answer({ degraded: ['stale'] });
    const result = validateEvent(source);
    (source.degraded as string[]).push('follower');
    assert.equal(result.ok && result.event.kind === 'answer' ? result.event.degraded.length : -1, 1);
  });

  const missingKey: Record<string, unknown> = { ...answer() };
  delete missingKey.truncated;
  const rejectedCases: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown kind', { kind: 'prompt', text: 'hello' }],
    ['an extra path key', { ...answer(), path: '/secret/place.ts' }],
    ['an extra symbol key', { ...answer(), symbol: 'secretName' }],
    ['a caller-supplied at key', { ...answer(), at: 5 }],
    ['an extra key on freshness', { kind: 'freshness', lagMs: 1, repo: 'private' }],
    ['a tool outside the closed set', answer({ tool: 'shell' as never })],
    ['a degraded value outside the closed set', answer({ degraded: ['bogus' as never] })],
    ['a degraded value that is not an array', { ...answer(), degraded: 'stale' }],
    ['a negative number', answer({ latencyMs: -1 })],
    ['NaN', answer({ results: Number.NaN })],
    ['an infinite number', { kind: 'freshness', lagMs: Number.POSITIVE_INFINITY }],
    ['a string where a number belongs', answer({ estimatedTokens: '12' as never })],
    ['a non-boolean ok', answer({ ok: 'yes' as never })],
    ['a missing key', missingKey],
    ['null', null],
    ['an array', []],
    ['a string', 'code_find'],
  ];
  for (const [name, value] of rejectedCases) {
    it(`rejected: ${name}`, () => {
      const result = validateEvent(value);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.doesNotMatch(result.reason, /secret|private|hello|bogus|shell/, 'a reason never echoes the input');
      }
    });
  }
});

describe('the tool list has the seventh tool (plan 03-26, QRY-07)', () => {
  it('code_explain is a tool name, an answer of it validates, and it can be rated as a feature', () => {
    assert.equal(TOOL_NAMES.length, 7);
    assert.ok((TOOL_NAMES as readonly string[]).includes('code_explain'));
    assert.deepStrictEqual(validateEvent(answer({ tool: 'code_explain' })).ok, true);
    assert.deepStrictEqual(validateEvent({ kind: 'rating', scope: 'feature', value: 'up', feature: 'code_explain' }).ok, true);
  });
});

describe('rating closed vocabulary: constants', () => {
  it('the scopes and values are the closed lists, and the features are the tool names plus skill, build and init', () => {
    assert.deepStrictEqual([...RATING_SCOPES], ['answer', 'feature', 'session']);
    assert.deepStrictEqual([...RATING_VALUES], ['up', 'meh', 'down']);
    assert.deepStrictEqual([...RATING_FEATURES], [...TOOL_NAMES, 'skill', 'build', 'init']);
  });

  it('there is no rating tool: no tool name begins with rate or rating', () => {
    for (const name of TOOL_NAMES) assert.doesNotMatch(name, /^rat(e|ing)/, name);
  });

  it('a rejection reason never echoes a rating field', () => {
    const result = validateEvent({ kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_0123456789abcdef', note: 'secret note' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.doesNotMatch(result.reason, /secret|note|a_0123/);
  });
});

describe('noop metrics', () => {
  it('noop satisfies the interface, records nothing and reports zeros', async () => {
    const metrics: Metrics = createNoopMetrics();
    assert.equal(metrics.status().recording, false);
    assert.equal(metrics.record(answer()), undefined);
    await metrics.flush();
    await metrics.rollup();
    await metrics.reset();
    const report = await metrics.report(ALL);
    assert.equal(report.answers.total, 0);
    assert.equal(report.tokens.label, 'estimate');
    assert.equal(report.freshness.p50UpperBoundMs, null);
    await metrics.close();
    await metrics.close();
  });
});

for (const driver of DRIVERS) {
  describe(`metrics database and migrations (${driver})`, () => {
    const dirs: TempDir[] = [];
    const opened: Metrics[] = [];
    afterEach(async () => {
      // Close every handle before removing the directory: Windows keeps open database files locked.
      for (const metrics of opened.splice(0)) await metrics.close();
      for (const dir of dirs.splice(0)) dir.cleanup();
    });

    function fixture(clockOverride?: Clock) {
      const dir = makeTempDir();
      dirs.push(dir);
      const clock = new FakeClock(START);
      const file = path.join(dir.path, 'metrics.db');
      const open = async (options: MetricsOptions = {}): Promise<Metrics> => {
        const metrics = await openMetrics(file, { clock: clockOverride ?? clock }, { driver, ...options });
        opened.push(metrics);
        return metrics;
      };
      return { dir, clock, file, open };
    }

    async function peek<T>(file: string, fn: (db: Db) => T): Promise<T> {
      const db = await openDatabase(file, { readOnly: true, driver, timeoutMs: 1000 });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    }

    const total = (file: string, metric: string): Promise<number> =>
      peek(file, (db) => Number(db.prepare('select coalesce(sum(value), 0) as v from counters where metric = ?').get(metric)?.v));

    it('creates metrics.db, applies every migration and sets user_version 2; reopening applies nothing', async () => {
      const { file, open } = fixture();
      const first = await open();
      assert.equal(first.status().recording, true);
      await first.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 2);
      const tables = await peek(file, (db) =>
        db
          .prepare(`select name from sqlite_master where type = 'table' order by name`)
          .all()
          .map((row) => row.name),
      );
      assert.deepStrictEqual(tables, ['counters', 'gauges', 'meta', 'ratings']);

      const second = await open();
      assert.equal(second.status().recording, true);
      await second.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 2);
    });

    it('migration 2: applies on a version 1 database, keeps its counters, creates the ratings table and an index on at', async () => {
      const { file, open } = fixture();
      const v1 = await open({ migrations: MIGRATIONS.slice(0, 1) });
      v1.record(answer({ results: 9 }));
      await v1.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 1);
      assert.equal(
        await peek(file, (db) => db.prepare(`select count(*) as n from sqlite_master where name = 'ratings'`).get()?.n),
        0,
        'a version 1 database has no ratings table',
      );

      const v2 = await open();
      assert.equal(v2.status().recording, true);
      assert.equal((await v2.report(ALL)).answers.total, 1, 'the version 1 counters are kept');
      await v2.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 2);
      assert.equal(await total(file, 'answers_results'), 9);
      assert.deepStrictEqual(
        await peek(file, (db) =>
          db
            .prepare(`select name from pragma_table_info('ratings') order by cid`)
            .all()
            .map((row) => row.name),
        ),
        ['at', 'scope', 'value', 'answer_id', 'feature', 'session_id'],
        'the ratings table holds exactly six columns and no free text',
      );
      assert.deepStrictEqual(
        await peek(file, (db) =>
          db
            .prepare(`select name from sqlite_master where type = 'index' and tbl_name = 'ratings' order by name`)
            .all()
            .map((row) => row.name),
        ),
        ['ratings_at'],
      );
    });

    it('migration 2: a database already at version 2 is untouched, and a version 3 database is reported newer_schema as before', async () => {
      const { file, open } = fixture();
      const first = await open();
      first.record({ kind: 'rating', scope: 'feature', value: 'up', feature: 'code_find' });
      await first.close();
      const again = await open();
      assert.equal(again.status().recording, true);
      await again.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 2);
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from ratings').get()?.n), 1, 'reopening keeps the rating');

      const future = await openDatabase(file, { driver, timeoutMs: 1000 });
      future.pragma('user_version', 3);
      future.close();
      const newer = await open();
      assert.equal(newer.status().recording, false);
      assert.equal(newer.status().reason, 'newer_schema');
      assert.doesNotThrow(() => newer.record({ kind: 'rating', scope: 'feature', value: 'up', feature: 'code_find' }));
      await newer.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 3);
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from ratings').get()?.n), 1, 'a newer database is left alone');
    });

    it('rating: an accepted event becomes one row with the time of the injected clock, and no counter', async () => {
      const { file, clock, open } = fixture();
      const metrics = await open();
      await clock.advance(1234);
      metrics.record({ kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_0123456789abcdef' });
      await metrics.flush();
      const rows = await peek(file, (db) =>
        db
          .prepare('select at, scope, value, answer_id, feature, session_id from ratings')
          .all()
          .map((row) => ({ ...row })),
      );
      assert.deepStrictEqual(rows, [
        { at: START + 1234, scope: 'answer', value: 'up', answer_id: 'a_0123456789abcdef', feature: null, session_id: null },
      ]);
      assert.deepStrictEqual(await counterRows(file), [], 'a rating is not counted in the counters table');
    });

    it('rating: feature and session ratings fill their own column; identical ratings are separate rows', async () => {
      const { file, open } = fixture();
      const metrics = await open();
      metrics.record({ kind: 'rating', scope: 'feature', value: 'meh', feature: 'code_refs' });
      metrics.record({ kind: 'rating', scope: 'session', value: 'down', sessionId: 's_0123456789abcdef' });
      metrics.record({ kind: 'rating', scope: 'feature', value: 'meh', feature: 'code_refs' });
      await metrics.flush();
      const rows = await peek(file, (db) =>
        db
          .prepare('select scope, value, answer_id, feature, session_id from ratings order by rowid')
          .all()
          .map((row) => ({ ...row })),
      );
      assert.deepStrictEqual(rows, [
        { scope: 'feature', value: 'meh', answer_id: null, feature: 'code_refs', session_id: null },
        { scope: 'session', value: 'down', answer_id: null, feature: null, session_id: 's_0123456789abcdef' },
        { scope: 'feature', value: 'meh', answer_id: null, feature: 'code_refs', session_id: null },
      ]);
    });

    it('rating closed vocabulary: a bad id, feature, value or scope, an extra key or free text stores no row and is counted as rejected', async () => {
      const { file, open } = fixture();
      const metrics = await open();
      const bad: unknown[] = [
        { kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_short' },
        { kind: 'rating', scope: 'answer', value: 'up', answerId: 'A_0123456789ABCDEF' },
        { kind: 'rating', scope: 'answer', value: 'up', answerId: 's_0123456789abcdef' },
        { kind: 'rating', scope: 'feature', value: 'up', feature: 'nonsense' },
        { kind: 'rating', scope: 'feature', value: 'up', feature: 'rate' },
        { kind: 'rating', scope: 'answer', value: 'great', answerId: 'a_0123456789abcdef' },
        { kind: 'rating', scope: 'everything', value: 'up', answerId: 'a_0123456789abcdef' },
        { kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_0123456789abcdef', note: 'free text' },
        { kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_0123456789abcdef', at: 5 },
        { kind: 'rating', scope: 'answer', value: 'up', answerId: 'a_0123456789abcdef', feature: 'code_find' },
        { kind: 'rating', scope: 'feature', value: 'up', feature: 'code_find', sessionId: 's_0123456789abcdef' },
        { kind: 'rating', scope: 'session', value: 'up', sessionId: 'a_0123456789abcdef' },
        { kind: 'rating', scope: 'answer', value: 'up' },
        { kind: 'rating', value: 'up', answerId: 'a_0123456789abcdef' },
      ];
      for (const event of bad) assert.equal(metrics.record(event as MetricsEvent), undefined);
      assert.equal(metrics.status().rejected, bad.length);
      assert.equal(metrics.status().queued, 0);
      await metrics.flush();
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from ratings').get()?.n), 0);
      assert.equal(await total(file, 'rejected_events'), bad.length);
    });

    it('rating closed vocabulary: the table itself refuses a row the validation would have refused', async () => {
      const { file, open } = fixture();
      await (await open()).close();
      const db = await openDatabase(file, { driver, timeoutMs: 1000 });
      try {
        const insert = db.prepare('insert into ratings (at, scope, value, answer_id, feature, session_id) values (?, ?, ?, ?, ?, ?)');
        assert.throws(() => insert.run(1, 'everything', 'up', 'a_0123456789abcdef', null, null));
        assert.throws(() => insert.run(1, 'answer', 'great', 'a_0123456789abcdef', null, null));
        assert.throws(() => insert.run(1, 'answer', 'up', null, null, null), 'an answer rating needs its id');
        assert.throws(() => insert.run(1, 'answer', 'up', 'a_0123456789abcdef', 'code_find', null), 'one id column per scope');
        assert.throws(() => insert.run(1, 'feature', 'up', null, null, null), 'a feature rating needs its feature');
        assert.doesNotThrow(() => insert.run(1, 'session', 'meh', null, null, 's_0123456789abcdef'));
      } finally {
        db.close();
      }
    });

    it('read-only database: a rating that cannot be written is kept in the bounded queue, never throws, and is written when the database recovers', async () => {
      const { file, open } = fixture();
      const control = { fail: false };
      const metrics = await open({ driver: flaky(await loadDriver(driver), control) });
      control.fail = true;
      assert.equal(metrics.record({ kind: 'rating', scope: 'feature', value: 'up', feature: 'code_find' }), undefined);
      await assert.doesNotReject(metrics.flush());
      assert.ok(metrics.status().writeFailures >= 1);
      assert.equal(metrics.status().queued, 1, 'the rating waits in the queue');
      assert.equal(metrics.status().recording, true);
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from ratings').get()?.n), 0);

      control.fail = false;
      await metrics.flush();
      assert.equal(metrics.status().queued, 0);
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from ratings').get()?.n), 1);
    });

    it('reports a recorded answer after a flush: total, tool, estimate-labelled tokens and the 10 ms latency bucket', async () => {
      const { open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      await metrics.flush();
      const report = await metrics.report(ALL);
      assert.equal(report.answers.total, 1);
      assert.equal(report.answers.ok, 1);
      assert.deepStrictEqual(report.answers.byTool, { code_find: 1 });
      assert.equal(report.tokens.estimatedTotal, 120);
      assert.equal(report.tokens.label, 'estimate');
      assert.deepStrictEqual(report.tokens.byTool, { code_find: 120 });
      assert.equal(report.answers.latency.buckets.le10, 1);
      assert.equal(report.answers.latency.count, 1);
    });

    it('upgrades a version 2 database to an injected version 3 and keeps the earlier data', async () => {
      const { file, open } = fixture();
      const v2 = await open();
      v2.record(answer({ results: 9 }));
      v2.record({ kind: 'rating', scope: 'feature', value: 'up', feature: 'code_find' });
      await v2.close();

      let ran = 0;
      const migrations: readonly Migration[] = [
        ...MIGRATIONS,
        {
          version: 3,
          up(db) {
            ran += 1;
            db.exec('create table extra (n integer not null)');
          },
        },
      ];
      const v3 = await open({ migrations });
      assert.equal(v3.status().recording, true);
      assert.equal(ran, 1);
      const report = await v3.report(ALL);
      assert.equal(report.answers.total, 1);
      await v3.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 3);
      assert.equal(
        await peek(file, (db) => db.prepare(`select count(*) as n from sqlite_master where name = 'extra'`).get()?.n),
        1,
      );
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from ratings').get()?.n), 1, 'the ratings are kept');

      const again = await open({ migrations });
      await again.close();
      assert.equal(ran, 1, 'a database already at version 3 applies nothing');
    });

    it('opens a database newer than the code as disabled with reason newer_schema and no exception', async () => {
      const { file, open } = fixture();
      const db = await openDatabase(file, { driver, timeoutMs: 1000 });
      db.exec('create table future (x integer)');
      db.pragma('user_version', 5);
      db.close();

      const migrations: readonly Migration[] = [
        ...MIGRATIONS,
        { version: 3, up: (d) => d.exec('create table extra (n integer not null)') },
      ];
      const metrics = await open({ migrations });
      assert.equal(metrics.status().recording, false);
      assert.equal(metrics.status().reason, 'newer_schema');
      assert.doesNotThrow(() => metrics.record(answer()));
      await metrics.flush();
      const report = await metrics.report(ALL);
      assert.equal(report.answers.total, 0);
      await metrics.close();
      assert.equal(await peek(file, (d) => d.pragma('user_version')), 5);
      assert.equal(
        await peek(file, (d) => d.prepare(`select count(*) as n from sqlite_master where name = 'counters'`).get()?.n),
        0,
        'a disabled instance changes nothing in a newer database',
      );
    });

    it('opens as disabled with reason open_failed when the path cannot be a database, without throwing', async () => {
      const { dir, clock } = fixture();
      const blocked = path.join(dir.path, 'metrics.db');
      fs.mkdirSync(blocked);
      const metrics = await openMetrics(blocked, { clock }, { driver });
      assert.equal(metrics.status().recording, false);
      assert.equal(metrics.status().reason, 'open_failed');
      assert.equal(metrics.record(answer()), undefined);
      await metrics.close();
    });

    it('rejected events increment status().rejected, return undefined and store no event rows', async () => {
      const { file, open } = fixture();
      const metrics = await open();
      const bad = { ...answer(), path: '/secret/place.ts' } as unknown as MetricsEvent;
      assert.equal(metrics.record(bad), undefined);
      assert.equal(metrics.status().rejected, 1);
      assert.equal(metrics.status().queued, 0);
      await metrics.flush();
      const names = await peek(file, (db) =>
        db
          .prepare('select distinct metric from counters order by metric')
          .all()
          .map((row) => row.metric),
      );
      assert.deepStrictEqual(names, ['rejected_events']);
      assert.equal(await total(file, 'rejected_events'), 1);
    });

    it('dropped events: the bounded queue evicts the oldest first, keeps the newest and counts the drops', async () => {
      const { file, open } = fixture();
      const metrics = await open({ queueMax: 3 });
      for (let i = 1; i <= 5; i += 1) assert.equal(metrics.record(answer({ results: i })), undefined);
      assert.equal(metrics.status().queued, 3);
      assert.equal(metrics.status().dropped, 2);
      await metrics.flush();
      assert.equal(metrics.status().queued, 0);
      assert.equal(await total(file, 'answers_results'), 3 + 4 + 5, 'the survivors are the newest three');
      assert.equal(await total(file, 'dropped_events'), 2);
    });

    it('persists dropped and rejected totals so they survive a restart', async () => {
      const { file, open } = fixture();
      const first = await open({ queueMax: 1 });
      first.record(answer());
      first.record(answer());
      first.record({ kind: 'nope' } as unknown as MetricsEvent);
      await first.close();
      const second = await open();
      await second.close();
      assert.equal(await total(file, 'dropped_events'), 1);
      assert.equal(await total(file, 'rejected_events'), 1);
    });

    it('write failure: record never throws, writeFailures grows, recording stays true and a later flush writes', async () => {
      const { file, open } = fixture();
      const control = { fail: false };
      const metrics = await open({ driver: flaky(await loadDriver(driver), control) });
      control.fail = true;
      for (let i = 0; i < 100; i += 1) assert.equal(metrics.record(answer()), undefined);
      await assert.doesNotReject(metrics.flush());
      assert.ok(metrics.status().writeFailures >= 1);
      assert.equal(metrics.status().recording, true);
      assert.equal(await total(file, 'answers_calls'), 0);

      control.fail = false;
      await metrics.flush();
      assert.equal(await total(file, 'answers_calls'), 100, 'the events that could not be written were kept and written');
    });

    it('write failure: the flush timer keeps retrying and recovers without an explicit flush', async () => {
      const { file, clock, open } = fixture();
      const control = { fail: false };
      const metrics = await open({ driver: flaky(await loadDriver(driver), control), flushIntervalMs: 1000 });
      control.fail = true;
      metrics.record(answer());
      await clock.advance(1000);
      await settle();
      assert.ok(metrics.status().writeFailures >= 1);
      control.fail = false;
      await clock.advance(1000);
      await settle();
      assert.equal(await total(file, 'answers_calls'), 1);
    });

    it('events recorded while a flush is running are neither lost nor double counted', async () => {
      const { file, open } = fixture();
      const metrics = await open();
      for (let i = 0; i < 5; i += 1) metrics.record(answer());
      const running = metrics.flush();
      for (let i = 0; i < 5; i += 1) metrics.record(answer());
      await running;
      await metrics.flush();
      assert.equal(await total(file, 'answers_calls'), 10);
      const report = await metrics.report(ALL);
      assert.equal(report.answers.total, 10);
    });

    it('arms one flush timer on the first accepted event and flushes when the interval passes', async () => {
      const { file, clock, open } = fixture();
      const metrics = await open({ flushIntervalMs: 2000 });
      metrics.record(answer());
      metrics.record(answer());
      await clock.advance(1999);
      await settle();
      assert.equal(await total(file, 'answers_calls'), 0, 'not flushed before the interval');
      await clock.advance(1);
      await settle();
      assert.equal(await total(file, 'answers_calls'), 2);
    });

    it('leaves no pending timer after an explicit flush, a timed flush or close', async () => {
      const counted = countingClock(new FakeClock(START));
      const { open } = fixture(counted.clock);
      const metrics = await open({ flushIntervalMs: 1000 });
      assert.equal(counted.live(), 0);
      metrics.record(answer());
      assert.equal(counted.live(), 1);
      metrics.record(answer());
      assert.equal(counted.live(), 1, 'one timer for the whole batch');
      await metrics.flush();
      assert.equal(counted.live(), 0, 'an explicit flush cancels the timer');
      metrics.record(answer());
      assert.equal(counted.live(), 1);
      await metrics.close();
      assert.equal(counted.live(), 0, 'close leaves no pending timer');
      assert.equal(metrics.record(answer()), undefined);
      assert.equal(counted.live(), 0, 'a closed instance arms nothing');
      assert.equal(metrics.status().recording, false);
    });

    const counterRows = (file: string): Promise<string[]> =>
      peek(file, (db) =>
        db
          .prepare('select grain, bucket, metric, dim, value from counters order by grain, bucket, metric, dim')
          .all()
          .map((r) => `${String(r.grain)}|${String(r.bucket)}|${String(r.metric)}|${String(r.dim)}|${String(r.value)}`),
      );

    it('bucket edge: a latency equal to an edge counts in that bucket, one above the last edge in the overflow bucket', async () => {
      const { open } = fixture();
      const metrics = await open();
      for (const latencyMs of [0, 1, 5, 5000, 5001]) metrics.record(answer({ latencyMs }));
      for (const lagMs of [0, 10, 11, 5000, 5001]) metrics.record({ kind: 'freshness', lagMs });
      const report = await metrics.report(ALL);
      assert.equal(report.answers.latency.buckets.le1, 2, '0 and 1 ms');
      assert.equal(report.answers.latency.buckets.le5, 1, 'exactly 5 ms is in the 5 ms bucket');
      assert.equal(report.answers.latency.buckets.le5000, 1, 'exactly 5000 ms is in the 5000 ms bucket');
      assert.equal(report.answers.latency.buckets.inf, 1, '5001 ms is in the overflow bucket');
      assert.equal(report.freshness.buckets.le10, 2, 'a lag of 0 is in the first lag bucket, and so is 10');
      assert.equal(report.freshness.buckets.le50, 1);
      assert.equal(report.freshness.buckets.le5000, 1);
      assert.equal(report.freshness.buckets.inf, 1);
      assert.equal(report.freshness.count, 5);
    });

    it('percentiles are the upper edges of the buckets holding those ranks; null with no samples', async () => {
      const { open } = fixture();
      const metrics = await open();
      const empty = await metrics.report(ALL);
      assert.equal(empty.answers.latency.p50UpperBoundMs, null);
      assert.equal(empty.answers.latency.p95UpperBoundMs, null);
      assert.equal(empty.freshness.p50UpperBoundMs, null);
      assert.equal(empty.freshness.p95UpperBoundMs, null);
      for (let i = 0; i < 10; i += 1) metrics.record(answer({ latencyMs: 3 }));
      for (let i = 0; i < 10; i += 1) metrics.record(answer({ latencyMs: 150 }));
      const report = await metrics.report(ALL);
      assert.equal(report.answers.latency.count, 20);
      assert.equal(report.answers.latency.p50UpperBoundMs, 5);
      assert.equal(report.answers.latency.p95UpperBoundMs, 200);
      assert.equal(report.answers.latency.overflow, false);

      for (let i = 0; i < 10; i += 1) metrics.record(answer({ latencyMs: 9000 }));
      const slow = await metrics.report(ALL);
      assert.equal(slow.answers.latency.p95UpperBoundMs, 5000, 'the overflow bucket reports the largest finite edge');
      assert.equal(slow.answers.latency.overflow, true, 'and says it is a lower bound');
    });

    it('freshness events fill the lag histogram and index_health replaces the gauges, latest wins, with its timestamp', async () => {
      const { clock, open } = fixture();
      const metrics = await open();
      metrics.record({ kind: 'freshness', lagMs: 80 });
      metrics.record({ kind: 'index_health', files: 100, errorFiles: 1, staleFiles: 2, sizeBytes: 1000 });
      await clock.advance(5000);
      metrics.record({ kind: 'index_health', files: 120, errorFiles: 0, staleFiles: 3, sizeBytes: 2000 });
      const report = await metrics.report(ALL);
      assert.equal(report.freshness.count, 1);
      assert.equal(report.freshness.p50UpperBoundMs, 100);
      assert.deepStrictEqual(report.indexHealth, {
        files: 120,
        errorFiles: 0,
        staleFiles: 3,
        sizeBytes: 2000,
        at: START + 5000,
      });
    });

    it('degraded values and truncation recorded on answers appear in the report with counts', async () => {
      const { open } = fixture();
      const metrics = await open();
      metrics.record(answer({ degraded: ['stale', 'follower'], truncated: true }));
      metrics.record(answer({ degraded: ['stale'], truncated: true, ok: false }));
      metrics.record(answer({ tool: 'code_refs' }));
      const report = await metrics.report(ALL);
      assert.deepStrictEqual(report.degraded, { stale: 2, follower: 1 });
      assert.equal(report.answers.truncated, 2);
      assert.equal(report.answers.total, 3);
      assert.equal(report.answers.ok, 2);
      assert.deepStrictEqual(report.answers.byTool, { code_find: 2, code_refs: 1 });
    });

    it('a report over an empty database is all zeros with null percentiles and an empty degraded map', async () => {
      const { open } = fixture();
      const metrics = await open();
      const report = await metrics.report(ALL);
      assert.equal(report.answers.total, 0);
      assert.equal(report.answers.ok, 0);
      assert.equal(report.answers.truncated, 0);
      assert.deepStrictEqual(report.answers.byTool, {});
      assert.deepStrictEqual(report.degraded, {});
      assert.equal(report.freshness.count, 0);
      assert.equal(report.freshness.p50UpperBoundMs, null);
      assert.equal(report.freshness.p95UpperBoundMs, null);
      assert.equal(report.indexHealth, null);
      assert.equal(report.tokens.estimatedTotal, 0);
      assert.equal(report.tokens.label, 'estimate');
      assert.deepStrictEqual(report.range, ALL);
    });

    it('a report range includes the hour and day buckets that overlap it and no others', async () => {
      const { clock, open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      await clock.advance(3 * 3_600_000);
      metrics.record(answer());
      await metrics.flush();
      assert.equal((await metrics.report({ since: START, until: START })).answers.total, 1);
      assert.equal((await metrics.report({ since: START + 3_600_000, until: START + 2 * 3_600_000 })).answers.total, 0);
      assert.equal((await metrics.report({ since: START, until: START + 3 * 3_600_000 })).answers.total, 2);
      assert.equal((await metrics.report({ since: START + 4 * 3_600_000, until: START + 5 * 3_600_000 })).answers.total, 0);
    });

    it('rollup merges hourly rows older than 7 days into one daily row per metric and dimension', async () => {
      const { file, clock, open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      await clock.advance(5 * 3_600_000);
      metrics.record(answer({ results: 4 }));
      await metrics.flush();
      const before = await metrics.report(ALL);
      await clock.advance(8 * 86_400_000);
      metrics.record(answer());
      await metrics.flush();
      await metrics.rollup();
      const rows = await counterRows(file);
      assert.ok(rows.some((r) => r.startsWith('day|2026-10-16|answers_calls|code_find|2')), 'two calls merged into one day row');
      assert.ok(rows.some((r) => r.startsWith('day|2026-10-16|answers_results|code_find|7')), 'results are summed');
      assert.equal(rows.filter((r) => r.startsWith('hour|2026-10-16')).length, 0, 'merged hourly rows are deleted');
      assert.ok(rows.some((r) => r.startsWith('hour|2026-10-24T')), 'rows younger than 7 days stay hourly');
      const after = await metrics.report(ALL);
      assert.equal(after.answers.total, before.answers.total + 1, 'rolling up changes no total');
      assert.equal(after.tokens.estimatedTotal, before.tokens.estimatedTotal + 120);
    });

    it('rollup deletes day rows older than 30 days', async () => {
      const { file, clock, open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      await metrics.flush();
      await clock.advance(31 * 86_400_000);
      await metrics.rollup();
      assert.deepStrictEqual(await counterRows(file), []);
    });

    it('rollup is idempotent: a second run changes nothing', async () => {
      const { file, clock, open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      metrics.record(answer({ tool: 'code_refs', degraded: ['stale'] }));
      await metrics.flush();
      await clock.advance(10 * 86_400_000);
      metrics.record(answer());
      await metrics.flush();
      await metrics.rollup();
      const once = await counterRows(file);
      await metrics.rollup();
      assert.deepStrictEqual(await counterRows(file), once);
      assert.ok(once.length > 0);
    });

    it('an event recorded while a rollup runs lands in exactly one bucket', async () => {
      const { file, clock, open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      await metrics.flush();
      await clock.advance(9 * 86_400_000);
      const rolling = metrics.rollup();
      metrics.record(answer());
      await rolling;
      await metrics.flush();
      const calls = (await counterRows(file))
        .filter((r) => r.includes('|answers_calls|'))
        .map((r) => Number(r.split('|')[4]));
      assert.equal(
        calls.reduce((a, b) => a + b, 0),
        2,
      );
      assert.equal((await metrics.report(ALL)).answers.total, 2);
    });

    it('reset deletes every counter and gauge and keeps the schema and user_version', async () => {
      const { file, open } = fixture();
      const metrics = await open();
      metrics.record(answer());
      metrics.record({ kind: 'index_health', files: 1, errorFiles: 0, staleFiles: 0, sizeBytes: 1 });
      await metrics.flush();
      metrics.record(answer());
      await metrics.reset();
      assert.equal(metrics.status().queued, 0, 'the queue is dropped too');
      assert.deepStrictEqual(await counterRows(file), []);
      assert.equal(await peek(file, (db) => db.prepare('select count(*) as n from gauges').get()?.n), 0);
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 2);
      assert.equal(metrics.status().recording, true);
      metrics.record(answer());
      assert.equal((await metrics.report(ALL)).answers.total, 1, 'recording continues after a reset');
    });

    it('privacy: every string stored is a member of the closed vocabulary, and a path key leaves the dump unchanged', async () => {
      const { file, open } = fixture();
      const metrics = await open();
      for (const tool of TOOL_NAMES) {
        metrics.record(answer({ tool, degraded: [...DEGRADED_CODES], truncated: true, latencyMs: 1 }));
        for (const latencyMs of [...LATENCY_BUCKETS_MS, 99_999]) metrics.record(answer({ tool, latencyMs }));
      }
      for (const lagMs of [...LAG_BUCKETS_MS, 99_999]) metrics.record({ kind: 'freshness', lagMs });
      metrics.record({ kind: 'index_health', files: 3, errorFiles: 1, staleFiles: 1, sizeBytes: 10 });
      metrics.record({ kind: 'nope' } as unknown as MetricsEvent);
      await metrics.flush();
      await metrics.rollup();

      const allowed = new Set<string>([
        ...GRAINS,
        ...COUNTER_METRICS,
        ...GAUGE_METRICS,
        ...META_KEYS,
        DIM_NONE,
        ...TOOL_NAMES,
        ...DEGRADED_CODES,
        ...bucketLabels(LAG_BUCKETS_MS),
        ...bucketLabels(LATENCY_BUCKETS_MS),
        ...TOOL_NAMES.flatMap((tool) => bucketLabels(LATENCY_BUCKETS_MS).map((label) => `${tool}|${label}`)),
      ]);
      const stored = (): Promise<string[]> =>
        peek(file, (db) => {
          const out = new Set<string>();
          for (const table of ['counters', 'gauges', 'meta']) {
            for (const row of db.prepare(`select * from ${table}`).all()) {
              for (const value of Object.values(row)) if (typeof value === 'string') out.add(value);
            }
          }
          return [...out].sort();
        });
      const before = await stored();
      assert.ok(before.length > 20);
      for (const value of before) {
        assert.ok(allowed.has(value) || /^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(value), `unexpected stored string: ${value}`);
      }

      const marker = 'secret-path-marker/src/private.ts';
      metrics.record({ ...answer(), path: marker } as unknown as MetricsEvent);
      metrics.record({ ...answer(), symbol: marker } as unknown as MetricsEvent);
      metrics.record({ kind: 'freshness', lagMs: 1, repo: marker } as unknown as MetricsEvent);
      await metrics.flush();
      assert.deepStrictEqual(await stored(), before);
      for (const suffix of ['', '-wal']) {
        const candidate = `${file}${suffix}`;
        if (fs.existsSync(candidate)) {
          assert.ok(!fs.readFileSync(candidate).includes(marker), `${candidate} must not contain the marker`);
        }
      }
    });
  });
}
