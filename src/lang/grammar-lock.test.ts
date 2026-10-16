import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PLATFORM_KEYS, expectedPlatformSha256, parseGrammarLock, platformKey } from './grammar-lock.ts';
import type { GrammarLock } from './grammar-lock.ts';

const HEX64 = 'a'.repeat(64);
const WIN64 = 'c'.repeat(64);

function localLock(): Record<string, unknown> {
  return {
    lockVersion: 2,
    name: 'atlas_toy',
    source: { type: 'local', path: 'grammar' },
    patches: [],
    license: 'MIT',
    cli: { version: '0.27.1' },
    abi: 15,
    wasm: { file: 'grammar.wasm', sha256: HEX64, platforms: { 'linux-x64': HEX64, 'win32-x64': WIN64 } },
  };
}

function withWasm(lock: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...lock, wasm: { ...(lock['wasm'] as Record<string, unknown>), ...patch } };
}

function upstreamLock(): Record<string, unknown> {
  return {
    ...localLock(),
    source: {
      type: 'upstream',
      url: 'https://example.com/grammar.tar.gz',
      ref: 'v1.0.0',
      archiveSha256: 'b'.repeat(64),
      subdir: 'tree-sitter-x',
    },
    patches: ['patches/0001-fix.patch'],
  };
}

describe('parseGrammarLock', () => {
  it('accepts a lock with a local source', () => {
    const result = parseGrammarLock(localLock(), 'toy/grammar.lock');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lock.name, 'atlas_toy');
      assert.equal(result.lock.wasm.sha256, HEX64);
    }
  });

  it('accepts a lock with an upstream source (https and file urls)', () => {
    assert.equal(parseGrammarLock(upstreamLock()).ok, true);
    const fileUrl = upstreamLock();
    (fileUrl['source'] as Record<string, unknown>)['url'] = 'file:///tmp/archive.tar.gz';
    assert.equal(parseGrammarLock(fileUrl).ok, true);
  });

  it('accepts a JSON text and rejects text that is not JSON without throwing', () => {
    assert.equal(parseGrammarLock(JSON.stringify(localLock())).ok, true);
    const bad = parseGrammarLock('{not json', 'x/grammar.lock');
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.diagnostics[0]?.code, 'lock_invalid');
      assert.equal(bad.diagnostics[0]?.subject, 'x/grammar.lock');
    }
  });

  const rejected: Array<[string, (lock: Record<string, unknown>) => Record<string, unknown>]> = [
    ['unknown top-level key', (l) => ({ ...l, extra: 1 })],
    ['lockVersion 1 (single hash, no platforms)', (l) => ({ ...l, lockVersion: 1 })],
    ['lockVersion 3', (l) => ({ ...l, lockVersion: 3 })],
    ['wasm sha256 with uppercase hex', (l) => withWasm(l, { sha256: 'A'.repeat(64) })],
    ['wasm sha256 too short', (l) => withWasm(l, { sha256: 'a'.repeat(63) })],
    ['missing wasm.platforms', (l) => withWasm(l, { platforms: undefined })],
    ['empty wasm.platforms', (l) => withWasm(l, { platforms: {} })],
    ['platform entry that is not 64 lowercase hex', (l) => withWasm(l, { platforms: { 'linux-x64': 'xyz' } })],
    ['platform key outside the closed set', (l) => withWasm(l, { platforms: { 'linux-x64': HEX64, 'freebsd-x64': HEX64 } })],
    ['platform key that is not platform-arch', (l) => withWasm(l, { platforms: { 'linux-x64': HEX64, win32: HEX64 } })],
    ['no platform entry equals the committed wasm sha256', (l) => withWasm(l, { platforms: { 'win32-x64': WIN64 } })],
    ['unknown key inside wasm', (l) => withWasm(l, { extra: 1 })],
    ['absolute local path', (l) => ({ ...l, source: { type: 'local', path: '/etc/grammar' } })],
    ['dot-dot local path', (l) => ({ ...l, source: { type: 'local', path: '../grammar' } })],
    ['dot-dot segment in the middle', (l) => ({ ...l, source: { type: 'local', path: 'a/../../b' } })],
    ['drive letter local path', (l) => ({ ...l, source: { type: 'local', path: 'C:/grammar' } })],
    ['backslash local path', (l) => ({ ...l, source: { type: 'local', path: 'a\\b' } })],
    ['NUL in local path', (l) => ({ ...l, source: { type: 'local', path: 'a\0b' } })],
    ['absolute patch path', (l) => ({ ...l, patches: ['/tmp/x.patch'] })],
    ['dot-dot patch path', (l) => ({ ...l, patches: ['../x.patch'] })],
    ['unknown key inside source', (l) => ({ ...l, source: { type: 'local', path: 'grammar', more: true } })],
    ['non-integer abi', (l) => ({ ...l, abi: 15.5 })],
    ['bad cli version', (l) => ({ ...l, cli: { version: '0.27' } })],
    ['empty license', (l) => ({ ...l, license: '' })],
  ];
  for (const [label, mutate] of rejected) {
    it(`rejects ${label} with a lock_invalid diagnostic`, () => {
      const result = parseGrammarLock(mutate(localLock()), 'toy/grammar.lock');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.diagnostics.length > 0);
        for (const d of result.diagnostics) {
          assert.equal(d.code, 'lock_invalid');
          assert.equal(d.severity, 'warning');
          assert.equal(d.subject, 'toy/grammar.lock');
        }
      }
    });
  }

  it('rejects an http (non-https, non-file) upstream url', () => {
    const lock = upstreamLock();
    (lock['source'] as Record<string, unknown>)['url'] = 'http://example.com/grammar.tar.gz';
    const result = parseGrammarLock(lock);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]?.code, 'lock_invalid');
    }
  });

  it('rejects an upstream archiveSha256 that is not 64 lowercase hex', () => {
    const lock = upstreamLock();
    (lock['source'] as Record<string, unknown>)['archiveSha256'] = 'xyz';
    assert.equal(parseGrammarLock(lock).ok, false);
  });

  it('never throws on non-object input', () => {
    for (const input of [null, undefined, 42, [], 'null', true]) {
      const result = parseGrammarLock(input);
      assert.equal(result.ok, false);
    }
  });
});

