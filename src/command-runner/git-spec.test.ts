import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import { createRecordingRunner, decide, gitSpec, listFilterNames, neutraliseFilters, parseFilterNames } from './index.ts';

const W = process.platform === 'win32' ? 'C:/work/repo' : '/work/repo';
const NULL_DEV = process.platform === 'win32' ? 'NUL' : os.devNull;

/** The (key, value) pairs of the GIT_CONFIG_COUNT/KEY_n/VALUE_n channel, in index order. */
function configChannel(env: Readonly<Record<string, string>> | undefined): Array<[string, string]> {
  const e = env ?? {};
  const count = Number(e['GIT_CONFIG_COUNT']);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < count; i += 1) out.push([e[`GIT_CONFIG_KEY_${String(i)}`] as string, e[`GIT_CONFIG_VALUE_${String(i)}`] as string]);
  return out;
}

describe('gitSpec: every git command is built here', () => {
  it('prepends -C and the three hardening overrides, and neutralises drivers through the env channel, not -c pairs', () => {
    const spec = gitSpec(['hash-object', '--stdin-paths'], { worktree: W, filterNames: ['evil', 'a=b'] });
    assert.equal(spec.executable, 'git');
    assert.equal(spec.builtinId, 'git');
    assert.deepEqual(spec.args, [
      '-C', W,
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${NULL_DEV}`,
      '-c', 'core.quotepath=off',
      'hash-object', '--stdin-paths',
    ]);
    assert.deepEqual(configChannel(spec.env), [
      ['filter.evil.clean', ''],
      ['filter.evil.smudge', ''],
      ['filter.evil.process', ''],
      ['filter.evil.required', 'false'],
      ['filter.a=b.clean', ''],
      ['filter.a=b.smudge', ''],
      ['filter.a=b.process', ''],
      ['filter.a=b.required', 'false'],
    ]);
    assert.equal(spec.env?.['GIT_CONFIG_COUNT'], '8');
  });

  it('declares GIT_CONFIG_COUNT 0 and no KEY or VALUE entries when there are no drivers', () => {
    const env = gitSpec(['ls-files'], { worktree: W }).env ?? {};
    assert.equal(env['GIT_CONFIG_COUNT'], '0');
    assert.deepEqual(Object.keys(env).filter((k) => /^GIT_CONFIG_(KEY|VALUE)_/.test(k)), []);
  });

  it('throws when the caller env carries any GIT_CONFIG_COUNT, KEY_n, VALUE_n or PARAMETERS spelling', () => {
    for (const key of ['GIT_CONFIG_COUNT', 'git_config_count', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'git_config_key_7', 'GIT_CONFIG_VALUE_0', 'Git_Config_Value_3']) {
      assert.throws(() => gitSpec(['ls-files'], { worktree: W, env: { [key]: 'x' } }), /GIT_CONFIG/i, key);
    }
  });

  it('drops case variants of the pinned keys so a case-insensitive duplicate cannot override a pin', () => {
    const env = gitSpec(['ls-files'], { worktree: W, env: { git_no_lazy_fetch: '0', Git_Allow_Protocol: 'file' } }).env ?? {};
    assert.equal(env['GIT_NO_LAZY_FETCH'], '1');
    assert.equal(env['GIT_ALLOW_PROTOCOL'], 'none');
    assert.deepEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'git_no_lazy_fetch' || k.toLowerCase() === 'git_allow_protocol').sort(), ['GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH']);
  });

  it('accepts the test-kit isolation overlay unchanged', () => {
    const overlay = { GIT_CONFIG_GLOBAL: '/x/e', GIT_CONFIG_SYSTEM: '/x/e', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const env = gitSpec(['ls-files'], { worktree: W, env: overlay }).env ?? {};
    for (const [k, v] of Object.entries(overlay)) assert.equal(env[k], v, k);
  });

  it('sets GIT_OPTIONAL_LOCKS=0 and GIT_TERMINAL_PROMPT=0 and lets the caller overlay more', () => {
    const spec = gitSpec(['ls-files'], { worktree: W, env: { GIT_CONFIG_GLOBAL: '/x/empty' } });
    assert.equal(spec.env?.['GIT_OPTIONAL_LOCKS'], '0');
    assert.equal(spec.env?.['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(spec.env?.['GIT_CONFIG_GLOBAL'], '/x/empty');
  });

  it('pins GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL=none for every allowed subcommand (CR-01)', () => {
    const subs: ReadonlyArray<readonly string[]> = [
      ['ls-files', '-z'],
      ['hash-object', '--stdin-paths'],
      ['cat-file', '-e', 'a'.repeat(40)],
      ['rev-parse', '--git-common-dir'],
      ['rev-list', '--max-parents=0', 'HEAD'],
      ['config', '--name-only', '--get-regexp', '^filter\\.'],
      ['check-attr', '-a', 'x'],
    ];
    for (const sub of subs) {
      const env = gitSpec(sub, { worktree: W }).env;
      assert.equal(env?.['GIT_NO_LAZY_FETCH'], '1', sub.join(' '));
      assert.equal(env?.['GIT_ALLOW_PROTOCOL'], 'none', sub.join(' '));
      assert.equal(env?.['GIT_OPTIONAL_LOCKS'], '0', sub.join(' '));
      assert.equal(env?.['GIT_TERMINAL_PROMPT'], '0', sub.join(' '));
    }
  });

  it('pinned values win over a caller env that tries to switch them off', () => {
    const env = gitSpec(['cat-file', '-e', 'a'.repeat(40)], {
      worktree: W,
      env: { GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'file:ssh', GIT_OPTIONAL_LOCKS: '1', GIT_TERMINAL_PROMPT: '1', GIT_CONFIG_GLOBAL: '/x/empty' },
    }).env;
    assert.equal(env?.['GIT_NO_LAZY_FETCH'], '1');
    assert.equal(env?.['GIT_ALLOW_PROTOCOL'], 'none');
    assert.equal(env?.['GIT_OPTIONAL_LOCKS'], '0');
    assert.equal(env?.['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(env?.['GIT_CONFIG_GLOBAL'], '/x/empty');
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

  it('decide(gitSpec(...)) is allowed for every allowed subcommand, so the builder and the gate cannot drift', () => {
    const subs: ReadonlyArray<readonly string[]> = [
      ['ls-files', '-z', '-s'],
      ['hash-object', '--stdin-paths'],
      ['cat-file', '-e', 'a'.repeat(40)],
      ['cat-file', 'blob', 'HEAD:a.txt'],
      ['rev-parse', '--git-common-dir'],
      ['rev-list', '--max-parents=0', 'HEAD'],
      ['config', '--name-only', '--get-regexp', '^filter\\.'],
      ['check-attr', '-a', 'a.txt'],
    ];
    for (const sub of subs) {
      assert.equal(decide(gitSpec(sub, { worktree: W }), {}).allowed, true, sub.join(' '));
      assert.equal(decide(gitSpec(sub, { worktree: W, filterNames: ['evil'], env: { GIT_CONFIG_GLOBAL: '/x/empty' } }), {}).allowed, true, `${sub.join(' ')} with an overlay`);
    }
  });

  it('decide allows gitSpec output for names containing "=", "." and the empty name, so builder and gate agree', () => {
    for (const name of ['evil', 'a=b', 'a=b=c', 'my.driver', 'Mixed Case', 'x"y', '']) {
      for (const sub of [['hash-object', '--stdin-paths'], ['ls-files', '-z'], ['config', '--name-only', '--get-regexp', '^filter\\.']]) {
        const spec = gitSpec(sub, { worktree: W, filterNames: [name, 'other'], env: { GIT_CONFIG_GLOBAL: '/x/empty' } });
        assert.equal(decide(spec, {}).allowed, true, `${JSON.stringify(name)} ${sub.join(' ')}`);
      }
    }
  });

  it('denies git status: it runs clean filters even with fsmonitor disabled', () => {
    const d = decide(gitSpec(['status'], { worktree: W, filterNames: ['evil'] }), {});
    assert.equal(d.allowed, false);
    const d2 = decide(gitSpec(['status', '--porcelain'], { worktree: W }), {});
    assert.equal(d2.allowed, false);
  });

  it('neutralises dotted driver names', () => {
    assert.deepEqual(neutraliseFilters(['my.driver']), {
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'filter.my.driver.clean',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'filter.my.driver.smudge',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'filter.my.driver.process',
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: 'filter.my.driver.required',
      GIT_CONFIG_VALUE_3: 'false',
    });
    const d = decide(gitSpec(['hash-object', '--stdin-paths'], { worktree: W, filterNames: ['my.driver'] }), {});
    assert.equal(d.allowed, true);
  });
});

describe('parseFilterNames', () => {
  it('gives one name for several variables of the same driver', () => {
    assert.deepEqual(parseFilterNames('filter.evil.clean\nfilter.evil.smudge\n'), ['evil']);
  });
  it('keeps "=" inside a name', () => {
    assert.deepEqual(parseFilterNames('filter.a=b.clean\n'), ['a=b']);
  });
  it('gives unique names sorted by code unit when names share a prefix with "="', () => {
    assert.deepEqual(parseFilterNames('filter.a=b=c.smudge\nfilter.a=b.clean\n'), ['a=b', 'a=b=c']);
  });
  it('keeps dots inside a name', () => {
    assert.deepEqual(parseFilterNames('filter.my.driver.process\n'), ['my.driver']);
  });
  it('never trims a name', () => {
    assert.deepEqual(parseFilterNames('filter.Mixed Case.clean\n'), ['Mixed Case']);
  });
  it('keeps a double quote inside a name', () => {
    assert.deepEqual(parseFilterNames('filter.x"y.required\n'), ['x"y']);
  });
  it('gives the empty name for filter..clean', () => {
    assert.deepEqual(parseFilterNames('filter..clean\n'), ['']);
  });
  it('ignores a line with no variable part', () => {
    assert.deepEqual(parseFilterNames('filter.clean\n'), []);
  });
  it('ignores unrelated keys', () => {
    assert.deepEqual(parseFilterNames('core.fsmonitor\nuser.name\n'), []);
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
