import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir, realPath } from '../test-kit/index.ts';
import { CONFIG_FILE, loadUserConfig } from './config.ts';

const HASH = 'a'.repeat(64);

function load(content: unknown): ReturnType<typeof loadUserConfig> {
  const tmp = makeTempDir();
  try {
    fs.writeFileSync(path.join(tmp.path, CONFIG_FILE), JSON.stringify(content));
    return loadUserConfig(tmp.path, {});
  } finally {
    tmp.cleanup();
  }
}

const repo = realPath(process.cwd());

describe('loadUserConfig: permissions.allow[].sha256 (D-15)', () => {
  it('accepts sha256 on an allow entry', () => {
    const loaded = load({ permissions: { allow: [{ repo, executable: 'node', sha256: HASH }] } });
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.config.permissions?.allow, [{ repo, executable: 'node', sha256: HASH }]);
  });

  it('accepts sha256 together with argsPrefix', () => {
    const loaded = load({ permissions: { allow: [{ repo, executable: 'node', argsPrefix: ['-e'], sha256: HASH }] } });
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.config.permissions?.allow[0]?.sha256, HASH);
    assert.deepEqual(loaded.config.permissions?.allow[0]?.argsPrefix, ['-e']);
  });

  it('entry without sha256 still valid', () => {
    const loaded = load({ permissions: { allow: [{ repo, executable: 'node' }, { repo, executable: 'git', argsPrefix: ['status'] }] } });
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.config.permissions?.allow.length, 2);
    assert.equal(loaded.config.permissions?.allow[0]?.sha256, undefined);
  });

  it('rejects malformed sha256 whole file', () => {
    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ['non-hex text', 'XYZ'],
      ['upper-case hex', 'A'.repeat(64)],
      ['too short', 'a'.repeat(63)],
      ['too long', 'a'.repeat(65)],
      ['empty', ''],
      ['a number', 12],
      ['a trailing newline', `${'a'.repeat(64)}\n`],
    ];
    for (const [what, sha256] of malformed) {
      // A second, valid entry and an unrelated setting prove nothing is half applied.
      const loaded = load({
        gc: { graceMs: 5 },
        permissions: { allow: [{ repo, executable: 'git' }, { repo, executable: 'node', sha256 }] },
      });
      assert.deepEqual(loaded.config, {}, what);
      assert.equal(loaded.config.permissions, undefined, what);
      assert.equal(loaded.diagnostics.length, 1, what);
      assert.equal(loaded.diagnostics[0]?.code, 'user_config_ignored', what);
      assert.equal(loaded.diagnostics[0]?.severity, 'warning', what);
    }
  });

  it('still refuses an unknown key on an allow entry', () => {
    const loaded = load({ permissions: { allow: [{ repo, executable: 'node', sha256: HASH, shell: true }] } });
    assert.deepEqual(loaded.config, {});
    assert.equal(loaded.diagnostics[0]?.code, 'user_config_ignored');
  });
});

describe('loadUserConfig: providers.disabled (SEC-02)', () => {
  it('providers.disabled accepts a list of provider ids and hands it to the Host', () => {
    const loaded = load({ providers: { disabled: ['typescript'] } });
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.config.providers, { disabled: ['typescript'] });
  });

  it('providers.disabled accepts an id nobody knows, an empty list and an absent list', () => {
    assert.deepEqual(load({ providers: { disabled: ['typescript', 'a-provider-from-a-newer-version'] } }).config.providers?.disabled, [
      'typescript',
      'a-provider-from-a-newer-version',
    ]);
    assert.deepEqual(load({ providers: { disabled: [] } }).config.providers, { disabled: [] });
    assert.deepEqual(load({ providers: {} }).config.providers, {});
    assert.equal(load({}).config.providers, undefined, 'providers are on by default: nothing is disabled unless the user says so');
  });

  it('providers.disabled that is not a list of strings, or has an unknown sibling, rejects the whole file', () => {
    const bad: ReadonlyArray<readonly [string, unknown]> = [
      ['a string', 'typescript'],
      ['an object', { typescript: true }],
      ['a number in the list', ['typescript', 3]],
      ['null', null],
    ];
    for (const [what, disabled] of bad) {
      const loaded = load({ gc: { graceMs: 5 }, providers: { disabled } });
      assert.deepEqual(loaded.config, {}, what);
      assert.equal(loaded.diagnostics.length, 1, what);
      assert.equal(loaded.diagnostics[0]?.code, 'user_config_ignored', what);
    }
    const sibling = load({ providers: { disabled: ['typescript'], enabled: ['x'] } });
    assert.deepEqual(sibling.config, {});
    assert.equal(sibling.diagnostics[0]?.code, 'user_config_ignored');
  });
});