describe('platformKey', () => {
  it('maps the three CI platforms and the rest of the closed set to their keys', () => {
    assert.equal(platformKey('linux', 'x64'), 'linux-x64');
    assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(platformKey('win32', 'x64'), 'win32-x64');
    for (const key of PLATFORM_KEYS) {
      const [platform, arch] = key.split('-');
      assert.equal(platformKey(platform, arch), key);
    }
  });

  it('is undefined outside the closed set', () => {
    assert.equal(platformKey('freebsd', 'x64'), undefined);
    assert.equal(platformKey('linux', 'riscv64'), undefined);
    assert.equal(platformKey('linux', 'x64-musl'), undefined);
  });
});

describe('expectedPlatformSha256', () => {
  function lock(): GrammarLock {
    const parsed = parseGrammarLock(localLock());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      throw new Error('unreachable');
    }
    return parsed.lock;
  }

  it('returns each platform its own entry, which may differ from the committed hash', () => {
    const linux = expectedPlatformSha256(lock(), 'linux', 'x64');
    assert.deepEqual(linux, { ok: true, key: 'linux-x64', sha256: HEX64 });
    const windows = expectedPlatformSha256(lock(), 'win32', 'x64');
    assert.deepEqual(windows, { ok: true, key: 'win32-x64', sha256: WIN64 });
  });

  it('fails, naming the platform key and the update hint, for a supported platform with no entry', () => {
    const result = expectedPlatformSha256(lock(), 'darwin', 'arm64');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.key, 'darwin-arm64');
      assert.ok(result.message.includes('darwin-arm64'));
      assert.ok(result.message.includes('--update-platform'));
    }
  });

  it('fails for a platform outside the closed set', () => {
    const result = expectedPlatformSha256(lock(), 'freebsd', 'x64');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.key, undefined);
      assert.ok(result.message.includes('freebsd-x64'));
    }
  });
});
