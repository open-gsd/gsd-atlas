import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import { createRecordingRunner, decide, gitSpec, listFilterNames, neutraliseFilters, parseFilterNames } from './index.ts';

const W = process.platform === 'win32' ? 'C:/work/repo' : '/work/repo';
const NULL_DEV = process.platform === 'win32' ? 'NUL' : os.devNull;

describe('gitSpec: every git command is built here', () => {
  it('prepends -C, the three hardening overrides and one neutralisation per filter driver', () => {
    const spec = gitSpec(['hash-object', '--stdin-paths'], { worktree: W, filterNames: ['evil'] });
    assert.equal(spec.executable, 'git');
    assert.equal(spec.builtinId, 'git');
    assert.deepEqual(spec.args, [
      '-C', W,
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${NULL_DEV}`,
      '-c', 'core.quotepath=off',
      '-c', 'filter.evil.clean=',
      '-c', 'filter.evil.smudge=',
      '-c', 'filter.evil.process=',
      '-c', 'filter.evil.required=false',
      'hash-object', '--stdin-paths',
    ]);
  });

  it('sets GIT_OPTIONAL_LOCKS=0 and GIT_TERMINAL_PROMPT=0 and lets the caller overlay more', () => {
    const spec = gitSpec(['ls-files'], { worktree: W, env: { GIT_CONFIG_GLOBAL: '/x/empty' } });
    assert.equal(spec.env?.['GIT_OPTIONAL_LOCKS'], '0');
    assert.equal(spec.env?.['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(spec.env?.['GIT_CONFIG_GLOBAL'], '/x/empty');
  });

  it('passes stdin and limits through unchanged', () => {
    const spec = gitSpec(['hash-object', '--stdin-paths'], { worktree: W, stdin: 'a\nb\n', maxStdoutBytes: 99, timeoutMs: 1234 });
    assert.equal(spec.stdin, 'a\nb\n');
    assert.equal(spec.maxStdoutBytes, 99);
    assert.equal(spec.timeoutMs, 1234);
  });

  it('is accepted by the built-in decide, with and without driver neutralisation', () => {
    for (const sub of [['hash-object', '--stdin-paths'], ['ls-files', '-z', '-s'], ['cat-file', '-e', 'a'.repeat(40)], ['rev-list', '--max-parents=0', 'HEAD']]) {
      const d = decide(gitSpec(sub, { worktree: W, filterNames: ['evil', 'my.driver'] }), {});
      assert.equal(d.allowed, true, sub.join(' '));
    }
    assert.equal(decide(gitSpec(['config', '--name-only', '--get-regexp', '^filter\\.'], { worktree: W }), {}).allowed, true);
  });

  it('denies git status: it runs clean filters even with fsmonitor disabled', () => {
    const d = decide(gitSpec(['status'], { worktree: W, filterNames: ['evil'] }), {});
    assert.equal(d.allowed, false);
    const d2 = decide(gitSpec(['status', '--porcelain'], { worktree: W }), {});
    assert.equal(d2.allowed, false);
  });

  it('neutralises dotted driver names', () => {
    assert.deepEqual(neutraliseFilters(['my.driver']), [
      '-c', 'filter.my.driver.clean=',
      '-c', 'filter.my.driver.smudge=',
      '-c', 'filter.my.driver.process=',
      '-c', 'filter.my.driver.required=false',
    ]);
    const d = decide(gitSpec(['hash-object', '--stdin-paths'], { worktree: W, filterNames: ['my.driver'] }), {});
    assert.equal(d.allowed, true);
  });
});

describe('parseFilterNames', () => {
  it('turns key=value and name-only lines into unique sorted driver names', () => {
    const out = [
      'filter.evil.clean=node x',
      'filter.evil.smudge=node y',
      'filter.lfs.process=git-lfs filter-process',
      'filter.my.driver.smudge',
      'filter.lfs.required',
      'core.fsmonitor=nope',
      'filter.badline',
    ].join('\n');
    assert.deepEqual(parseFilterNames(out), ['evil', 'lfs', 'my.driver']);
  });

  it('gives [] for empty output and ignores unrelated keys and CRLF line ends', () => {
    assert.deepEqual(parseFilterNames(''), []);
    assert.deepEqual(parseFilterNames('core.autocrlf\r\nuser.name\r\n'), []);
    assert.deepEqual(parseFilterNames('filter.a.clean\r\nfilter.b.clean\r\n'), ['a', 'b']);
  });
});

describe('listFilterNames', () => {
  it('reads names with a name-only config query and no neutralisation', async () => {
    const runner = createRecordingRunner({ script: [{ exitCode: 0, stdout: 'filter.evil.clean\nfilter.lfs.smudge\n' }] });
    const names = await listFilterNames(runner, W);
    assert.deepEqual(names, ['evil', 'lfs']);
    assert.equal(runner.starts.length, 1);
    const args = runner.starts[0]?.args ?? [];
    assert.deepEqual(args.slice(-3), ['--name-only', '--get-regexp', '^filter\\.']);
    assert.ok(!args.some((a) => a.startsWith('filter.')), 'a config read needs no neutralisation');
  });

  it('treats exit status 1 with empty output as "no drivers"', async () => {
    const runner = createRecordingRunner({ script: [{ exitCode: 1, stdout: '' }] });
    assert.deepEqual(await listFilterNames(runner, W), []);
  });

  it('throws on any other failure instead of pretending there are none', async () => {
    const runner = createRecordingRunner({ script: [{ exitCode: 128, stdout: '', stderr: 'fatal' }] });
    await assert.rejects(() => listFilterNames(runner, W), /git config/);
  });
});
