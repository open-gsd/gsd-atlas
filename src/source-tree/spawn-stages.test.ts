/**
 * Plan 02-46: the Source Tree calls an edit or a new file makes, counted as SEQUENTIAL spawn stages without a clock.
 * A gate withholds every process result until the test releases it (`createRunGate`), so the processes held together
 * in one stage are the ones the flow starts concurrently. The Indexer-driven version of these cases, with the error
 * semantics, lives in `src/indexer/spawn-stages.test.ts` (the module boundary keeps this file from importing it).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { CommandResult, CommandRunner, CommandSpec, RecordingRunner, RunContext } from '../command-runner/index.ts';
import { collectStages, createRunGate, createTempGitRepo } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { createSourceTree } from './index.ts';
import type { SourceTree } from './index.ts';

const setupRunner = createRealRunner({ decide: allowAll });

const subcommandOf = (spec: { readonly args: readonly string[] }): string => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i] ?? '?';
};

const OPTIONS = { extensions: ['.ts'], maxBytes: 10000 } as const;

interface Rig {
  readonly repo: TempGitRepo;
  readonly tree: SourceTree;
  readonly recorder: RecordingRunner;
  stagesOf(operation: () => Promise<unknown>): Promise<string[][]>;
}

async function rig(t: TestContext): Promise<Rig> {
  const repo = await createTempGitRepo({
    runner: setupRunner,
    world: { committed: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', '.gitattributes': 'src/gen.ts linguist-generated\n' } },
  });
  t.after(() => repo.cleanup());
  const recorder = createRecordingRunner({ delegate: createRealRunner() });
  const gate = createRunGate<CommandSpec, RunContext, CommandResult>((spec, ctx) => recorder.run(spec, ctx));
  let gating = false;
  const runner: CommandRunner = {
    stream: (spec, ctx) => recorder.stream(spec, ctx),
    run: (spec, ctx) => (gating ? gate.run(spec, ctx) : recorder.run(spec, ctx)),
  };
  const tree = createSourceTree({ runner, repoDir: repo.dir, envOverlay: repo.envOverlay });
  return {
    repo,
    tree,
    recorder,
    async stagesOf(operation) {
      gating = true;
      try {
        return (await collectStages(gate, operation())).map((specs) => specs.map(subcommandOf).sort());
      } finally {
        gating = false;
      }
    },
  };
}

/** What `prepare` does after the ignore verdict: attributes start beside the filter enumeration, then sourceSet. */
async function prepareLike(tree: SourceTree, worktree: string, paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const attributes = tree.pathAttributes(worktree, paths);
  attributes.catch(() => undefined);
  const hashed = await tree.hashPaths(worktree, paths);
  const set = await tree.sourceSet(worktree, hashed.files, { ...OPTIONS, attributes: await attributes });
  return set.files;
}

describe('sequential spawn stages of the Source Tree calls (plan 02-46)', () => {
  it('edit is two stages', async (t) => {
    const { repo, tree, stagesOf } = await rig(t);
    repo.write('src/a.ts', 'export const a = 2;\n');
    let kept: ReadonlyMap<string, string> = new Map();
    const stages = await stagesOf(async () => {
      kept = await prepareLike(tree, repo.dir, ['src/a.ts']);
    });
    // config with check-attr, then hash-object: three spawns in two stages.
    assert.deepEqual(stages, [['check-attr', 'config'], ['hash-object']]);
    assert.deepEqual([...kept.keys()], ['src/a.ts']);
  });

  it('new file is three stages (the first holds the two concurrent listings)', async (t) => {
    const { repo, tree, stagesOf } = await rig(t);
    repo.write('src/new.ts', 'export const fresh = 1;\n');
    let kept: ReadonlyMap<string, string> = new Map();
    const stages = await stagesOf(async () => {
      const listed = await tree.unignoredPaths(repo.dir, ['src/new.ts']);
      assert.deepEqual([...listed], ['src/new.ts']);
      kept = await prepareLike(tree, repo.dir, ['src/new.ts']);
    });
    // Changed on purpose by quick task 261021-re7: the ignore verdict is two concurrent listings (the tree's own list
    // without the built-in defaults, and the tracked paths the tracked defaults remove): one stage, two spawns.
    assert.deepEqual(stages, [['ls-files', 'ls-files'], ['check-attr', 'config'], ['hash-object']]);
    assert.deepEqual([...kept.keys()], ['src/new.ts']);
  });

  it('a deleted file starts no git run at all', async (t) => {
    const { repo, tree, recorder } = await rig(t);
    repo.remove('src/b.ts');
    assert.equal((await tree.pathAttributes(repo.dir, ['src/b.ts'])).size, 0);
    assert.equal((await prepareLike(tree, repo.dir, ['src/b.ts'])).size, 0);
    assert.equal(recorder.starts.length, 0);
  });

  it('sourceSet with a complete map starts no git, and with a map that lacks a path asks for exactly that path', async (t) => {
    const { repo, tree, recorder } = await rig(t);
    repo.write('src/gen.ts', 'export const generated = 1;\n');
    const { files } = await tree.hashPaths(repo.dir, ['src/a.ts', 'src/gen.ts']);
    const complete = await tree.pathAttributes(repo.dir, ['src/a.ts', 'src/gen.ts']);
    assert.deepEqual([...complete].sort(([x], [y]) => (x < y ? -1 : 1)), [
      ['src/a.ts', { generated: false, vendored: false }],
      ['src/gen.ts', { generated: true, vendored: false }],
    ]);

    recorder.reset();
    const covered = await tree.sourceSet(repo.dir, files, { ...OPTIONS, attributes: complete });
    assert.equal(recorder.starts.length, 0, 'a complete map is all sourceSet needs');
    assert.deepEqual([...covered.files.keys()], ['src/a.ts']);
    assert.ok(covered.skipped.some((d) => d.code === 'generated_skipped' && d.subject === 'src/gen.ts'));

    const partial = new Map([...complete].filter(([rel]) => rel === 'src/a.ts'));
    const viaPartial = await tree.sourceSet(repo.dir, files, { ...OPTIONS, attributes: partial });
    const asks = recorder.starts.filter((s) => subcommandOf(s) === 'check-attr');
    assert.equal(asks.length, 1);
    assert.equal(asks[0]?.stdin, 'src/gen.ts\0', 'only the path the map lacks is asked for');
    assert.deepEqual([...viaPartial.files.keys()], ['src/a.ts']);
  });

  it('filter list is never cached', async (t) => {
    const { repo, tree, recorder } = await rig(t);
    for (const n of [1, 2, 3]) {
      repo.write('src/a.ts', `export const a = ${String(n)};\n`);
      await tree.hashPaths(repo.dir, ['src/a.ts']);
    }
    assert.equal(recorder.starts.filter((s) => subcommandOf(s) === 'config').length, 3, 'one enumeration per hashPaths call');
  });
});
