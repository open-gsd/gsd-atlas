/**
 * Plan 03-17 (SKL-02, D-16) at the CLI layer: `gsd-atlas rate` over the real composed Host rates what the flight
 * recorder remembers, and the ratings table of `metrics.db` holds the answer's id (or the feature, or the session id),
 * the value and the time, nothing else. The second Host stands for another process: the MCP server answers, a later CLI
 * run rates. Lives under scripts for the reason scripts/cli-e2e.test.ts gives.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ANSWER_ID_PATTERN, SESSION_ID_PATTERN } from '../src/facts/index.ts';
import { openDatabase } from '../src/sqlite/index.ts';
import { makeWorld, runWith } from './cli-e2e.test.ts';
import type { World } from './cli-e2e.test.ts';

interface RatingRow {
  readonly scope: string;
  readonly value: string;
  readonly answer_id: string | null;
  readonly feature: string | null;
  readonly session_id: string | null;
  readonly at: number;
}

async function ratings(world: World): Promise<RatingRow[]> {
  const db = await openDatabase(path.join(world.repo.dir, '.git', 'gsd-atlas', 'metrics.db'), { readOnly: true, timeoutMs: 2000 });
  try {
    return db
      .prepare('select at, scope, value, answer_id, feature, session_id from ratings order by rowid')
      .all()
      .map((row) => ({ ...row }) as unknown as RatingRow);
  } finally {
    db.close();
  }
}

describe('CLI rate over the real Host', () => {
  it('rate up rates the newest answer of this repository, one row with the id, the value and the time', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.cli(['build', '--repo', world.repo.dir])).code, 0);
    await world.cli(['find', 'helper', '--repo', world.repo.dir]);
    const second = await world.cli(['find', 'boot', '--repo', world.repo.dir]);
    const answerId = String(second.envelope['answer_id']);
    assert.match(answerId, ANSWER_ID_PATTERN);

    const before = Date.now();
    const rated = await world.cli(['rate', 'up', '--repo', world.repo.dir]);
    assert.equal(rated.code, 0, rated.stderr);
    assert.deepEqual(rated.envelope.data, { recorded: true, scope: 'answer', value: 'up', answer_id: answerId });
    assert.equal(rated.stderr.split('\n').filter((line) => line !== '').length, 1, 'one confirmation line');

    const rows = await ratings(world);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], at: 0 }, { at: 0, scope: 'answer', value: 'up', answer_id: answerId, feature: null, session_id: null });
    assert.ok((rows[0] as RatingRow).at >= before - 1000 && (rows[0] as RatingRow).at <= Date.now() + 1000, 'the time is now');
  });

  it('another process rates what the first one answered: the recorder is shared, the answer is not kept', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.cli(['build', '--repo', world.repo.dir])).code, 0);
    const answered = await world.cli(['find', 'helper', '--repo', world.repo.dir]);
    const later = world.another();
    const rated = await runWith(later, ['rate', 'down', '--repo', world.repo.dir], path.dirname(world.repo.dir));
    assert.equal(rated.code, 0, rated.stderr);
    assert.equal((rated.envelope.data as { answer_id: string }).answer_id, answered.envelope['answer_id']);
    const rows = await ratings(world);
    assert.deepEqual(rows.map((row) => [row.scope, row.value, row.answer_id]), [['answer', 'down', answered.envelope['answer_id']]]);
    // A process that only rates does not become the newest session: two rating processes name the answering one's.
    const cwd = path.dirname(world.repo.dir);
    const first = await runWith(world.another(), ['rate', 'up', '--session', '--repo', world.repo.dir], cwd);
    const next = await runWith(world.another(), ['rate', 'meh', '--session', '--repo', world.repo.dir], cwd);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(next.code, 0, next.stderr);
    const sessionId = (first.envelope.data as { session_id: string }).session_id;
    assert.match(sessionId, SESSION_ID_PATTERN);
    assert.equal((next.envelope.data as { session_id: string }).session_id, sessionId);
    const markers = fs
      .readFileSync(path.join(world.repo.dir, '.git', 'gsd-atlas', 'flight', 'flight.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"kind":"session"'));
    assert.equal(markers.length, 1, 'one marker, written by the process that answered');
    assert.ok(markers[0]?.includes(sessionId));
  });

  it('rate meh --feature code_refs and rate down --session each store one row with their own column', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.cli(['build', '--repo', world.repo.dir])).code, 0);
    await world.cli(['find', 'helper', '--repo', world.repo.dir]);
    const feature = await world.cli(['rate', 'meh', '--feature', 'code_refs', '--repo', world.repo.dir]);
    assert.equal(feature.code, 0, feature.stderr);
    const session = await world.cli(['rate', 'down', '--session', '--repo', world.repo.dir]);
    assert.equal(session.code, 0, session.stderr);
    const rows = await ratings(world);
    assert.deepEqual(
      rows.map((row) => [row.scope, row.value, row.answer_id, row.feature, row.session_id === null ? null : SESSION_ID_PATTERN.test(row.session_id)]),
      [
        ['feature', 'meh', null, 'code_refs', null],
        ['session', 'down', null, null, true],
      ],
    );
  });

  it('no recent answer exits 2 with the error envelope on stdout, and stores nothing', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.cli(['build', '--repo', world.repo.dir])).code, 0);
    const rated = await world.cli(['rate', 'up', '--repo', world.repo.dir]);
    assert.equal(rated.code, 2);
    assert.equal(rated.envelope.ok, false);
    assert.deepEqual(rated.envelope.diagnostics.map((d) => d.code), ['no_recent_answer']);
    assert.match(rated.stderr, /no_recent_answer/);
    assert.deepEqual(await ratings(world), []);
  });

  it('a usage error never reaches the Host: two scopes, a note flag or an unknown value', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.cli(['build', '--repo', world.repo.dir])).code, 0);
    for (const argv of [['rate', 'up', '--session', '--last'], ['rate', 'up', '--note', 'x'], ['rate', 'great']]) {
      const run = await world.cli(argv);
      assert.equal(run.code, 1, JSON.stringify(argv));
      assert.equal(run.stdout, '');
    }
    assert.deepEqual(await ratings(world), []);
  });
});
