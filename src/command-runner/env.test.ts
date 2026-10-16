import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
