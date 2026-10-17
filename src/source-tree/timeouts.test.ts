/**
 * WR-07: every git spec the Source Tree starts carries a finite timeout of its own. The structural case drives
 * every method of the tree through a recording runner and inspects each spec it forwarded, so a method added
 * later that forgets a timeout fails here. The runner's own default (`runner.defaultTimeoutMs`) is not what is
 * proven: the recording runner sits in front of it and sees the spec exactly as the Source Tree built it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { CommandResult, CommandRunner, CommandSpec } from '../command-runner/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import { createSourceTree } from './index.ts';

/** The largest timeout any Source Tree spec may carry: `git.hashBatchTimeoutMs` in 02-CONSTANTS.md. */
const MAX_TIMEOUT_MS = 120000;

const setupRunner = createRealRunner({ decide: allowAll });

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommand = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

describe('Source Tree git timeouts (WR-07)', () => {
  it('every method has a timeout', async (t) => {
    const repo = await createTempGitRepo({
      runner: setupRunner,
      files: { 'a.ts': 'export const a = 1;\n', 'dir/b.ts': 'export const b = 2;\n' },
    });
    t.after(() => repo.cleanup());
    repo.write('untracked.ts', 'export const u = 3;\n');
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: repo.dir, envOverlay: repo.envOverlay });

    const snapshot = await tree.snapshot(repo.dir);
    await tree.hashPaths(repo.dir, ['a.ts']);
    await tree.sourceSet(repo.dir, snapshot.files, { extensions: ['.ts'], maxBytes: 10000 });
    await tree.worktrees();
    const head = await tree.resolveCommit('HEAD');
    assert.ok(head !== null);
    assert.equal(await tree.hasObject(head), true);
    assert.notEqual(await tree.read(head, 'a.ts'), null);
    await tree.listTree(head);
    await tree.readMany(head, ['a.ts', 'dir/b.ts']);
    await tree.identity();
    await tree.readText(repo.dir, 'a.ts');

    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.length > 0);
    for (const spec of recording.starts) {
      const label = `${subcommand(spec) ?? '?'} ${spec.args.join(' ').slice(0, 80)}`;
      assert.equal(typeof spec.timeoutMs, 'number', `no timeout: ${label}`);
      assert.ok(Number.isFinite(spec.timeoutMs) && (spec.timeoutMs ?? 0) > 0, `bad timeout: ${label}`);
      assert.ok((spec.timeoutMs ?? Infinity) <= MAX_TIMEOUT_MS, `timeout over the hash-batch limit: ${label}`);
    }
    const subcommands = new Set(recording.starts.map((s) => subcommand(s)));
    for (const expected of ['config', 'ls-files', 'hash-object', 'check-attr', 'cat-file', 'rev-parse', 'ls-tree', 'rev-list', 'worktree']) {
      assert.ok(subcommands.has(expected), `${expected} was not exercised: ${[...subcommands].join(',')}`);
    }
  });

  it('hung git rejects', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.ts': 'x\n' } });
    t.after(() => repo.cleanup());
    // A git that never answers: the run ends only when the spec's own timeout fires, as the real runner would end it.
    const seen: CommandSpec[] = [];
    const timesOut = createRecordingRunner({ respond: () => ({ timedOut: true, exitCode: null }) });
    const hung: CommandRunner = {
      run(spec: CommandSpec): Promise<CommandResult> {
        seen.push(spec);
        if (spec.timeoutMs === undefined) return new Promise<CommandResult>(() => {});
        return timesOut.run(spec);
      },
      stream() {
        throw new Error('the Source Tree never streams');
      },
    };
    const tree = createSourceTree({ runner: hung, repoDir: repo.dir, envOverlay: repo.envOverlay });
    const guard = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('hasObject is still pending: its git spec has no timeout')), 2000);
      timer.unref();
    });
    await assert.rejects(
      () => Promise.race([tree.hasObject('a'.repeat(40)), guard]),
      (error: unknown) => (error as { code?: string }).code === 'git_failed' && /timed out/.test((error as Error).message),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.timeoutMs, 60000);
  });
});
