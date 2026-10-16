import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../test-kit/index.ts';
import { resolveExecutable } from './index.ts';
import type { ResolvedExecutable } from './index.ts';

/** A fake file system for the win32 rules: only these exact paths "exist". */
const files = (...present: string[]) => (p: string): boolean => present.includes(p);

const GIT_DIR = 'C:\\Program Files\\Git\\cmd';
const WIN_PATH = `C:\\Windows\\System32;${GIT_DIR}`;

function failure(r: ResolvedExecutable): { code: string; message: string } {
  assert.equal(r.ok, false, 'expected a failure, got ' + JSON.stringify(r));
  if (r.ok) throw new Error('unreachable');
  return r.diagnostic;
}

describe('resolveExecutable: win32 (platform injection)', () => {
  it('resolves bare git to git.exe found on PATH', () => {
    const r = resolveExecutable('git', {
      platform: 'win32',
      env: { PATH: WIN_PATH },
      pathExists: files(`${GIT_DIR}\\git.exe`),
    });
    assert.deepEqual(r, { ok: true, path: `${GIT_DIR}\\git.exe` });
  });

  it('keeps an explicit .exe extension and tries .com when there is no .exe', () => {
    const exe = resolveExecutable('tool.exe', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: files(`${GIT_DIR}\\tool.exe`) });
    assert.deepEqual(exe, { ok: true, path: `${GIT_DIR}\\tool.exe` });
    const com = resolveExecutable('tool', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: files(`${GIT_DIR}\\tool.com`) });
    assert.deepEqual(com, { ok: true, path: `${GIT_DIR}\\tool.com` });
  });

  it('shim_rejected: a PATH that holds only git.cmd', () => {
    const d = failure(
      resolveExecutable('git', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: files(`${GIT_DIR}\\git.cmd`) }),
    );
    assert.equal(d.code, 'shim_rejected');
  });

  it('shim_rejected: a PATH that holds only npm.cmd, and npm or npx by name', () => {
    const only = failure(
      resolveExecutable('npm', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: files(`${GIT_DIR}\\npm.cmd`) }),
    );
    assert.equal(only.code, 'shim_rejected');
    // Even a real npm.exe or npx.exe is refused: Node scripts run as process.execPath <script>.
    for (const name of ['npm', 'npx', 'npm.exe', 'npx.exe']) {
      const d = failure(
        resolveExecutable(name, { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: files(`${GIT_DIR}\\npm.exe`, `${GIT_DIR}\\npx.exe`) }),
      );
      assert.equal(d.code, 'shim_rejected', name);
    }
  });

  it('shim_rejected: a name ending .cmd', () => {
    const d = failure(resolveExecutable('build.cmd', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: () => true }));
    assert.equal(d.code, 'shim_rejected');
  });

  it('shim_rejected: a name ending .bat, upper case, even as an existing absolute path', () => {
    const bare = failure(resolveExecutable('setup.BAT', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: () => true }));
    assert.equal(bare.code, 'shim_rejected');
    const abs = failure(resolveExecutable('C:\\tools\\run.bat', { platform: 'win32', env: {}, pathExists: () => true }));
    assert.equal(abs.code, 'shim_rejected');
  });

  it('accepts an absolute path ending .exe', () => {
    const r = resolveExecutable('C:\\Program Files\\nodejs\\node.exe', {
      platform: 'win32',
      env: {},
      pathExists: files('C:\\Program Files\\nodejs\\node.exe'),
    });
    assert.deepEqual(r, { ok: true, path: 'C:\\Program Files\\nodejs\\node.exe' });
  });

  it('adds .exe to an absolute path without an extension', () => {
    const r = resolveExecutable('C:\\tools\\tool', { platform: 'win32', env: {}, pathExists: files('C:\\tools\\tool.exe') });
    assert.deepEqual(r, { ok: true, path: 'C:\\tools\\tool.exe' });
  });

  it('refuses extensions that are not .exe or .com', () => {
    const d = failure(resolveExecutable('C:\\tools\\run.ps1', { platform: 'win32', env: {}, pathExists: () => true }));
    assert.equal(d.code, 'spawn_failed');
  });

  it('finds the PATH variable case-insensitively (Path and PATH)', () => {
    const exists = files(`${GIT_DIR}\\git.exe`);
    for (const key of ['Path', 'PATH', 'path']) {
      const r = resolveExecutable('git', { platform: 'win32', env: { [key]: WIN_PATH }, pathExists: exists });
      assert.deepEqual(r, { ok: true, path: `${GIT_DIR}\\git.exe` }, key);
    }
  });

  it('reports a name that is nowhere on PATH as spawn_failed', () => {
    const d = failure(resolveExecutable('nothing', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: files() }));
    assert.equal(d.code, 'spawn_failed');
  });

  it('refuses relative paths with a separator', () => {
    assert.equal(failure(resolveExecutable('.\\tool.exe', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: () => true })).code, 'spawn_failed');
    assert.equal(failure(resolveExecutable('bin/tool', { platform: 'win32', env: { PATH: WIN_PATH }, pathExists: () => true })).code, 'spawn_failed');
  });
});

describe('resolveExecutable: posix', () => {
  it('searches PATH in order with injected existence', () => {
    const r = resolveExecutable('git', { platform: 'linux', env: { PATH: '/a:/b:/c' }, pathExists: files('/b/git', '/c/git') });
    assert.deepEqual(r, { ok: true, path: '/b/git' });
  });

  it('accepts an absolute path that exists and rejects one that does not', () => {
    assert.deepEqual(resolveExecutable('/usr/bin/tool', { platform: 'linux', env: {}, pathExists: files('/usr/bin/tool') }), {
      ok: true,
      path: '/usr/bin/tool',
    });
    assert.equal(failure(resolveExecutable('/usr/bin/tool', { platform: 'linux', env: {}, pathExists: files() })).code, 'spawn_failed');
  });

  it('does not treat .cmd as special on posix', () => {
    const r = resolveExecutable('build.cmd', { platform: 'linux', env: { PATH: '/a' }, pathExists: files('/a/build.cmd') });
    assert.equal(r.ok, true);
  });

  it('a missing or empty PATH is spawn_failed', () => {
    assert.equal(failure(resolveExecutable('git', { platform: 'linux', env: {} })).code, 'spawn_failed');
    assert.equal(failure(resolveExecutable('git', { platform: 'linux', env: { PATH: '' } })).code, 'spawn_failed');
  });

  it('uses the executable bit (real files)', { skip: process.platform === 'win32' }, () => {
    const tmp = makeTempDir();
    try {
      const plain = path.join(tmp.path, 'plain');
      const runnable = path.join(tmp.path, 'runnable');
      fs.writeFileSync(plain, '#!/bin/sh\n');
      fs.writeFileSync(runnable, '#!/bin/sh\n');
      fs.chmodSync(plain, 0o644);
      fs.chmodSync(runnable, 0o755);
      assert.equal(failure(resolveExecutable(plain, { platform: process.platform })).code, 'spawn_failed');
      assert.deepEqual(resolveExecutable(runnable, { platform: process.platform }), { ok: true, path: runnable });
      assert.deepEqual(resolveExecutable('runnable', { platform: process.platform, env: { PATH: `${tmp.path}${path.delimiter}/nonexistent` } }), {
        ok: true,
        path: runnable,
      });
      assert.equal(failure(resolveExecutable('plain', { platform: process.platform, env: { PATH: tmp.path } })).code, 'spawn_failed');
    } finally {
      tmp.cleanup();
    }
  });
});
