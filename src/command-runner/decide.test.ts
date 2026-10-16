import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowAll, decide } from './index.ts';
import type { CommandSpec, Decision, UserPermissions } from './index.ts';

const git = (...args: string[]): CommandSpec => ({ executable: 'git', args, builtinId: 'git' });

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
    const d = decide(
      git('-C', '/some/repo', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', 'ls-files', '-z'),
    );
    assert.deepEqual(d, { allowed: true, via: 'builtin', builtinId: 'git' });
  });

  it('allows the hooksPath null device and empty filter neutralisation', () => {
    const d = decide(
      git(
        '-c', 'core.hooksPath=/dev/null',
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
      assert.equal(decide(git(sub)).allowed, true, sub);
    }
  });

  it('allows config only in the read form --name-only --get-regexp <pattern>', () => {
    assert.equal(decide(git('config', '--name-only', '--get-regexp', '^filter\\.')).allowed, true);
  });
});

describe('decide: git denials', () => {
  const denied: Array<[string, CommandSpec]> = [
    ['status is not an allowed subcommand', git('status')],
    ['push is not an allowed subcommand', git('push', 'origin', 'main')],
    ['config --global is not the read form', git('config', '--global', 'user.name', 'x')],
    ['config writes are not the read form', git('config', 'core.editor', 'vim')],
    ['config --get-regexp without --name-only is not the read form', git('config', '--get-regexp', 'x')],
    ['config with trailing arguments is not the read form', git('config', '--name-only', '--get-regexp', 'x', 'y')],
    ['alias via -c alias.x=!sh', git('-c', 'alias.x=!sh', 'ls-files')],
    ['core.sshCommand via -c', git('-c', 'core.sshCommand=x', 'ls-files')],
    ['core.fsmonitor set to a script path', git('-c', 'core.fsmonitor=/tmp/evil', 'ls-files')],
    ['core.hooksPath pointing at a directory', git('-c', 'core.hooksPath=/tmp/hooks', 'ls-files')],
    ['a filter clean command that is not empty', git('-c', 'filter.x.clean=sh -c evil', 'hash-object')],
    ['a -c without key=value', git('-c', 'core.fsmonitor', 'ls-files')],
    ['a -c with a missing argument', git('-c')],
    ['a -C with a missing argument', git('-C')],
    ['an attached -c form', git('-ccore.fsmonitor=false', 'ls-files')],
    ['--exec-path as a global option', git('--exec-path=/tmp/x', 'ls-files')],
    ['--git-dir as a global option', git('--git-dir=/tmp/x', 'ls-files')],
    ['--version with extra arguments', git('--version', 'x')],
    ['-C then --version', git('-C', '/r', '--version')],
    ['no subcommand at all', git()],
    ['cat-file --textconv runs repo-configured drivers', git('cat-file', '--textconv', 'HEAD:a')],
    ['cat-file --filters runs repo-configured drivers', git('cat-file', '--filters', 'HEAD:a')],
    ['hash-object -w writes to the object database', git('hash-object', '-w', 'a')],
    ['--help opens a pager', git('rev-parse', '--help')],
  ];
  for (const [name, spec] of denied) {
    it(`denies ${name}`, () => {
      assertDenied(decide(spec));
    });
  }

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
    const d = decide(git('push'), { repo: '/repo/a' }, user);
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
