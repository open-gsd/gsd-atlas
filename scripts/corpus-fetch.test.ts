import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createTempGitRepo, makeTempDir, realPath } from '../src/test-kit/index.ts';
import type { SetupResult, SetupRunner, SetupSpec, TempGitRepo } from '../src/test-kit/index.ts';
import { corpusRemote, fetchCorpus } from './corpus-fetch.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** A real git runner for the test kit: argument arrays only, no shell. */
const runner: SetupRunner = {
  run(spec: SetupSpec): Promise<SetupResult> {
    const result = spawnSync(spec.executable, [...spec.args], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...process.env, ...spec.env },
      ...(spec.stdin === undefined ? {} : { input: spec.stdin }),
    });
    return Promise.resolve({
      ok: result.status === 0,
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  },
};

interface Remote {
  readonly repo: TempGitRepo;
  readonly first: string;
  readonly second: string;
}

/** A local remote with two commits; `a.txt` exists at both, `b.txt` only at the second. */
async function makeRemote(): Promise<Remote> {
  const repo = await createTempGitRepo({ runner, files: { 'a.txt': 'first\n' } });
  const first = (await repo.git(['rev-parse', 'HEAD'])).trim();
  repo.write('b.txt', 'second\n');
  await repo.commitAll('second');
  const second = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await repo.setConfig('uploadpack.allowAnySHA1InWant', 'true');
  return { repo, first, second };
}

function manifestFor(sha: string): unknown {
  return {
    schemaVersion: 1,
    corpora: [
      { id: 'demo', repo: 'owner/demo', ref: 'main', sha, status: 'pinned', role: 'test corpus', pinnedAt: '2026-10-15' },
      { id: 'later', repo: null, ref: null, sha: null, status: 'unselected', role: 'not chosen yet' },
    ],
  };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe('corpusRemote', () => {
  it('builds the GitHub https URL from the manifest repo', () => {
    assert.equal(corpusRemote({ repo: 'open-gsd/gsd-core' }), 'https://github.com/open-gsd/gsd-core.git');
  });
});

describe('fetchCorpus', () => {
  it('checks out exactly the manifest SHA, detached and shallow, in a fresh directory under the destination', async () => {
    const remote = await makeRemote();
    const dest = makeTempDir();
    try {
      const result = await fetchCorpus({
        id: 'demo',
        destination: dest.path,
        remote: remote.repo.dir,
        manifest: manifestFor(remote.first),
      });
      assert.equal(result.sha, remote.first);
      assert.ok(path.resolve(result.dir).startsWith(realPath(dest.path) + path.sep), 'the checkout is under the destination');
      assert.equal(git(result.dir, ['rev-parse', 'HEAD']), remote.first);
      assert.equal(git(result.dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'HEAD is detached');
      assert.equal(git(result.dir, ['rev-list', '--count', 'HEAD']), '1', 'depth 1');
      assert.ok(fs.existsSync(path.join(result.dir, 'a.txt')));
      assert.equal(fs.existsSync(path.join(result.dir, 'b.txt')), false, 'the later commit is not checked out');

      const again = await fetchCorpus({
        id: 'demo',
        destination: dest.path,
        remote: remote.repo.dir,
        manifest: manifestFor(remote.second),
      });
      assert.notEqual(again.dir, result.dir, 'every call gets a fresh directory');
      assert.ok(fs.existsSync(path.join(again.dir, 'b.txt')));
    } finally {
      dest.cleanup();
      remote.repo.cleanup();
    }
  });

  it('refuses a corpus whose status is unselected, names the status and fetches nothing', async () => {
    const dest = makeTempDir();
    try {
      await assert.rejects(
        fetchCorpus({ id: 'later', destination: dest.path, remote: '/nonexistent/remote', manifest: manifestFor('a'.repeat(40)) }),
        (error: unknown) => error instanceof Error && error.message.includes('unselected'),
      );
      assert.deepEqual(fs.readdirSync(dest.path), [], 'nothing was created');
    } finally {
      dest.cleanup();
    }
  });

  it('refuses an id the manifest does not list', async () => {
    const dest = makeTempDir();
    try {
      await assert.rejects(
        fetchCorpus({ id: 'nope', destination: dest.path, manifest: manifestFor('a'.repeat(40)) }),
        (error: unknown) => error instanceof Error && error.message.includes('nope'),
      );
      assert.deepEqual(fs.readdirSync(dest.path), []);
    } finally {
      dest.cleanup();
    }
  });

  it('fails clearly for a SHA the remote does not have and leaves no partial directory behind', async () => {
    const remote = await makeRemote();
    const dest = makeTempDir();
    try {
      const missing = 'b'.repeat(40);
      await assert.rejects(
        fetchCorpus({ id: 'demo', destination: dest.path, remote: remote.repo.dir, manifest: manifestFor(missing) }),
        (error: unknown) => error instanceof Error && error.message.includes(missing),
      );
      assert.deepEqual(fs.readdirSync(dest.path), [], 'the partial directory was removed');
    } finally {
      dest.cleanup();
      remote.repo.cleanup();
    }
  });

  it('refuses a destination inside this repository working tree and creates nothing there', async () => {
    const inside = path.join(repoRoot, '.corpus-fetch-test-never-created');
    await assert.rejects(
      fetchCorpus({ id: 'demo', destination: inside, remote: '/nonexistent/remote', manifest: manifestFor('a'.repeat(40)) }),
      (error: unknown) => error instanceof Error && error.message.includes('inside'),
    );
    assert.equal(fs.existsSync(inside), false);
  });
});
