import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import { diagnostic } from '../facts/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import {
  GitConfigError,
  allowAll,
  createRealRunner,
  createRecordingRunner,
  decide,
  gitSpec,
  listFilterNames,
  neutraliseFilters,
  parseFilterNames,
} from './index.ts';
import { deniedResult, spawnErrorResult } from './spec.ts';
import type { CommandResult, CommandRunner, CommandSpec } from './spec.ts';

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

/** The probe driver name a listFilterNames call put in its config read, read back from GIT_CONFIG_KEY_0. */
const probeOf = (spec: CommandSpec): string => {
  const key = spec.env?.['GIT_CONFIG_KEY_0'] ?? '';
  const m = /^filter\.(.*)\.clean$/.exec(key);
  assert.ok(m !== null, `GIT_CONFIG_KEY_0 is not a filter key: ${key}`);
  return m[1] as string;
};
/** What a conforming git prints for `config --name-only --get-regexp ^filter\.` when the probe plus `names` are configured. */
const listing = (spec: CommandSpec, ...names: string[]): string =>
  [probeOf(spec), ...names].flatMap((n) => [`filter.${n}.clean`, `filter.${n}.required`, `filter.${n}.smudge`]).join('\n') + '\n';
const failed = (code: string): { code: string } => ({ code });

/** A runner that answers every run with a fixed CommandResult, for outcomes ScriptedResult cannot express. */
const fixedRunner = (result: CommandResult): CommandRunner => ({
  run: () => Promise.resolve(result),
  stream: () => {
    throw new Error('not used');
  },
});

describe('listFilterNames', () => {
  it('reads names with a name-only config query, neutralising only a random probe driver', async () => {
    const runner = createRecordingRunner({ respond: (spec) => ({ exitCode: 0, stdout: listing(spec, 'evil', 'lfs') }) });
    const names = await listFilterNames(runner, W);
    assert.deepEqual(names, ['evil', 'lfs']);
    assert.equal(runner.starts.length, 1);
    const start = runner.starts[0] as CommandSpec;
    assert.deepEqual(start.args.slice(-3), ['--name-only', '--get-regexp', '^filter\\.']);
    assert.ok(!start.args.some((a) => a.startsWith('filter.')), 'no -c pair');
    assert.match(probeOf(start), /^atlas-probe-[0-9a-f]{16}$/);
    assert.equal(start.env?.['GIT_CONFIG_COUNT'], '4');
  });

  it('uses a fresh probe name on every call and never returns it', async () => {
    const seen: string[] = [];
    const runner = createRecordingRunner({
      respond: (spec) => {
        seen.push(probeOf(spec));
        return { stdout: listing(spec, 'x') };
      },
    });
    assert.deepEqual(await listFilterNames(runner, W), ['x']);
    assert.deepEqual(await listFilterNames(runner, W), ['x']);
    assert.equal(new Set(seen).size, 2);
  });

  it('resolves to [] when only the probe is listed (a repository with no drivers)', async () => {
    const runner = createRecordingRunner({ respond: (spec) => ({ stdout: listing(spec) }) });
    assert.deepEqual(await listFilterNames(runner, W), []);
  });

  it('rejects with git_env_config_unsupported, naming git 2.31, when exit 0 output lacks the probe', async () => {
    for (const stdout of ['', 'filter.evil.clean\n']) {
      const runner = createRecordingRunner({ respond: () => ({ exitCode: 0, stdout }) });
      await assert.rejects(() => listFilterNames(runner, W), (error: unknown) => {
        assert.deepEqual({ code: (error as { code?: string }).code }, failed('git_env_config_unsupported'));
        const message = (error as Error).message;
        assert.ok(message.includes('2.31'), message);
        assert.ok(/could not be neutralised/.test(message), message);
        return true;
      });
    }
  });

  it('rejects with filter_enumeration_failed on exit 128', async () => {
    const runner = createRecordingRunner({ respond: () => ({ exitCode: 128, stderr: 'fatal' }) });
    await assert.rejects(() => listFilterNames(runner, W), failed('filter_enumeration_failed'));
  });

  it('rejects with filter_enumeration_failed on exit 1 with empty stdout (no longer "no drivers")', async () => {
    const runner = createRecordingRunner({ respond: () => ({ exitCode: 1, stdout: '' }) });
    await assert.rejects(() => listFilterNames(runner, W), failed('filter_enumeration_failed'));
  });

  it('rejects with filter_enumeration_failed on timeout, truncation, spawn error and denial', async () => {
    const d = diagnostic('x', 'error', 'boom', 'git');
    const timedOut = createRecordingRunner({ respond: (spec) => ({ stdout: listing(spec), timedOut: true }) });
    const truncated = createRecordingRunner({ respond: (spec) => ({ stdout: listing(spec), truncated: true }) });
    await assert.rejects(() => listFilterNames(timedOut, W), failed('filter_enumeration_failed'));
    await assert.rejects(() => listFilterNames(truncated, W), failed('filter_enumeration_failed'));
    await assert.rejects(() => listFilterNames(fixedRunner(spawnErrorResult(d)), W), failed('filter_enumeration_failed'));
    await assert.rejects(() => listFilterNames(fixedRunner(deniedResult(d)), W), failed('filter_enumeration_failed'));
  });

  it('rejects with the typed error class', async () => {
    const runner = createRecordingRunner({ respond: () => ({ exitCode: 128 }) });
    await assert.rejects(() => listFilterNames(runner, W), GitConfigError);
  });

  it('with real git lists a repository\'s drivers (including "=" and "." names) and none for a plain repo', async (t) => {
    const setup = createRealRunner({ decide: allowAll });
    const repo = await createTempGitRepo({ runner: setup, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    const plain = createRecordingRunner({ delegate: createRealRunner() });
    assert.deepEqual(await listFilterNames(plain, repo.dir, undefined, repo.envOverlay), []);
    for (const name of ['evil', 'a=b', 'my.driver']) await repo.setConfig(`filter.${name}.clean`, 'cat');
    await repo.setConfig('filter.a=b.smudge', 'cat');
    const names = await listFilterNames(plain, repo.dir, undefined, repo.envOverlay);
    assert.deepEqual(names, ['a=b', 'evil', 'my.driver']);
    assert.ok(names.every((n) => !n.startsWith('atlas-probe-')));
    assert.equal(plain.starts.length, 2);
  });
});
