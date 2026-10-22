import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createSourceTree, defaultPatterns } from '../source-tree/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { allowAll, createRealRunner, gitSpec } from './index.ts';
import type { CommandResult, CommandRunner, CommandSpec } from './index.ts';

const decoder = new TextDecoder();

/** Setup (init, add, commit) is not in the production allowlist, so it uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

/** Loose objects under `.git/objects`: every file in a two-hex-digit directory (packs and info are not loose objects). */
function countLooseObjects(repoDir: string): number {
  const objects = path.join(repoDir, '.git', 'objects');
  let count = 0;
  for (const entry of fs.readdirSync(objects, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    count += fs.readdirSync(path.join(objects, entry.name)).length;
  }
  return count;
}

describe('production git rule: option allowlist against a real repository (WR-11, STO-09)', () => {
  it('no object written: a denied hash-object -w spelling starts nothing and the loose-object count is unchanged', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'alpha\n' } });
    t.after(() => repo.cleanup());
    const production = createRealRunner();
    const opts = { worktree: repo.dir, env: repo.envOverlay };
    const before = countLooseObjects(repo.dir);
    assert.ok(before > 0, 'the commit left loose objects to count');

    const spellings: ReadonlyArray<readonly string[]> = [
      ['hash-object', '-w', '--stdin'],
      ['hash-object', '-wt', 'blob', '--stdin'],
      ['hash-object', '-tw', 'blob', '--stdin'],
      ['hash-object', '--stdin-paths', '-w'],
    ];
    for (const sub of spellings) {
      const result = await production.run(gitSpec(sub, { ...opts, stdin: 'never written\n' }));
      assert.equal(result.ok, false, sub.join(' '));
      assert.equal(result.denied?.code, 'command_denied', sub.join(' '));
      assert.equal(result.exitCode, null, `${sub.join(' ')}: a denial starts nothing`);
    }
    assert.equal(countLooseObjects(repo.dir), before, 'the object database is untouched');
  });

  it('the allowed cat-file --batch-check runs against the same repository and reports a size for HEAD', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'alpha\n' } });
    t.after(() => repo.cleanup());
    const production = createRealRunner();
    const result = await production.run(gitSpec(['cat-file', '--batch-check'], { worktree: repo.dir, env: repo.envOverlay, stdin: 'HEAD\n' }));
    assert.equal(result.denied, undefined, 'cat-file --batch-check must be allowed');
    assert.equal(result.ok, true, decoder.decode(result.stderr));
    assert.match(decoder.decode(result.stdout).trim(), /^[0-9a-f]{40,64} commit [0-9]+$/);
  });
});

/**
 * A repository holding every kind of entry the ignore check meets: a tracked file, an untracked file, an ignored
 * file, a gitlink (registered through the index, so no network and no `git submodule` command) over a directory
 * that also holds a file, and an untracked nested repository.
 */
