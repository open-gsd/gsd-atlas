/**
 * Plan 03-17: the Host returns an `answer_id` on every tool answer (the five code tools and `lang_list`), added after
 * the answer exists, so the CLI and the MCP server (which print the Host's envelope unchanged) both carry it. The
 * kinds that are not tool answers (`build`, `maintain`, `status`, `index_state`) carry none.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANSWER_ID_PATTERN } from '../facts/index.ts';
import { makeWorld } from './harness.test.ts';

describe('Host: answer ids', () => {
  it('code_find, code_refs, atlas_status and lang_list answers each carry an answer_id; a build response does not', async (t) => {
    const world = await makeWorld(t);
    const built = await world.ask('build', { repo: world.repo.dir });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal(built.answer_id, undefined, 'a build is not a tool answer');

    const ids: string[] = [];
    for (const [kind, args] of [
      ['code_find', { name: 'helper', repo: world.repo.dir }],
      ['code_refs', { name: 'boot', repo: world.repo.dir }],
      ['code_context', { name: 'main', repo: world.repo.dir }],
      ['code_impact', { name: 'boot', repo: world.repo.dir }],
      ['atlas_status', { repo: world.repo.dir }],
      ['lang_list', {}],
    ] as const) {
      const reply = await world.ask(kind, args);
      assert.equal(reply.ok, true, `${kind}: ${JSON.stringify(reply.diagnostics)}`);
      assert.match(reply.answer_id ?? '', ANSWER_ID_PATTERN, kind);
      ids.push(reply.answer_id as string);
    }
    assert.equal(new Set(ids).size, ids.length, 'every answer has its own id');
  });

  it('maintain, status and index_state responses carry no answer_id', async (t) => {
    const world = await makeWorld(t);
    await world.ask('build', { repo: world.repo.dir });
    for (const [kind, args] of [
      ['maintain', { repo: world.repo.dir, task: 'check' }],
      ['status', { repo: world.repo.dir }],
      ['index_state', { repo: world.repo.dir }],
    ] as const) {
      const reply = await world.ask(kind, args);
      assert.equal(reply.answer_id, undefined, kind);
    }
  });

  it('a refused tool request is still an answer and is stamped; an unknown kind is not', async (t) => {
    const world = await makeWorld(t);
    const early = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(early.ok, false, 'nothing is built yet');
    assert.match(early.answer_id ?? '', ANSWER_ID_PATTERN);
    const invalid = await world.ask('code_find', { name: '', repo: world.repo.dir });
    assert.match(invalid.answer_id ?? '', ANSWER_ID_PATTERN);
    const unknown = await world.ask('nonsense', {});
    assert.equal(unknown.answer_id, undefined);
  });

  it('two answers to the same question get different ids', async (t) => {
    const world = await makeWorld(t);
    await world.ask('build', { repo: world.repo.dir });
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    const again = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.notEqual(reply.answer_id, again.answer_id);
  });
});
