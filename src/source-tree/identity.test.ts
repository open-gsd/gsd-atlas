/**
 * WR-06: the store identity is a function of the SET of root commits reachable from HEAD, never of the order
 * `git rev-list --max-parents=0 HEAD` happens to print them in.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import { pickRootCommit } from './identity.ts';
import { createSourceTree } from './index.ts';

const setupRunner = createRealRunner({ decide: allowAll });

/** The formula `storeId` has always had: independent of the implementation under test. */
const storeIdOf = (rootCommit: string | null, commonDir: string): string =>
  createHash('sha256').update(`${rootCommit ?? ''}\n${commonDir}`).digest('hex').slice(0, 16);

const A = `${'1'.repeat(39)}a`;
const B = `${'2'.repeat(40)}`;
const C = `${'f'.repeat(40)}`;

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

describe('pickRootCommit (WR-06)', () => {
  it('permutations: the same set in every order gives the smallest id', () => {
    for (const order of permutations([A, B, C])) {
      assert.equal(pickRootCommit(`${order.join('\n')}\n`), A, order.join(','));
    }
    assert.equal(pickRootCommit(`${B}\n${A}`), A, 'no trailing line feed');
  });

  it('one root gives that root; blank lines, surrounding whitespace, CRLF and invalid lines are ignored', () => {
    assert.equal(pickRootCommit(`${B}\n`), B);
    assert.equal(pickRootCommit(`\n  ${C}  \n\n${B}\r\nnot-an-id\n--oops\n${'g'.repeat(40)}\n`), B);
    assert.equal(pickRootCommit(`${'9'.repeat(64)}\n${'1'.repeat(64)}\n`), '1'.repeat(64));
  });

  it('empty output, only blanks and only invalid lines give null', () => {
    assert.equal(pickRootCommit(''), null);
    assert.equal(pickRootCommit('\n \n\r\n'), null);
    assert.equal(pickRootCommit('fatal: bad revision\n'), null);
  });

  it('compares by code unit, so upper-case hex (never printed by git) is not a valid id', () => {
    assert.equal(pickRootCommit(`${'A'.repeat(40)}\n${B}\n`), B);
  });
});

describe('Source Tree identity (WR-06)', () => {
  type RevList = { stdout?: string; exitCode?: number };
  /** A tree over a real repository directory whose `rev-list` is scripted, so the print order is the test's choice. */
  const treeOver = (repo: { dir: string; envOverlay: Record<string, string> }, revList: RevList) =>
    createSourceTree({
      runner: createRecordingRunner({
        respond: (spec) => (spec.args.includes('rev-list') ? revList : spec.args.includes('--git-common-dir') ? { stdout: '.git\n' } : undefined),
      }),
      repoDir: repo.dir,
      envOverlay: repo.envOverlay,
    });
  async function scripted(t: { after(fn: () => void): void }, revList: RevList) {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    return { repo, tree: treeOver(repo, revList), commonDir: fs.realpathSync.native(path.join(repo.dir, '.git')) };
  }

  it('permutations: the printed order of several roots changes neither rootCommit nor storeId', async (t) => {
    const { repo, commonDir } = await scripted(t, {});
    for (const order of permutations([A, B, C])) {
      const identity = await treeOver(repo, { stdout: `${order.join('\n')}\n` }).identity();
      assert.equal(identity.rootCommit, A, order.join(','));
      assert.equal(identity.storeId, storeIdOf(A, commonDir), order.join(','));
    }
  });

  it('single root unchanged: the id is the old formula over the one root and the real common directory', async (t) => {
    const { tree, commonDir } = await scripted(t, { stdout: `${B}\n` });
    const identity = await tree.identity();
    assert.equal(identity.rootCommit, B);
    assert.equal(identity.commonDir, commonDir);
    assert.equal(identity.storeId, storeIdOf(B, commonDir));
  });

  it('two roots: a real repository with an unrelated history merged in gets the smaller root, and keeps its id after another commit', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'main.txt': 'main\n' } });
    t.after(() => repo.cleanup());
    const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
    const mainRoot = (await repo.git(['rev-parse', 'HEAD'])).trim();

    await repo.git(['checkout', '--quiet', '--orphan', 'other']);
    await repo.git(['rm', '-r', '-f', '--quiet', '.']);
    repo.write('other.txt', 'other\n');
    await repo.commitAll('other root');
    const otherRoot = (await repo.git(['rev-parse', 'HEAD'])).trim();
    await repo.git(['checkout', '--quiet', 'main']);
    await repo.git(['merge', '--quiet', '--allow-unrelated-histories', '--no-edit', '-m', 'merge other', 'other']);

    const roots = (await repo.git(['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter((l) => l !== '');
    assert.deepEqual([...roots].sort(), [mainRoot, otherRoot].sort(), 'two roots are reachable');
    const smallest = [mainRoot, otherRoot].sort()[0];

    const before = await tree.identity();
    assert.equal(before.rootCommit, smallest);
    assert.equal(before.storeId, storeIdOf(smallest ?? null, before.commonDir));

    repo.write('later.txt', 'later\n');
    await repo.commitAll('later');
    const after = await tree.identity();
    assert.equal(after.rootCommit, smallest);
    assert.equal(after.storeId, before.storeId);
  });

  it('unborn: no root commit (exit 128), empty output and a repository without commits all give a null root', async (t) => {
    const failing = await scripted(t, { exitCode: 128, stdout: '' });
    assert.equal((await failing.tree.identity()).rootCommit, null);
    assert.equal((await failing.tree.identity()).storeId, storeIdOf(null, failing.commonDir));

    const empty = await scripted(t, { stdout: '' });
    assert.equal((await empty.tree.identity()).rootCommit, null);

    const fresh = await createTempGitRepo({ runner: setupRunner, world: { committed: {}, working: {}, ignored: [] } });
    t.after(() => fresh.cleanup());
    const tree = createSourceTree({ runner: createRealRunner(), repoDir: fresh.dir, envOverlay: fresh.envOverlay });
    const identity = await tree.identity();
    assert.equal(identity.rootCommit, null);
    assert.equal(identity.storeId, storeIdOf(null, identity.commonDir));
  });
});