async function listingRepo(t: { after(fn: () => void): void }): Promise<TempGitRepo> {
  const repo = await createTempGitRepo({
    runner: setupRunner,
    world: { committed: { 'tracked.ts': 'export const tracked = 1;\n' }, ignored: ['ignored.log'] },
  });
  t.after(() => repo.cleanup());
  repo.write('untracked.ts', 'export const untracked = 1;\n');
  repo.write('ignored.log', 'ignored\n');
  repo.write('vendor/sub/inner.ts', 'export const inner = 1;\n');
  const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await repo.git(['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`]);
  const init = await setupRunner.run({ executable: 'git', args: ['init', '--quiet', 'nested'], cwd: repo.dir, env: repo.envOverlay });
  assert.equal(init.ok, true, decoder.decode(init.stderr));
  return repo;
}

interface CapturedRun {
  readonly spec: CommandSpec;
  readonly result: CommandResult;
}

/** A runner that forwards to `inner` and remembers each spec with the result it got. */
function capturing(inner: CommandRunner): CommandRunner & { readonly runs: CapturedRun[] } {
  const runs: CapturedRun[] = [];
  return {
    runs,
    run: async (spec, ctx) => {
      const result = await inner.run(spec, ctx);
      runs.push({ spec, result });
      return result;
    },
    stream: (spec, ctx) => inner.stream(spec, ctx),
  };
}

/** The `--exclude <pattern>` pairs of a scope, as one string. */
const excludes = (scope: 'all' | 'tracked'): string => defaultPatterns(scope).flatMap((p) => ['--exclude', p]).join(' ');

/** Each distinct `ls-files ...` argument list the runner saw, with its exit code, sorted. Fails on a denial. */
function shapesOf(production: { readonly runs: readonly CapturedRun[] }): Array<[string, number | null]> {
  const shapes = new Map<string, number | null>();
  for (const { spec, result } of production.runs) {
    const at = spec.args.indexOf('ls-files');
    if (at === -1) continue;
    assert.equal(result.denied, undefined, spec.args.join(' '));
    shapes.set(spec.args.slice(at).join(' '), result.exitCode);
  }
  return [...shapes].sort(([a], [b]) => (a < b ? -1 : 1));
}

const names = (stdout: Uint8Array): string[] => decoder.decode(stdout).split('\0').filter((entry) => entry !== '').sort();

describe('production git rule: the ls-files shapes of Source Tree against the installed git (plan 02-46)', () => {
  it('the ignore check listing runs under the production rule on installed git', async (t) => {
    const repo = await listingRepo(t);
    const version = await setupRunner.run({ executable: 'git', args: ['--version'] });
    t.diagnostic(decoder.decode(version.stdout).trim());

    // The exact spec real.ts builds for the listing: the fixed options, no pathspec, nothing on stdin.
    const spec = gitSpec(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { worktree: repo.dir, env: repo.envOverlay });
    const result = await createRealRunner().run(spec);
    assert.equal(result.denied, undefined, 'the production rule must accept the listing');
    assert.equal(result.exitCode, 0, `installed git rejected the listing (129 means an unknown option): ${decoder.decode(result.stderr)}`);
    // A nested repository is one `dir/` entry, the gitlink is its own path, the file inside the gitlink directory is
    // not listed, and the ignored file is absent.
    assert.deepEqual(names(result.stdout), ['nested/', 'tracked.ts', 'untracked.ts', 'vendor/sub']);
  });

  // Changed on purpose by quick task 261021-re7: the listings now carry the built-in defaults as constant
  // `--exclude <pattern>` pairs, and two more listings exist (the tracked paths the tracked defaults remove, and the
  // untracked files without the defaults, which only counts what they removed).
  it('every ls-files shape Source Tree sends is accepted by installed git', async (t) => {
    const repo = await listingRepo(t);
    const production = capturing(createRealRunner());
    const tree = createSourceTree({ runner: production, repoDir: repo.dir, envOverlay: repo.envOverlay });

    // Source Tree throws git_failed on any non-zero exit, so these calls are themselves the probe.
    await tree.snapshot(repo.dir);
    const listed = await tree.unignoredPaths(repo.dir, ['tracked.ts', 'untracked.ts', 'ignored.log']);
    assert.deepEqual([...listed].sort(), ['tracked.ts', 'untracked.ts']);

    assert.deepEqual(shapesOf(production), [
      [`ls-files -z --cached --ignored ${excludes('tracked')}`, 0],
      [`ls-files -z --cached --others --exclude-standard ${excludes('all')}`, 0],
      ['ls-files -z --others --exclude-standard', 0],
      [`ls-files -z --others --exclude-standard ${excludes('all')}`, 0],
      ['ls-files -z -s', 0],
    ]);
  });

  it('with a .atlasignore the second-stage shapes are accepted by installed git too, and git reads the file', async (t) => {
    const repo = await listingRepo(t);
    repo.write('.atlasignore', 'untracked.ts\n');
    const production = capturing(createRealRunner());
    const tree = createSourceTree({ runner: production, repoDir: repo.dir, envOverlay: repo.envOverlay });

    const snapshot = await tree.snapshot(repo.dir);
    assert.ok(!snapshot.files.has('untracked.ts'), 'git evaluated the file');
    const listed = await tree.unignoredPaths(repo.dir, ['tracked.ts', 'untracked.ts', 'ignored.log']);
    assert.deepEqual([...listed].sort(), ['tracked.ts']);

    const flag = '--exclude-per-directory=.atlasignore';
    const second = shapesOf(production).filter(([shape]) => shape.includes(flag));
    assert.deepEqual(second, [
      [`ls-files -z --cached --ignored ${flag} ${excludes('tracked')}`, 0],
      [`ls-files -z --cached --others ${flag} ${excludes('all')}`, 0],
      [`ls-files -z --others ${flag} ${excludes('all')}`, 0],
    ]);
  });
});
