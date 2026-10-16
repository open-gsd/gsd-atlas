import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowAll, decide } from './index.ts';
import type { CommandSpec, Decision, UserPermissions } from './index.ts';

/** A bare git spec: no overrides, no environment. Only `--version` may run like this. */
const git = (...args: string[]): CommandSpec => ({ executable: 'git', args, builtinId: 'git' });

// Literals on purpose, not imported from git-spec.ts: the gate must not trust the builder, and the test
// proves the two agree (git-spec.test.ts loops decide over gitSpec's output).
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_OVERRIDES: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${NULL_DEVICE}`,
  '-c', 'core.quotepath=off',
];
const PINNED_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: 'none',
};

/** A git spec shaped like gitSpec's output: `-C`, the three overrides, then `args`, with the pinned environment. */
const safeGit = (...args: string[]): CommandSpec => ({
  executable: 'git',
  args: ['-C', '/some/repo', ...SAFE_OVERRIDES, ...args],
  builtinId: 'git',
  env: { ...PINNED_ENV },
});
/** The same shape with one override pair dropped. */
const withoutOverride = (key: string, ...args: string[]): CommandSpec => {
  const kept: string[] = [];
  for (let i = 0; i < SAFE_OVERRIDES.length; i += 2) {
    if (!(SAFE_OVERRIDES[i + 1] as string).startsWith(`${key}=`)) kept.push('-c', SAFE_OVERRIDES[i + 1] as string);
  }
  return { executable: 'git', args: ['-C', '/some/repo', ...kept, ...args], builtinId: 'git', env: { ...PINNED_ENV } };
};
/** The same shape with one environment variable removed (`value` undefined) or changed. */
const withEnv = (name: string, value: string | undefined, ...args: string[]): CommandSpec => {
  const env: Record<string, string> = { ...PINNED_ENV };
  if (value === undefined) delete env[name];
  else env[name] = value;
  return { ...safeGit(...args), env };
};

function assertDenied(d: Decision): asserts d is Extract<Decision, { allowed: false }> {
  assert.equal(d.allowed, false, 'expected a denial');
}

describe('decide: first-party git built-in', () => {
  it('allows git --version', () => {
    assert.deepEqual(decide(git('--version')), { allowed: true, via: 'builtin', builtinId: 'git' });
  });

  it('allows git without a declared builtinId when the spec matches exactly', () => {
    const d = decide({ executable: 'git', args: ['--version'] });
    assert.deepEqual(d, { allowed: true, via: 'builtin', builtinId: 'git' });
  });

  it('allows -C <dir> and the allowlisted -c keys before an allowed subcommand', () => {
    const d = decide(safeGit('ls-files', '-z'));
    assert.deepEqual(d, { allowed: true, via: 'builtin', builtinId: 'git' });
  });

  it('denies the old partial -c form (a deliberate tightening): -C <dir> -c core.fsmonitor=false -c core.quotepath=off ls-files', () => {
    const partial: CommandSpec = {
      executable: 'git',
      args: ['-C', '/some/repo', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', 'ls-files', '-z'],
      builtinId: 'git',
      env: { ...PINNED_ENV },
    };
    assertDenied(decide(partial));
  });

  it('allows the hooksPath null device and empty filter neutralisation', () => {
    const d = decide(
      safeGit(
        '-c', 'filter.evil.clean=',
        '-c', 'filter.evil.smudge=',
        '-c', 'filter.evil.process=',
        '-c', 'filter.evil.required=false',
        'hash-object', '--stdin-paths',
      ),
    );
    assert.equal(d.allowed, true);
  });

  it('allows every listed read-only subcommand', () => {
    for (const sub of ['ls-files', 'hash-object', 'cat-file', 'rev-parse', 'rev-list', 'check-attr']) {
      assert.equal(decide(safeGit(sub)).allowed, true, sub);
    }
  });

  it('allows config only in the read form --name-only --get-regexp <pattern>', () => {
    assert.equal(decide(safeGit('config', '--name-only', '--get-regexp', '^filter\\.')).allowed, true);
  });

  it('allows git --version with no overrides and no environment', () => {
    assert.equal(decide({ executable: 'git', args: ['--version'], builtinId: 'git', env: {} }).allowed, true);
  });
});

describe('decide: git denials', () => {
  const denied: Array<[string, CommandSpec]> = [
    ['status is not an allowed subcommand', safeGit('status')],
    ['push is not an allowed subcommand', safeGit('push', 'origin', 'main')],
    ['config --global is not the read form', safeGit('config', '--global', 'user.name', 'x')],
    ['config writes are not the read form', safeGit('config', 'core.editor', 'vim')],
    ['config --get-regexp without --name-only is not the read form', safeGit('config', '--get-regexp', 'x')],
    ['config with trailing arguments is not the read form', safeGit('config', '--name-only', '--get-regexp', 'x', 'y')],
    ['alias via -c alias.x=!sh', safeGit('-c', 'alias.x=!sh', 'ls-files')],
    ['core.sshCommand via -c', safeGit('-c', 'core.sshCommand=x', 'ls-files')],
    ['core.fsmonitor set to a script path', safeGit('-c', 'core.fsmonitor=/tmp/evil', 'ls-files')],
    ['core.hooksPath pointing at a directory', safeGit('-c', 'core.hooksPath=/tmp/hooks', 'ls-files')],
    ['a filter clean command that is not empty', safeGit('-c', 'filter.x.clean=sh -c evil', 'hash-object')],
    ['a -c without key=value', safeGit('-c', 'core.fsmonitor', 'ls-files')],
    ['a -c with a missing argument', safeGit('-c')],
    ['a -C with a missing argument', safeGit('-C')],
    ['an attached -c form', safeGit('-ccore.fsmonitor=false', 'ls-files')],
    ['--exec-path as a global option', safeGit('--exec-path=/tmp/x', 'ls-files')],
    ['--git-dir as a global option', safeGit('--git-dir=/tmp/x', 'ls-files')],
    ['--version with extra arguments', git('--version', 'x')],
    ['-C then --version', git('-C', '/r', '--version')],
    ['no subcommand at all', git()],
    ['cat-file --textconv runs repo-configured drivers', safeGit('cat-file', '--textconv', 'HEAD:a')],
    ['cat-file --filters runs repo-configured drivers', safeGit('cat-file', '--filters', 'HEAD:a')],
    ['hash-object -w writes to the object database', safeGit('hash-object', '-w', 'a')],
    ['--help opens a pager', safeGit('rev-parse', '--help')],
  ];
  for (const [name, spec] of denied) {
    it(`denies ${name}`, () => {
      assertDenied(decide(spec));
    });
  }

  const missingOverride: Array<[string, CommandSpec]> = [
    ['core.fsmonitor override is missing', withoutOverride('core.fsmonitor', 'ls-files')],
    ['core.hooksPath override is missing', withoutOverride('core.hooksPath', 'ls-files')],
    ['core.quotepath override is missing', withoutOverride('core.quotepath', 'ls-files')],
  ];
  for (const [name, spec] of missingOverride) {
    it(`denies a spec when the ${name}`, () => {
      assertDenied(decide(spec));
    });
  }

  const badEnv: Array<[string, CommandSpec]> = [
    ['GIT_OPTIONAL_LOCKS is missing', withEnv('GIT_OPTIONAL_LOCKS', undefined, 'ls-files')],
    ['GIT_OPTIONAL_LOCKS is not 0', withEnv('GIT_OPTIONAL_LOCKS', '1', 'ls-files')],
    ['GIT_TERMINAL_PROMPT is missing', withEnv('GIT_TERMINAL_PROMPT', undefined, 'ls-files')],
    ['GIT_TERMINAL_PROMPT is not 0', withEnv('GIT_TERMINAL_PROMPT', '1', 'ls-files')],
    ['GIT_NO_LAZY_FETCH is missing', withEnv('GIT_NO_LAZY_FETCH', undefined, 'cat-file', '-e', 'a')],
    ['GIT_NO_LAZY_FETCH is not 1', withEnv('GIT_NO_LAZY_FETCH', '0', 'cat-file', '-e', 'a')],
    ['GIT_ALLOW_PROTOCOL is missing', withEnv('GIT_ALLOW_PROTOCOL', undefined, 'cat-file', '-e', 'a')],
    ['GIT_ALLOW_PROTOCOL is file', withEnv('GIT_ALLOW_PROTOCOL', 'file', 'cat-file', '-e', 'a')],
    ['GIT_ALLOW_PROTOCOL is ssh', withEnv('GIT_ALLOW_PROTOCOL', 'ssh', 'cat-file', '-e', 'a')],
  ];
  for (const [name, spec] of badEnv) {
    it(`denies a spec when ${name}`, () => {
      assertDenied(decide(spec));
    });
  }

  it('denies a spec with no env at all, even with every override present', () => {
    const { env: _env, ...noEnv } = safeGit('ls-files');
    assertDenied(decide(noEnv));
  });

  it('denies a missing-override or missing-env spec with code command_denied, starting nothing, naming permissions.commands', () => {
    for (const spec of [withoutOverride('core.hooksPath', 'ls-files'), withEnv('GIT_NO_LAZY_FETCH', undefined, 'ls-files')]) {
      const d = decide(spec);
      assertDenied(d);
      assert.equal(d.diagnostic.code, 'command_denied');
      assert.ok(d.diagnostic.message.includes('permissions.commands'), d.diagnostic.message);
      assert.ok(d.diagnostic.message.includes('was not started'), d.diagnostic.message);
    }
  });

  it('denies a non-git executable', () => {
    assertDenied(decide({ executable: 'sh', args: ['-c', 'id'] }));
  });

  it('denies a denied builtinId mismatch: builtinId git with an executable that is not git', () => {
    const d = decide({ executable: 'sh', args: ['--version'], builtinId: 'git' });
    assertDenied(d);
  });

  it('denies an absolute path to git as a built-in (the built-in is the bare name git)', () => {
    assertDenied(decide({ executable: '/tmp/git', args: ['--version'], builtinId: 'git' }));
  });

  it('denies an unknown builtinId even when the arguments look harmless', () => {
    assertDenied(decide({ executable: 'git', args: ['--version'], builtinId: 'svn' }));
  });

  it('denial message names the command and the permissions.commands key', () => {
    const d = decide(git('status', '--short'));
    assertDenied(d);
    assert.equal(d.diagnostic.code, 'command_denied');
    assert.equal(d.diagnostic.severity, 'error');
    assert.ok(d.diagnostic.message.includes('git status --short'), d.diagnostic.message);
    assert.ok(d.diagnostic.message.includes('permissions.commands'), d.diagnostic.message);
    assert.ok(d.diagnostic.message.includes('~/.config/gsd-atlas/config.json'), d.diagnostic.message);
    assert.ok(d.diagnostic.message.includes('was not started'), d.diagnostic.message);
  });
});

/** A safe git spec whose env also carries the given GIT_CONFIG_* variables (verbatim, so malformed shapes can be built). */
const withChannel = (channel: Record<string, string>, ...args: string[]): CommandSpec => ({
  ...safeGit(...args),
  env: { ...PINNED_ENV, ...channel },
});
/** A well-formed channel for `entries` [key, value]. */
const channelOf = (entries: ReadonlyArray<readonly [string, string]>): Record<string, string> => {
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${String(i)}`] = k;
    out[`GIT_CONFIG_VALUE_${String(i)}`] = v;
  });
  return out;
};
const driverEntries = (name: string): Array<readonly [string, string]> => [
  [`filter.${name}.clean`, ''],
  [`filter.${name}.smudge`, ''],
  [`filter.${name}.process`, ''],
  [`filter.${name}.required`, 'false'],
];

