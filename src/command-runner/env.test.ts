import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { minimalEnv } from './env.ts';
import { scrubEnv } from './index.ts';

describe('scrubEnv', () => {
  it('keeps PATH, SystemRoot, TEMP and TMP (Windows needs them to start a process)', () => {
    const out = scrubEnv({ PATH: '/bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', HOME: '/h' });
    assert.deepEqual(out, { PATH: '/bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', HOME: '/h' });
  });

  it('removes git redirection variables', () => {
    const out = scrubEnv({
      PATH: '/bin',
      GIT_DIR: '/x',
      GIT_WORK_TREE: '/x',
      GIT_INDEX_FILE: '/x',
      GIT_OBJECT_DIRECTORY: '/x',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/x',
      GIT_CONFIG_PARAMETERS: "'core.x=y'",
    });
    assert.deepEqual(out, { PATH: '/bin' });
  });

  it('removes a variable named GITHUB_TOKEN and other secret-looking names, case-insensitively', () => {
    const out = scrubEnv({
      PATH: '/bin',
      GITHUB_TOKEN: 't',
      npm_config_password: 'p',
      MY_SECRET: 's',
      Service_Api_Key: 'k',
      AWS_CREDENTIALS: 'c',
      git_dir: '/lowercase-windows-style',
    });
    assert.deepEqual(out, { PATH: '/bin' });
  });

  it('removed names: cloud, ssh-agent and database credentials the first pattern missed (IN-05)', () => {
    const removed = [
      'AWS_ACCESS_KEY_ID',
      'SSH_AUTH_SOCK',
      'DATABASE_URL',
      'DB_PASSWD',
      'MYSQL_PASSWD',
      'NPM_CONFIG__AUTH',
      'DEPLOY_PRIVATE_KEY',
      'STRIPE_ACCESS_KEY',
      // still removed
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'GITHUB_TOKEN',
      'DB_PASSWORD',
      // case-insensitive, as before
      'ssh_auth_sock',
      'Database_Url',
      'npm_config__auth',
    ];
    const parent: Record<string, string> = { PATH: '/bin' };
    for (const name of removed) parent[name] = 'v';
    assert.deepEqual(scrubEnv(parent), { PATH: '/bin' });
  });

  it('kept names: ordinary variables and GIT_AUTHOR_* / GIT_COMMITTER_* survive', () => {
    const kept: Record<string, string> = {
      PATH: '/bin',
      Path: 'C:\\bin',
      HOME: '/h',
      SystemRoot: 'C:\\Windows',
      TEMP: '/t',
      LANG: 'C',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'c',
      GIT_COMMITTER_EMAIL: 'c@example.invalid',
      GIT_CONFIG_GLOBAL: '/e',
      XDG_CONFIG_HOME: '/x',
      AUTHORITY_NAME: 'a word that merely contains AUTH',
    };
    assert.deepEqual(scrubEnv(kept), kept);
  });

  it('overlay wins: a spec that deliberately sets a removed name keeps it', () => {
    const out = scrubEnv({ PATH: '/bin', SSH_AUTH_SOCK: '/parent', DATABASE_URL: 'parent' }, { SSH_AUTH_SOCK: '/deliberate', DB_PASSWD: 'deliberate' });
    assert.deepEqual(out, { PATH: '/bin', SSH_AUTH_SOCK: '/deliberate', DB_PASSWD: 'deliberate' });
  });

  it('applies the overlay last, even over denylisted names', () => {
    const out = scrubEnv({ PATH: '/bin', FOO: 'parent', GIT_DIR: '/x' }, { FOO: 'overlay', GIT_OPTIONAL_LOCKS: '0', GIT_DIR: '/deliberate' });
    assert.deepEqual(out, { PATH: '/bin', FOO: 'overlay', GIT_OPTIONAL_LOCKS: '0', GIT_DIR: '/deliberate' });
  });

  it('drops undefined parent values and does not mutate its inputs', () => {
    const parent = { PATH: '/bin', GONE: undefined };
    const overlay = { A: '1' };
    const out = scrubEnv(parent, overlay);
    assert.deepEqual(out, { PATH: '/bin', A: '1' });
    assert.deepEqual(parent, { PATH: '/bin', GONE: undefined });
    assert.deepEqual(overlay, { A: '1' });
  });
});

describe('minimalEnv (shape-matched built-ins, plan 03-19)', () => {
  it('keeps only the named inherited variables, case-insensitively, and nothing that changes what code loads', () => {
    const out = minimalEnv({
      PATH: '/bin',
      HOME: '/h',
      SystemRoot: 'C:\\Windows',
      Temp: 'C:\\Temp',
      LANG: 'C.UTF-8',
      NODE_OPTIONS: '--require /x',
      NODE_PATH: '/x',
      LD_PRELOAD: '/x.so',
      LD_LIBRARY_PATH: '/x',
      DYLD_INSERT_LIBRARIES: '/x.dylib',
      GITHUB_TOKEN: 't',
      GONE: undefined,
    });
    assert.deepEqual(out, { HOME: '/h', SystemRoot: 'C:\\Windows', Temp: 'C:\\Temp', LANG: 'C.UTF-8' });
  });

  it('applies the overlay last and does not mutate its inputs', () => {
    const parent = { HOME: '/h', NODE_OPTIONS: 'x' };
    const overlay = { GSD_ATLAS_WORKER: '1' };
    assert.deepEqual(minimalEnv(parent, overlay), { HOME: '/h', GSD_ATLAS_WORKER: '1' });
    assert.deepEqual(parent, { HOME: '/h', NODE_OPTIONS: 'x' });
    assert.deepEqual(overlay, { GSD_ATLAS_WORKER: '1' });
  });
});
