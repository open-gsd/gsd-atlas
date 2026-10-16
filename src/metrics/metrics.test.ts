import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Clock } from '../facts/index.ts';
import { DbError, loadDriver, openDatabase } from '../sqlite/index.ts';
import type { Db, DriverModule, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { createNoopMetrics, openMetrics } from './index.ts';
import type { AnswerEvent, Metrics, MetricsEvent, MetricsOptions, MetricsRange, Migration } from './index.ts';
import { MIGRATIONS } from './migrations.ts';
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
  it('accepts the three event shapes and returns a copy', () => {
    const events: MetricsEvent[] = [
      answer({ degraded: ['stale', 'follower'] }),
      { kind: 'freshness', lagMs: 12 },
      { kind: 'index_health', files: 10, errorFiles: 1, staleFiles: 2, sizeBytes: 4096 },
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

    it('creates metrics.db, applies migration 1 and sets user_version 1; reopening applies nothing', async () => {
      const { file, open } = fixture();
      const first = await open();
      assert.equal(first.status().recording, true);
      await first.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 1);
      const tables = await peek(file, (db) =>
        db
          .prepare(`select name from sqlite_master where type = 'table' order by name`)
          .all()
          .map((row) => row.name),
      );
      assert.deepStrictEqual(tables, ['counters', 'gauges', 'meta']);

      const second = await open();
      assert.equal(second.status().recording, true);
      await second.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 1);
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

    it('upgrades a version 1 database to an injected version 2 and keeps the version 1 data', async () => {
      const { file, open } = fixture();
      const v1 = await open();
      v1.record(answer({ results: 9 }));
      await v1.close();

      let ran = 0;
      const migrations: readonly Migration[] = [
        ...MIGRATIONS,
        {
          version: 2,
          up(db) {
            ran += 1;
            db.exec('create table extra (n integer not null)');
          },
        },
      ];
      const v2 = await open({ migrations });
      assert.equal(v2.status().recording, true);
      assert.equal(ran, 1);
      const report = await v2.report(ALL);
      assert.equal(report.answers.total, 1);
      await v2.close();
      assert.equal(await peek(file, (db) => db.pragma('user_version')), 2);
      assert.equal(
        await peek(file, (db) => db.prepare(`select count(*) as n from sqlite_master where name = 'extra'`).get()?.n),
        1,
      );

      const again = await open({ migrations });
      await again.close();
      assert.equal(ran, 1, 'a database already at version 2 applies nothing');
    });

    it('opens a database newer than the code as disabled with reason newer_schema and no exception', async () => {
      const { file, open } = fixture();
      const db = await openDatabase(file, { driver, timeoutMs: 1000 });
      db.exec('create table future (x integer)');
      db.pragma('user_version', 5);
      db.close();

      const migrations: readonly Migration[] = [
        ...MIGRATIONS,
        { version: 2, up: (d) => d.exec('create table extra (n integer not null)') },
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
  });
}