describe('decide: the GIT_CONFIG_COUNT/KEY_n/VALUE_n env channel (CR-02, T-01-48)', () => {
  it('allows a neutralisation overlay for names containing "=", ".", spaces, a quote, and the empty name', () => {
    for (const name of ['evil', 'a=b', 'a=b=c', 'my.driver', 'Mixed Case', 'x"y', '']) {
      const d = decide(withChannel(channelOf(driverEntries(name)), 'hash-object', '--stdin-paths'));
      assert.equal(d.allowed, true, JSON.stringify(name));
    }
  });

  it('allows names the shared rule carries: 1024 code units, a non-ASCII letter, an emoji, a tab, a leading and a trailing space', () => {
    for (const name of ['x'.repeat(1024), 'café', '\u{1F600}', 'a\tb', ' lead', 'trail ']) {
      for (const sub of [['hash-object', '--stdin-paths'], ['ls-files'], ['config', '--name-only', '--get-regexp', '^filter\\.']]) {
        const d = decide(withChannel(channelOf(driverEntries(name)), ...sub));
        assert.equal(d.allowed, true, `${JSON.stringify(name).slice(0, 30)} ${sub[0] as string}`);
      }
    }
  });

  it('denies names the shared rule refuses (U+FFFD, an unpaired surrogate, 1025 code units) for hash-object, ls-files and the config read (WR-01)', () => {
    for (const name of ['a�b', 'a\uD800b', 'a\uDC00b', 'x'.repeat(1025)]) {
      for (const sub of [['hash-object', '--stdin-paths'], ['ls-files'], ['config', '--name-only', '--get-regexp', '^filter\\.']]) {
        const d = decide(withChannel(channelOf(driverEntries(name)), ...sub));
        assertDenied(d);
        assert.equal(d.diagnostic.code, 'command_denied');
        assert.ok(d.diagnostic.message.includes('permissions.commands'), d.diagnostic.message);
      }
    }
  });

  it('allows required=false and required empty, and several drivers at once', () => {
    assert.equal(decide(withChannel(channelOf([['filter.x.required', '']]), 'ls-files')).allowed, true);
    assert.equal(decide(withChannel(channelOf([...driverEntries('a'), ...driverEntries('b=c')]), 'ls-files')).allowed, true);
  });

  it('allows GIT_CONFIG_COUNT 0, and no GIT_CONFIG_* entry at all', () => {
    assert.equal(decide(withChannel({ GIT_CONFIG_COUNT: '0' }, 'ls-files')).allowed, true);
    assert.equal(decide(safeGit('ls-files')).allowed, true);
  });

  it('does not touch GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM', () => {
    const env = { ...channelOf(driverEntries('x')), GIT_CONFIG_GLOBAL: '/e', GIT_CONFIG_SYSTEM: '/e', GIT_CONFIG_NOSYSTEM: '1' };
    assert.equal(decide(withChannel(env, 'ls-files')).allowed, true);
  });

  const good = channelOf([['filter.x.clean', '']]);
  const bad: Array<[string, Record<string, string>]> = [
    ["GIT_CONFIG_COUNT '01'", { ...good, GIT_CONFIG_COUNT: '01' }],
    ["GIT_CONFIG_COUNT '+1'", { ...good, GIT_CONFIG_COUNT: '+1' }],
    ["GIT_CONFIG_COUNT '-1'", { ...good, GIT_CONFIG_COUNT: '-1' }],
    ["GIT_CONFIG_COUNT '1e1'", { ...good, GIT_CONFIG_COUNT: '1e1' }],
    ["GIT_CONFIG_COUNT ' 2'", { ...good, GIT_CONFIG_COUNT: ' 2' }],
    ["GIT_CONFIG_COUNT ''", { ...good, GIT_CONFIG_COUNT: '' }],
    ['GIT_CONFIG_COUNT non-numeric', { ...good, GIT_CONFIG_COUNT: 'many' }],
    ['GIT_CONFIG_COUNT larger than the entries present', { ...good, GIT_CONFIG_COUNT: '2' }],
    ['a huge GIT_CONFIG_COUNT with no entries', { GIT_CONFIG_COUNT: '99999999999999999999' }],
    ['a stray GIT_CONFIG_KEY_5 and GIT_CONFIG_VALUE_5 with count 1', { ...good, GIT_CONFIG_KEY_5: 'filter.y.clean', GIT_CONFIG_VALUE_5: '' }],
    ['GIT_CONFIG_KEY_0 without GIT_CONFIG_VALUE_0', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.x.clean' }],
    ['GIT_CONFIG_VALUE_0 without GIT_CONFIG_KEY_0', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: '' }],
    ['GIT_CONFIG_KEY_ and GIT_CONFIG_VALUE_ entries without GIT_CONFIG_COUNT', { GIT_CONFIG_KEY_0: 'filter.x.clean', GIT_CONFIG_VALUE_0: '' }],
    ['core.sshCommand through GIT_CONFIG_KEY_0', channelOf([['core.sshCommand', '']])],
    ['alias.x through GIT_CONFIG_KEY_0', channelOf([['alias.x', '!sh']])],
    ['core.fsmonitor through GIT_CONFIG_KEY_0', channelOf([['core.fsmonitor', 'false']])],
    ['core.hooksPath through GIT_CONFIG_KEY_0', channelOf([['core.hooksPath', '/dev/null']])],
    ['an unknown filter variable filter.x.foo', channelOf([['filter.x.foo', '']])],
    ['a non-empty filter.x.clean value (sh -c evil)', channelOf([['filter.x.clean', 'sh -c evil']])],
    ['filter.x.required with value true', channelOf([['filter.x.required', 'true']])],
    ['a driver name containing a newline', channelOf([['filter.a\nb.clean', '']])],
    ['a driver name containing a carriage return', channelOf([['filter.a\rb.clean', '']])],
    ['a driver name containing NUL', channelOf([['filter.a\0b.clean', '']])],
    ['GIT_CONFIG_PARAMETERS present', { ...good, GIT_CONFIG_PARAMETERS: "'core.sshcommand=evil'" }],
    ['GIT_CONFIG_PARAMETERS present alone', { GIT_CONFIG_PARAMETERS: "'core.sshcommand=evil'" }],
    ['a lower-case git_config_count', { ...good, git_config_count: '1' }],
    ['a lower-case git_config_key_0', { ...good, git_config_key_0: 'core.sshCommand' }],
    ['an upper-case-index variant GIT_CONFIG_KEY_00', { ...good, GIT_CONFIG_KEY_00: 'core.sshCommand', GIT_CONFIG_VALUE_00: '' }],
  ];
  for (const [name, channel] of bad) {
    it(`denies ${name}`, () => {
      const d = decide(withChannel(channel, 'hash-object', '--stdin-paths'));
      assertDenied(d);
      assert.equal(d.diagnostic.code, 'command_denied');
      assert.ok(d.diagnostic.message.includes('permissions.commands'), d.diagnostic.message);
    });
  }

  it('applies the channel check to every git built-in subcommand, including config', () => {
    for (const sub of [['ls-files'], ['cat-file', '-e', 'a'], ['config', '--name-only', '--get-regexp', '^filter\\.']]) {
      assertDenied(decide(withChannel(channelOf([['core.sshCommand', '']]), ...sub)));
    }
  });

  it('does not stall on a huge declared count', () => {
    const started = Date.now();
    assertDenied(decide(withChannel({ GIT_CONFIG_COUNT: '9'.repeat(400) }, 'ls-files')));
    assert.ok(Date.now() - started < 1000);
  });
});

