import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createTempGitRepo, realPath } from '../test-kit/index.ts';
import { allowAll, createRealRunner, gitSpec } from './index.ts';

const decoder = new TextDecoder();

/**
 * Setup commands (init, add, commit, worktree add) are not in the production allowlist, so setup uses the
 * allow-all rule. The assertions run through a second runner built with the production default rule.
 */
const setupRunner = createRealRunner({ decide: allowAll });

describe('production git rule: ls-tree and worktree list (command-runner amendment 2026-10-16)', () => {
  it('lists a repository tree and its worktrees in one run, and refuses worktree add', async (t) => {
    const repo = await createTempGitRepo({
      runner: setupRunner,
      files: { 'a.txt': 'alpha\n', 'dir/b.ts': 'export const b = 1;\n' },
    });
    t.after(() => repo.cleanup());
    const linked = path.join(path.dirname(repo.dir), 'linked');
    await repo.git(['worktree', 'add', '--quiet', '-b', 'feature', linked]);

    const production = createRealRunner();
    const opts = { worktree: repo.dir, env: repo.envOverlay };

    const tree = await production.run(gitSpec(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], opts));
    assert.equal(tree.denied, undefined, 'ls-tree must be allowed');
    assert.equal(tree.ok, true, decoder.decode(tree.stderr));
    const paths = decoder.decode(tree.stdout).split('\0').filter((p) => p !== '').sort();
    assert.deepEqual(paths, ['a.txt', 'dir/b.ts']);

    const listing = await production.run(gitSpec(['worktree', 'list', '--porcelain', '-z'], opts));
    assert.equal(listing.denied, undefined, 'worktree list --porcelain -z must be allowed');
    assert.equal(listing.ok, true, decoder.decode(listing.stderr));
    const worktrees = decoder
      .decode(listing.stdout)
      .split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => realPath(field.slice('worktree '.length)));
    assert.equal(worktrees.length, 2);
    assert.deepEqual([...worktrees].sort(), [repo.dir, realPath(linked)].sort());

    const add = await production.run(gitSpec(['worktree', 'add', path.join(path.dirname(repo.dir), 'refused')], opts));
    assert.equal(add.ok, false);
    assert.equal(add.denied?.code, 'command_denied');
    assert.equal(add.exitCode, null, 'a denial starts nothing');
  });

  it('refuses worktree remove, bare worktree and worktree list without the porcelain z form', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'alpha\n' } });
    t.after(() => repo.cleanup());
    const production = createRealRunner();
    const opts = { worktree: repo.dir, env: repo.envOverlay };
    for (const sub of [
      ['worktree', 'remove', repo.dir],
      ['worktree'],
      ['worktree', 'list'],
      ['worktree', 'list', '--porcelain'],
      ['worktree', 'list', '--porcelain', '-z', 'extra'],
      ['status'],
    ]) {
      const result = await production.run(gitSpec(sub, opts));
      assert.equal(result.denied?.code, 'command_denied', sub.join(' '));
      assert.equal(result.exitCode, null, sub.join(' '));
    }
  });
});
