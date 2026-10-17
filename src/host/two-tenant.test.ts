/**
 * The two-tenant smoke test (HST-02, T-02-68): two repositories in one Host are two independent compositions with
 * separate stores, watermarks and results, and closing one leaves the other serving.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createTempGitRepo } from '../test-kit/index.ts';
import { makeWorld, setupRunner, storeIdOf, writeFiles } from './harness.test.ts';

interface FindData {
  readonly results: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

interface StatusData {
  readonly worktrees: ReadonlyArray<{ readonly worktree: string; readonly seq: number }>;
}

describe('two tenants in one Host', () => {
  it('keep separate stores, watermarks and results, and closing one leaves the other serving', async (t) => {
    const world = await makeWorld(t, { files: { 'a.toy': 'fn alphaOnly {\n}\n', 'README.md': '# alpha\n' } });
    const second = await createTempGitRepo({
      runner: setupRunner,
      world: { committed: { 'b.toy': 'fn betaOnly {\n}\n', 'README.md': '# beta\n' } },
    });
    t.after(() => {
      second.cleanup();
    });
    const alpha = world.repo.dir;
    const beta = second.dir;

    for (const repo of [alpha, beta]) {
      const built = await world.ask('build', { repo });
      assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    }

    const own = await world.ask('code_find', { name: 'alphaOnly', repo: alpha });
    assert.equal((own.data as FindData).results[0]?.path, 'a.toy');
    const crossed = await world.ask('code_find', { name: 'alphaOnly', repo: beta });
    assert.equal(crossed.ok, true, JSON.stringify(crossed.diagnostics));
    assert.deepEqual((crossed.data as FindData).results, [], 'a request never reaches another tenant store');
    const betaOwn = await world.ask('code_find', { name: 'betaOnly', repo: beta });
    assert.equal((betaOwn.data as FindData).results.length, 1);

    // Separate store directories, each under its own repository's git directory.
    const panels = await Promise.all([alpha, beta].map((repo) => world.ask('status', { repo })));
    const dirs = panels.map((panel) => (panel.data as { tenant: { location: { dir: string } } }).tenant.location.dir);
    assert.notEqual(dirs[0], dirs[1]);
    assert.ok(dirs[0]?.startsWith(path.join(alpha, '.git')), dirs[0]);
    assert.ok(dirs[1]?.startsWith(path.join(beta, '.git')), dirs[1]);

    // Separate watermarks: two edits to alpha move its sequence, beta's stays where the build left it.
    const seqOf = async (repo: string): Promise<number> => {
      const status = await world.ask('atlas_status', { repo });
      return (status.data as StatusData).worktrees[0]?.seq ?? -1;
    };
    const betaBefore = await seqOf(beta);
    const alphaBefore = await seqOf(alpha);
    for (const edit of ['fn alphaOne {\n}\n', 'fn alphaTwo {\n}\n']) {
      writeFiles(alpha, { 'a.toy': edit });
      const name = edit.slice(3, 11);
      const fresh = await world.ask('code_find', { name, repo: alpha }, { fresh: ['a.toy'] });
      assert.equal((fresh.data as FindData).results[0]?.name, name);
    }
    assert.ok((await seqOf(alpha)) > alphaBefore, 'alpha moved');
    assert.equal(await seqOf(beta), betaBefore, 'beta did not');
    assert.notEqual(await seqOf(alpha), await seqOf(beta));

    // Closing alpha leaves beta serving; a request on alpha opens it again.
    await world.host.closeTenant(await storeIdOf(world.repo));
    const stillBeta = await world.ask('code_find', { name: 'betaOnly', repo: beta });
    assert.equal((stillBeta.data as FindData).results.length, 1);
    const againAlpha = await world.ask('code_find', { name: 'alphaTwo', repo: alpha });
    assert.equal(againAlpha.ok, true, JSON.stringify(againAlpha.diagnostics));
    assert.equal((againAlpha.data as FindData).results.length, 1);
  });
});
