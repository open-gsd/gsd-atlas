/**
 * `PathFilter.keep` (T-02-14) with the ignore oracle of plan 02-46: pathspec-free `ls-files` listings (since quick task
 * 261021-re7 two concurrent ones: the tree's own list without the built-in defaults, and the tracked paths the tracked
 * defaults remove), filtered in process by exact name, never a snapshot.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { RecordingRunner } from '../command-runner/index.ts';
import { INDEX_DEFAULT_EXCLUDES } from '../source-tree/default-excludes.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { createPathFilter } from './ignore.ts';

const setupRunner = createRealRunner({ decide: allowAll });

const subcommandOf = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

const listings = (runner: RecordingRunner): number => runner.starts.filter((s) => subcommandOf(s) === 'ls-files').length;

/** A tree over `repo` whose git runs are recorded and really executed. */
function recorded(repo: TempGitRepo): { readonly tree: SourceTree; readonly runner: RecordingRunner } {
  const runner = createRecordingRunner({ delegate: createRealRunner() });
  return { tree: createSourceTree({ runner, repoDir: repo.dir, envOverlay: repo.envOverlay }), runner };
}

/** The repository the category cases share. */
async function categoriesRepo(t: { after(fn: () => void): void }): Promise<{ repo: TempGitRepo; symlink: boolean }> {
  const repo = await createTempGitRepo({
    runner: setupRunner,
    world: {
      committed: { '.gitignore': '*.log\n!keep.log\nbuild/\n', 'tracked.ts': 'export const tracked = 1;\n', 'dir/inner.ts': 'export const inner = 1;\n' },
    },
  });
  t.after(() => repo.cleanup());
  repo.write('forced.log', 'tracked although ignored\n');
  await repo.git(['add', '-f', 'forced.log']);
  await repo.git(['commit', '--quiet', '--no-verify', '-m', 'forced']);
  repo.write('untracked.ts', 'export const untracked = 1;\n');
  repo.write('keep.log', 'negated\n');
  repo.write('drop.log', 'ignored\n');
  repo.write('build/out.js', 'in an ignored directory\n');
  repo.write('vendor/sub/inner.ts', 'inside a gitlink directory\n');
  const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await repo.git(['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`]);
  let symlink = true;
  try {
    fs.symlinkSync('tracked.ts', path.join(repo.dir, 'link.ts'));
  } catch {
    symlink = false;
  }
  return { repo, symlink };
}

describe('PathFilter.keep: the ignore verdict is one pathspec-free listing', () => {
  it('tracked, untracked, negated and tracked-but-ignored paths are kept; ignored ones are dropped; a missing path is kept', async (t) => {
    const { repo } = await categoriesRepo(t);
    const { tree, runner } = recorded(repo);
    const filter = createPathFilter(tree);
    const { kept, dropped } = await filter.keep(repo.dir, [
      'tracked.ts',
      'dir/inner.ts',
      'untracked.ts',
      'keep.log',
      'forced.log',
      'drop.log',
      'build/out.js',
      'gone.ts',
    ]);
    assert.deepEqual([...kept].sort(), ['dir/inner.ts', 'forced.log', 'gone.ts', 'keep.log', 'tracked.ts', 'untracked.ts']);
    assert.deepEqual([...dropped].sort(), ['build/out.js', 'drop.log']);
    // Changed on purpose by quick task 261021-re7: a verdict is two concurrent listings, not one.
    assert.equal(listings(runner), 2);
    assert.deepEqual(
      runner.starts.map((s) => subcommandOf(s)),
      ['ls-files', 'ls-files'],
      'two listings and nothing else: no config, no hash-object',
    );
  });

  it('a symbolic link, a directory and a gitlink directory are dropped with no git run', async (t) => {
    const { repo, symlink } = await categoriesRepo(t);
    const { tree, runner } = recorded(repo);
    const filter = createPathFilter(tree);
    const asked = ['dir', 'vendor/sub', ...(symlink ? ['link.ts'] : [])];
    const { kept, dropped } = await filter.keep(repo.dir, asked);
    assert.deepEqual(kept, []);
    assert.deepEqual([...dropped].sort(), [...asked].sort());
    assert.equal(runner.starts.length, 0, 'a non-regular path costs no git run at all');
  });

  it('a verdict is remembered: a second call for a kept path or an ignored path asks nothing', async (t) => {
    const { repo } = await categoriesRepo(t);
    const { tree, runner } = recorded(repo);
    const filter = createPathFilter(tree);
    const first = await filter.keep(repo.dir, ['untracked.ts', 'drop.log']);
    assert.deepEqual(first, { kept: ['untracked.ts'], dropped: ['drop.log'] });
    // Changed on purpose by quick task 261021-re7: a verdict is two concurrent listings, not one.
    assert.equal(listings(runner), 2);
    const second = await filter.keep(repo.dir, ['untracked.ts', 'drop.log']);
    assert.deepEqual(second, { kept: ['untracked.ts'], dropped: ['drop.log'] });
    assert.equal(listings(runner), 2, 'the memory answered');
  });

  it('editing a .gitignore clears the memory', async (t) => {
    const { repo } = await categoriesRepo(t);
    const { tree, runner } = recorded(repo);
    const filter = createPathFilter(tree);
    assert.deepEqual((await filter.keep(repo.dir, ['drop.log'])).dropped, ['drop.log']);
    // Changed on purpose by quick task 261021-re7: a verdict is two concurrent listings, not one.
    assert.equal(listings(runner), 2);
    repo.write('.gitignore', 'build/\n');
    const again = await filter.keep(repo.dir, ['.gitignore', 'drop.log']);
    assert.deepEqual([...again.kept].sort(), ['.gitignore', 'drop.log']);
    assert.equal(listings(runner), 4, 'the new rules were asked about');
  });

  it('keep never calls snapshot', async (t) => {
    const { repo } = await categoriesRepo(t);
    const { tree } = recorded(repo);
    let snapshots = 0;
    const guarded: SourceTree = {
      ...tree,
      snapshot: (worktree) => {
        snapshots += 1;
        return tree.snapshot(worktree);
      },
    };
    const filter = createPathFilter(guarded);
    await filter.keep(repo.dir, ['untracked.ts', 'drop.log', 'tracked.ts']);
    assert.equal(snapshots, 0);
  });

  it('one call with 500 undecided paths starts exactly one pair of listings, and its specs are the ones a single path gets', async (t) => {
    const { repo } = await categoriesRepo(t);
    const many: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      many.push(`bulk/file-${String(i)}.ts`);
      repo.write(`bulk/file-${String(i)}.ts`, `export const v${String(i)} = ${String(i)};\n`);
    }
    const one = recorded(repo);
    await createPathFilter(one.tree).keep(repo.dir, ['untracked.ts']);
    const bulk = recorded(repo);
    const { kept, dropped } = await createPathFilter(bulk.tree).keep(repo.dir, many);
    assert.equal(kept.length, 500);
    assert.equal(dropped.length, 0);
    // Changed on purpose by quick task 261021-re7: a verdict is two concurrent listings, not one.
    assert.equal(bulk.runner.starts.length, 2);
    assert.equal(one.runner.starts.length, 2);
    for (const [i, batch] of bulk.runner.starts.entries()) {
      const single = one.runner.starts[i];
      assert.ok(single !== undefined);
      assert.deepEqual(batch.args, single.args, 'no name on the command line, whatever the batch size');
      assert.deepEqual(batch.env, single.env);
      assert.equal(batch.stdin, undefined, 'nothing on stdin');
      assert.ok(batch.args.every((arg) => !arg.includes('bulk/')));
    }
  });

  it('a failed listing is git_failed and leaves the memory untouched', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const root = realPath(tmp.path);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
    let mode: 'fail' | 'ok' = 'fail';
    const runner = createRecordingRunner({
      // Only the listing that names untracked files too answers with a path (the other lists tracked defaults).
      respond: (spec) =>
        mode === 'fail' ? { exitCode: 128, stderr: 'fatal: not a git repository' } : spec.args.includes('--others') ? { stdout: 'a.ts\0' } : { stdout: '' },
    });
    const filter = createPathFilter(createSourceTree({ runner, repoDir: root }));

    await assert.rejects(() => filter.keep(root, ['a.ts', 'b.ts']), { code: 'git_failed' });
    // Changed on purpose by quick task 261021-re7: a verdict is two concurrent listings, not one.
    assert.equal(runner.starts.length, 2);
    mode = 'ok';
    // Nothing was remembered by the failure: both paths are asked about again, and the new answer is used.
    const retry = await filter.keep(root, ['a.ts', 'b.ts']);
    assert.equal(runner.starts.length, 4, 'the next call asked again');
    assert.deepEqual(retry, { kept: ['a.ts'], dropped: ['b.ts'] });
  });

  it('case folding on a case-folding file system', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: { 'src/Foo.ts': 'export const foo = 1;\n' } } });
    t.after(() => repo.cleanup());
    if (!fs.existsSync(path.join(repo.dir, 'src', 'foo.ts'))) {
      t.skip('the file system does not fold case; the scripted variant covers the comparison');
      return;
    }
    // The old oracle compared the watcher's spelling with git's by exact equality; so does the new one.
    const { tree } = recorded(repo);
    const filter = createPathFilter(tree);
    assert.deepEqual(await filter.keep(repo.dir, ['src/foo.ts']), { kept: [], dropped: ['src/foo.ts'] });
    assert.deepEqual(await filter.keep(repo.dir, ['src/Foo.ts']), { kept: ['src/Foo.ts'], dropped: [] });
    const snapshot = await tree.snapshot(repo.dir);
    assert.equal(snapshot.files.has('src/foo.ts'), false);
  });

  it('case folding with a different index spelling', async (t) => {
    // The index spells the file `src/Foo.ts`; the disk holds `src/foo.ts` (what a case-folding file system looks like).
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const root = realPath(tmp.path);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    const runner = createRecordingRunner({ respond: (spec) => ({ stdout: spec.args.includes('--others') ? 'src/Foo.ts\0' : '' }) });
    const filter = createPathFilter(createSourceTree({ runner, repoDir: root }));
    assert.deepEqual(await filter.keep(root, ['src/foo.ts']), { kept: [], dropped: ['src/foo.ts'] });
    // Missing on a case-sensitive file system, present and listed on a folding one: kept either way.
    assert.deepEqual(await filter.keep(root, ['src/Foo.ts']), { kept: ['src/Foo.ts'], dropped: [] });
  });
});

