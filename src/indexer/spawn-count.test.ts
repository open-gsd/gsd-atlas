/**
 * Plan 02-46: how many git processes one save costs. Save-to-find latency on a hosted Windows runner is the
 * debounce plus a number of SEQUENTIAL git spawns times the spawn cost, so the spawn COUNT per save is the
 * deterministic thing to hold: a counting runner over a real temporary repository and the real Indexer.
 *
 * An edit of a file the filter already knows starts 3 git processes (the clean-filter enumeration, the hash and the
 * attribute query); a new file starts 4 (one ignore listing first); a deleted file starts none.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createRecordingRunner } from '../command-runner/index.ts';
import type { RecordingRunner } from '../command-runner/index.ts';
import { THREE_FILES, makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommandOf = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

async function countedWorld(t: TestContext): Promise<{ readonly world: World; readonly runner: RecordingRunner }> {
  let runner: RecordingRunner | undefined;
  const world = await makeWorld(t, {
    files: THREE_FILES,
    wrapRunner: (real) => {
      runner = createRecordingRunner({ delegate: real });
      return runner;
    },
  });
  assert.ok(runner !== undefined, 'the runner was wrapped');
  await world.indexer.build(world.dir);
  runner.reset();
  return { world, runner };
}

const sequence = (runner: RecordingRunner): string[] => runner.starts.map((s) => subcommandOf(s) ?? '?');

describe('git spawns per save (plan 02-46)', () => {
  it('edit: 3 spawns', async (t) => {
    const { world, runner } = await countedWorld(t);
    world.repo.write('a.toy', 'fn main {\n}\nfn edited_one {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.deepEqual(sequence(runner), ['config', 'hash-object', 'check-attr']);
    assert.equal(runner.denials.length, 0);
    assert.equal((await world.reader.find('edited_one')).data.length, 1, 'the facts were committed');
  });

  it('new file: 4 spawns', async (t) => {
    const { world, runner } = await countedWorld(t);
    world.repo.write('d.toy', 'fn brand_new {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['d.toy']);
    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.equal(runner.starts.length, 4, sequence(runner).join(','));
    assert.deepEqual(sequence(runner), ['ls-files', 'config', 'hash-object', 'check-attr']);
    assert.equal(runner.denials.length, 0);
    assert.equal((await world.reader.find('brand_new')).data.length, 1, 'the facts were committed');
  });

  it('delete: 0 spawns', async (t) => {
    const { world, runner } = await countedWorld(t);
    assert.equal((await world.reader.find('helper')).data.length, 1, 'b.toy was indexed by the build');
    world.repo.remove('b.toy');
    const result = await world.indexer.ensureFresh(world.dir, ['b.toy']);
    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.deepEqual(sequence(runner), []);
    assert.equal((await world.reader.find('helper')).data.length, 0, 'the facts left the overlay');
  });
});
