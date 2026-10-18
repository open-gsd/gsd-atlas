/**
 * Plan 03-17 (SKL-02, D-16): the Host's `rate` request records one local rating of the newest answer, a feature or the
 * session, and keeps ids and closed values only. It is a person's request: an MCP-origin Host refuses it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { ANSWER_ID_PATTERN, SESSION_ID_PATTERN } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { makeWorld, storeIdOf } from './harness.test.ts';
import type { World } from './harness.test.ts';

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);

async function builtWorld(t: TestContext): Promise<World> {
  const world = await makeWorld(t);
  const built = await world.ask('build', { repo: world.repo.dir });
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  return world;
}

const find = (world: World, name: string): Promise<Envelope> => world.ask('code_find', { name, repo: world.repo.dir });

const storeDirOf = (world: World): string => path.join(world.repo.dir, '.git', 'gsd-atlas');

describe('Host rate: the newest answer', () => {
  it('rates the newest recorded answer: the data names the id, and the reply is not itself an answer', async (t) => {
    const world = await builtWorld(t);
    const answered = await find(world, 'helper');
    const reply = await world.ask('rate', { repo: world.repo.dir, value: 'meh', scope: 'answer' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal(reply.schema, 'gsd-atlas.rate/1');
    assert.deepEqual(reply.data, { recorded: true, scope: 'answer', value: 'meh', answer_id: answered.answer_id });
    assert.equal(reply.answer_id, undefined, 'a rating is not a tool answer');
  });

  it('rates the newest answer, not the first, and rating does not become the newest answer', async (t) => {
    const world = await builtWorld(t);
    await find(world, 'helper');
    const second = await find(world, 'boot');
    const first = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'answer' });
    const again = await world.ask('rate', { repo: world.repo.dir, value: 'down', scope: 'answer' });
    assert.equal((first.data as { answer_id: string }).answer_id, second.answer_id);
    assert.equal((again.data as { answer_id: string }).answer_id, second.answer_id);
  });

  it('an explicit answer_id rates that answer, even when a newer one exists', async (t) => {
    const world = await builtWorld(t);
    const older = await find(world, 'helper');
    await find(world, 'boot');
    const reply = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'answer', answer_id: older.answer_id });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as { answer_id: string }).answer_id, older.answer_id);
  });

  it('no recent answer: a built repository nobody asked anything is a no_recent_answer error, not a crash', async (t) => {
    const world = await builtWorld(t);
    const reply = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'answer' });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['no_recent_answer']);
    assert.equal(reply.data, null);
  });

  it('no recent answer: a repository with no index says so without creating a store', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'answer' });
    assert.deepEqual(codes(reply), ['no_recent_answer']);
    assert.equal(fs.existsSync(storeDirOf(world)), false, 'rating created nothing (WR-01)');
    const feature = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'feature', feature: 'build' });
    assert.deepEqual(codes(feature), ['not_indexed']);
    assert.equal(fs.existsSync(storeDirOf(world)), false);
  });

  it('missing recorder: an unwritable recorder folder means no recent answer, while answers and feature ratings still work', async (t) => {
    const world = await builtWorld(t);
    fs.writeFileSync(path.join(storeDirOf(world), 'flight'), 'a file where the folder belongs');
    const answered = await find(world, 'helper');
    assert.equal(answered.ok, true);
    assert.match(answered.answer_id ?? '', ANSWER_ID_PATTERN);
    const last = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'answer' });
    assert.deepEqual(codes(last), ['no_recent_answer']);
    const feature = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'feature', feature: 'code_find' });
    assert.equal(feature.ok, true, JSON.stringify(feature.diagnostics));
  });
});

describe('Host rate: a feature and the session', () => {
  it('rates a feature from the closed list', async (t) => {
    const world = await builtWorld(t);
    for (const feature of ['code_refs', 'lang_list', 'skill', 'build', 'init']) {
      const reply = await world.ask('rate', { repo: world.repo.dir, value: 'meh', scope: 'feature', feature });
      assert.equal(reply.ok, true, `${feature}: ${JSON.stringify(reply.diagnostics)}`);
      assert.deepEqual(reply.data, { recorded: true, scope: 'feature', value: 'meh', feature });
    }
  });

  it('a feature outside the closed list, or missing, or given with another scope, is invalid_args', async (t) => {
    const world = await builtWorld(t);
    const base = { repo: world.repo.dir, value: 'up' };
    const refused: Array<Record<string, unknown>> = [
      { ...base, scope: 'feature', feature: 'nonsense' },
      { ...base, scope: 'feature' },
      { ...base, scope: 'answer', feature: 'code_find' },
      { ...base, scope: 'session', feature: 'code_find' },
      { ...base, scope: 'feature', feature: 'code_find', answer_id: 'a_0123456789abcdef' },
    ];
    for (const args of refused) {
      const reply = await world.ask('rate', args);
      assert.deepEqual(codes(reply), ['invalid_args'], JSON.stringify(args));
    }
  });

  it('rates the session of the newest session marker, and says no_recent_session before anything was answered', async (t) => {
    const world = await builtWorld(t);
    const early = await world.ask('rate', { repo: world.repo.dir, value: 'down', scope: 'session' });
    assert.deepEqual(codes(early), ['no_recent_session']);
    await find(world, 'helper');
    const one = await world.ask('rate', { repo: world.repo.dir, value: 'down', scope: 'session' });
    assert.equal(one.ok, true, JSON.stringify(one.diagnostics));
    const data = one.data as { scope: string; value: string; session_id: string };
    assert.equal(data.scope, 'session');
    assert.match(data.session_id, SESSION_ID_PATTERN);
    await find(world, 'boot');
    const two = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'session' });
    assert.equal((two.data as { session_id: string }).session_id, data.session_id, 'one Tenant, one session');
  });
});

describe('Host rate: arguments are closed', () => {
  it('an unknown value, an extra key (including a note), a malformed id or arguments that are not an object are invalid_args', async (t) => {
    const world = await builtWorld(t);
    await find(world, 'helper');
    const good = { repo: world.repo.dir, value: 'up', scope: 'answer' };
    const refused: unknown[] = [
      { ...good, value: 'great' },
      { ...good, value: 'UP' },
      { ...good, value: undefined },
      { ...good, scope: 'everything' },
      { ...good, scope: undefined },
      { ...good, note: 'free text' },
      { ...good, comment: 'free text' },
      { ...good, answer_id: 'a_short' },
      { ...good, answer_id: 7 },
      { repo: world.repo.dir },
      'up',
      ['up'],
    ];
    for (const args of refused) {
      const reply = await world.ask('rate', args);
      assert.equal(reply.ok, false, JSON.stringify(args));
      assert.deepEqual(codes(reply), ['invalid_args'], JSON.stringify(args));
      assert.doesNotMatch(JSON.stringify(reply), /free text/, 'a refused argument is not echoed');
    }
    const fine = await world.ask('rate', good);
    assert.equal(fine.ok, true, JSON.stringify(fine.diagnostics));
  });
});

describe('Host rate: only a person rates', () => {
  it('a Host started for MCP refuses the request, whatever it carries', async (t) => {
    const world = await builtWorld(t);
    await find(world, 'helper');
    const agent = world.anotherHost({ origin: 'mcp' });
    const reply = await agent.handle({ protocol: 1, kind: 'rate', args: { repo: world.repo.dir, value: 'up', scope: 'answer' } });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['rate_forbidden']);
    const bad = await agent.handle({ protocol: 1, kind: 'rate', args: { nonsense: true } });
    assert.deepEqual(codes(bad), ['rate_forbidden'], 'refused before the arguments are read');
  });
});

describe('Host rate: a rating that cannot be saved', () => {
  it('a Host with metrics off answers rating_not_saved', async (t) => {
    const world = await makeWorld(t, { host: { metrics: false } });
    const built = await world.ask('build', { repo: world.repo.dir });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    const reply = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'feature', feature: 'code_find' });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['rating_not_saved']);
  });

  it('an unopenable metrics database answers rating_not_saved, and answers are unaffected', async (t) => {
    const world = await builtWorld(t);
    const answered = await find(world, 'helper');
    await world.host.closeTenant(await storeIdOf(world.repo));
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(storeDirOf(world), `metrics.db${suffix}`), { force: true });
    fs.mkdirSync(path.join(storeDirOf(world), 'metrics.db'));

    const last = await world.ask('rate', { repo: world.repo.dir, value: 'up', scope: 'answer' });
    assert.deepEqual(codes(last), ['rating_not_saved']);
    assert.equal(last.data, null);
    const again = await find(world, 'helper');
    assert.equal(again.ok, true);
    assert.equal(answered.ok, true);
  });
});
