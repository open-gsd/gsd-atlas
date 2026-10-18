/**
 * Plan 03-17: the CLI prints the Host's envelope unchanged, so a tool answer printed by `gsd-atlas` carries the same
 * `answer_id` field the MCP server's JSON does (the MCP server prints the Host's envelope too). Lives under scripts
 * for the reason scripts/cli-e2e.test.ts gives: adapter tests may not import the composition root.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANSWER_ID_PATTERN } from '../src/facts/index.ts';
import { makeWorld } from './cli-e2e.test.ts';

describe('CLI: answer ids', () => {
  it('find, health and lang list print an answer_id; build prints none', async (t) => {
    const world = await makeWorld(t);
    const built = await world.cli(['build', '--repo', world.repo.dir]);
    assert.equal(built.code, 0, built.stderr);
    assert.equal(built.envelope['answer_id'], undefined);

    const found = await world.cli(['find', 'helper', '--repo', world.repo.dir]);
    assert.equal(found.code, 0, found.stderr);
    assert.match(String(found.envelope['answer_id']), ANSWER_ID_PATTERN);

    const health = await world.cli(['health', '--repo', world.repo.dir]);
    assert.match(String(health.envelope['answer_id']), ANSWER_ID_PATTERN);

    const langs = await world.cli(['lang', 'list']);
    assert.match(String(langs.envelope['answer_id']), ANSWER_ID_PATTERN);
    assert.notEqual(found.envelope['answer_id'], health.envelope['answer_id']);
  });
});