describe('decide: user permissions', () => {
  const tool = process.execPath;
  const user: UserPermissions = { allow: [{ repo: '/repo/a', executable: tool }] };
  const spec: CommandSpec = { executable: tool, args: ['-e', '1'] };

  it('allows exactly that executable for that repo', () => {
    assert.deepEqual(decide(spec, { repo: '/repo/a' }, user), { allowed: true, via: 'user' });
  });

  it('denies it for another repo', () => {
    assertDenied(decide(spec, { repo: '/repo/b' }, user));
  });

  it('denies it when the context names no repo', () => {
    assertDenied(decide(spec, {}, user));
    assertDenied(decide(spec, undefined, user));
  });

  it('denies a different executable for the same repo', () => {
    assertDenied(decide({ executable: '/bin/other', args: [] }, { repo: '/repo/a' }, user));
  });

  it('nothing outside the built-ins is allowed when no user argument is given', () => {
    assertDenied(decide(spec, { repo: '/repo/a' }));
    assertDenied(decide(spec, { repo: '/repo/a' }, { allow: [] }));
  });

  it('honours argsPrefix', () => {
    const scoped: UserPermissions = { allow: [{ repo: '/repo/a', executable: tool, argsPrefix: ['-e'] }] };
    assert.equal(decide(spec, { repo: '/repo/a' }, scoped).allowed, true);
    assertDenied(decide({ executable: tool, args: ['--inspect'] }, { repo: '/repo/a' }, scoped));
    assertDenied(decide({ executable: tool, args: [] }, { repo: '/repo/a' }, scoped));
  });

  it('a user entry does not widen the git built-in', () => {
    const d = decide(safeGit('push'), { repo: '/repo/a' }, user);
    assertDenied(d);
  });

  it('has no parameter through which repo data can grant permission', () => {
    // decide takes (spec, ctx, user). Anything repo-supplied that rides along on spec or ctx is ignored.
    const sneaky = { executable: tool, args: [], permissions: { commands: [tool] } } as unknown as CommandSpec;
    assertDenied(decide(sneaky, { repo: '/repo/a', permissions: { commands: [tool] } } as never));
    assert.equal(decide.length <= 3, true);
  });
});

describe('allowAll (test-only)', () => {
  it('allows anything', () => {
    assert.equal(allowAll({ executable: 'whatever', args: [] }, {}).allowed, true);
  });
});
