import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Envelope } from '../facts/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { makeWorld, storeIdOf, toyModules, writeFiles } from './harness.test.ts';
import type { World } from './harness.test.ts';

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);

/** Poll until `check` holds; the work behind it runs on real I/O. */
async function eventually(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface FindData {
  readonly results: ReadonlyArray<{ readonly name: string; readonly path: string; readonly line: number; readonly citation: string }>;
}

async function built(world: World): Promise<void> {
  const reply = await world.ask('build', { repo: world.repo.dir });
  assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
}

describe('Host: build, then find', () => {
  it('a code_find before any build answers not_indexed naming gsd-atlas build, and indexes nothing', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['not_indexed']);
    assert.match(reply.diagnostics[0]?.message ?? '', /gsd-atlas build/);

    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
    assert.deepEqual((status.data as { worktrees: unknown[] }).worktrees, []);
    assert.equal(world.manual.subscriptions(), 0, 'nothing is watched before a build (D-11)');
  });

  it('fresh paths on a repository nobody built index nothing (D-11)', async (t) => {
    const world = await makeWorld(t);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir }, { fresh: ['b.toy'] });
    assert.deepEqual(codes(reply), ['not_indexed']);
    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.deepEqual((status.data as { worktrees: unknown[] }).worktrees, []);
    assert.equal((status.data as { indexer: unknown }).indexer, null, 'no Indexer was even created');
  });

  it('the build request is what makes find succeed; a second build parses nothing', async (t) => {
    const world = await makeWorld(t);
    const first = await world.ask('build', { repo: world.repo.dir });
    assert.equal(first.schema, 'gsd-atlas.build/1');
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    const data = first.data as { files: number; parsed: number };
    assert.equal(data.files, 3);
    assert.equal(data.parsed, 3);

    const found = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    const results = (found.data as FindData).results;
    assert.equal(results.length, 1);
    assert.equal(results[0]?.name, 'helper');
    assert.equal(results[0]?.path, 'b.toy');
    assert.equal(found.citations?.length, 1);
    assert.match(found.untrusted_text?.entries[0]?.text ?? '', /fn helper/);

    const second = await world.ask('build', { repo: world.repo.dir });
    assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
    assert.equal((second.data as { parsed: number }).parsed, 0);
  });

  it('code_refs and atlas_status are served; atlas_status shows this process as the lease holder and a watch mode', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const refs = await world.ask('code_refs', { name: 'boot', repo: world.repo.dir });
    assert.equal(refs.ok, true, JSON.stringify(refs.diagnostics));
    assert.equal(refs.schema, 'gsd-atlas.code-refs/1');

    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.equal(status.ok, true, JSON.stringify(status.diagnostics));
    const data = status.data as {
      store: { writerLeaseHeld: boolean };
      indexer: { watchMode: string } | null;
      worktrees: unknown[];
    };
    assert.equal(data.store.writerLeaseHeld, true);
    assert.equal(data.indexer?.watchMode, 'native');
    assert.equal(data.worktrees.length, 1);
  });

  it('fresh paths reach ensureFresh: an edit is found without waiting for the watcher (IDX-04)', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    writeFiles(world.repo.dir, { 'b.toy': 'fn helper_two {\n}\n' });
    const reply = await world.ask('code_find', { name: 'helper_two', repo: world.repo.dir }, { fresh: ['b.toy'] });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as FindData).results[0]?.name, 'helper_two');
    assert.equal(reply.degraded?.includes('fresh_timeout') ?? false, false);
  });
});

describe('Host: repository selection', () => {
  it('answers not_a_repo for a missing path, a file and a directory that is not in a git repository', async (t) => {
    const world = await makeWorld(t);
    const plain = fs.mkdtempSync(path.join(world.tmp.path, 'plain-'));
    for (const repo of [path.join(world.tmp.path, 'nosuch'), path.join(world.repo.dir, 'a.toy'), plain]) {
      const requests: Array<[string, Record<string, unknown>]> = [
        ['code_find', { name: 'x', repo }],
        ['build', { repo }],
        ['atlas_status', { repo }],
      ];
      for (const [kind, args] of requests) {
        const reply = await world.ask(kind, args);
        assert.equal(reply.ok, false, `${kind} ${repo}`);
        assert.deepEqual(codes(reply), ['not_a_repo'], `${kind} ${repo}`);
      }
    }
  });

  it('a cwd inside a subdirectory resolves to the repository, and the Host default is its own working directory', async (t) => {
    const world = await makeWorld(t);
    const sub = path.join(world.repo.dir, 'sub');
    fs.mkdirSync(sub);
    const reply = await world.ask('build', { cwd: sub });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as { files: number }).files, 3);
    const found = await world.ask('code_find', { name: 'helper' });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results.length, 1);
  });

  it('a cwd inside a linked worktree selects that worktree overlay', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    const linked = await world.addWorktree('feature');
    const before = await world.ask('code_find', { name: 'helper', cwd: linked });
    assert.deepEqual(codes(before), ['not_indexed'], 'the linked worktree is not indexed until it is built');

    const reply = await world.ask('build', { cwd: linked });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const found = await world.ask('code_find', { name: 'helper', cwd: linked });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results[0]?.path, 'b.toy');

    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.equal((status.data as { worktrees: unknown[] }).worktrees.length, 2);
  });

  it('refuses arguments of the wrong type with invalid_args before opening anything', async (t) => {
    const world = await makeWorld(t);
    for (const args of [{ repo: 3 }, { cwd: '' }, { repo: [] }]) {
      const reply = await world.ask('build', args);
      assert.deepEqual(codes(reply), ['invalid_args'], JSON.stringify(args));
    }
    const unknownKey = await world.ask('build', { repo: world.repo.dir, surprise: true });
    assert.deepEqual(codes(unknownKey), ['invalid_args']);
  });
});

describe('Host: tenants', () => {
  it('closeTenant closes one tenant and the next request opens it again lazily', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    assert.equal(world.manual.subscriptions(), 1);
    const storeId = await storeIdOf(world.repo);

    await world.host.closeTenant(storeId);
    assert.equal(world.manual.subscriptions(), 0, 'closing the tenant stops its watcher');

    const found = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as FindData).results.length, 1);
    await eventually(() => world.manual.subscriptions() === 1, 'the reopened tenant to watch the indexed worktree');
  });

  it('close closes everything and leaves no watcher; a closed Host answers host_closed', async (t) => {
    const world = await makeWorld(t);
    await built(world);
    await world.host.close();
    assert.equal(world.manual.subscriptions(), 0);
    assert.deepEqual(world.manual.gitSubscriptions(), []);
    const reply = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.deepEqual(codes(reply), ['host_closed']);
    await world.host.close();
  });
});

describe('Host: lang kinds', () => {
  it('lang_list accepts the repo argument, which replaces roots.repoRoot for that call', async (t) => {
    const world = await makeWorld(t);
    const other = makeTempDir();
    t.after(() => {
      other.cleanup();
    });
    fs.cpSync(path.join(toyModules, 'toy'), path.join(other.path, '.gsd-atlas', 'languages', 'toy'), { recursive: true });
    const without = await world.ask('lang_list', {});
    assert.equal(without.ok, true);
    assert.equal((without.data as { modules: Array<{ source: string }> }).modules[0]?.source, 'builtin');
    const reply = await world.ask('lang_list', { repo: other.path });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal((reply.data as { modules: Array<{ source: string }> }).modules[0]?.source, 'repo');
    const bad = await world.ask('lang_list', { repo: 'relative/dir' });
    assert.deepEqual(codes(bad), ['invalid_args']);
  });
});