describe('PathFilter.keep: built-in defaults and .atlasignore (quick task 261021-re7, D-03)', () => {
  const trackedDefault = INDEX_DEFAULT_EXCLUDES.find((e) => e.appliesToTracked && /^[a-z]+\/$/.test(e.pattern));
  const untrackedOnly = INDEX_DEFAULT_EXCLUDES.find((e) => e.pattern === 'dist/');

  async function atlasRepo(t: { after(fn: () => void): void }): Promise<TempGitRepo> {
    const repo = await createTempGitRepo({
      runner: setupRunner,
      world: {
        committed: {
          '.atlasignore': 'hidden.txt\n',
          'sub/.atlasignore': 'nested.txt\n',
          'visible.ts': 'export const v = 1;\n',
          'hidden.txt': 'tracked and named by the root file\n',
          'sub/nested.txt': 'tracked and named by the nested file\n',
          'dist/t.ts': 'tracked under an untracked-only default\n',
          [`${trackedDefault?.pattern ?? 'out/'}t.ts`]: 'tracked under an applies-to-tracked default\n',
        },
        working: {
          'new-hidden.txt': 'untracked and named by the root file\n',
          'sub/deep/nested.txt': 'untracked and named by the nested file\n',
          'node_modules/pkg/x.ts': 'untracked under a default\n',
        },
      },
    });
    t.after(() => repo.cleanup());
    return repo;
  }

  it('drops watcher paths under a default (untracked), tracked ones only for an applies-to-tracked entry, and paths .atlasignore names', async (t) => {
    assert.ok(trackedDefault !== undefined && untrackedOnly?.appliesToTracked === false);
    const repo = await atlasRepo(t);
    const { tree } = recorded(repo);
    const filter = createPathFilter(tree);
    const asked = [
      'visible.ts',
      'hidden.txt',
      'new-hidden.txt',
      'sub/nested.txt',
      'sub/deep/nested.txt',
      'node_modules/pkg/x.ts',
      'dist/t.ts',
      `${trackedDefault.pattern}t.ts`,
    ];
    const { kept, dropped } = await filter.keep(repo.dir, asked);
    assert.deepEqual([...kept].sort(), ['dist/t.ts', 'visible.ts']);
    assert.deepEqual([...dropped].sort(), ['hidden.txt', 'new-hidden.txt', 'node_modules/pkg/x.ts', `${trackedDefault.pattern}t.ts`, 'sub/deep/nested.txt', 'sub/nested.txt']);
  });

  it('editing a .atlasignore clears the memory like a .gitignore does, and the new rules are asked about', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: { 'visible.ts': 'v\n', 'hidden.txt': 'h\n' } } });
    t.after(() => repo.cleanup());
    const { tree, runner } = recorded(repo);
    const filter = createPathFilter(tree);
    assert.deepEqual(await filter.keep(repo.dir, ['hidden.txt']), { kept: ['hidden.txt'], dropped: [] });
    assert.equal(listings(runner), 2);
    repo.write('.atlasignore', 'hidden.txt\n');
    const again = await filter.keep(repo.dir, ['.atlasignore', 'hidden.txt']);
    assert.deepEqual(again, { kept: ['.atlasignore'], dropped: ['hidden.txt'] });
    assert.ok(listings(runner) > 2, 'the new rules were asked about');
  });

  it('a verdict for an unusable .atlasignore ignores the file', async (t) => {
    const repo = await createTempGitRepo({
      runner: setupRunner,
      world: { committed: { '.atlasignore': `hidden.txt\n${'#'.repeat(70000)}\n`, 'hidden.txt': 'h\n' } },
    });
    t.after(() => repo.cleanup());
    const { tree } = recorded(repo);
    assert.deepEqual(await createPathFilter(tree).keep(repo.dir, ['hidden.txt']), { kept: ['hidden.txt'], dropped: [] });
  });
});
