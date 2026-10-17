import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createTempGitRepo } from '../test-kit/index.ts';
import { allowAll, createRealRunner, gitSpec } from './index.ts';

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
