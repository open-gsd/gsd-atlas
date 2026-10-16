import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openDatabase } from '../sqlite/index.ts';
import type { Db, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { openMetrics } from './index.ts';
import type { AnswerEvent, Metrics, MetricsOptions, MetricsRange, Migration } from './index.ts';
import { MIGRATIONS } from './migrations.ts';

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

for (const driver of DRIVERS) {
  describe(`metrics database and migrations (${driver})`, () => {
    const dirs: TempDir[] = [];
    const opened: Metrics[] = [];
    afterEach(async () => {
      // Close every handle before removing the directory: Windows keeps open database files locked.
      for (const metrics of opened.splice(0)) await metrics.close();
      for (const dir of dirs.splice(0)) dir.cleanup();
    });

    function fixture() {
      const dir = makeTempDir();
      dirs.push(dir);
      const clock = new FakeClock(START);
      const file = path.join(dir.path, 'metrics.db');
      const open = async (options: MetricsOptions = {}): Promise<Metrics> => {
        const metrics = await openMetrics(file, { clock }, { driver, ...options });
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
  });
}
