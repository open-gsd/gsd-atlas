import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGrammarLock } from './grammar-lock.ts';

const HEX64 = 'a'.repeat(64);

function localLock(): Record<string, unknown> {
  return {
    lockVersion: 1,
    name: 'atlas_toy',
    source: { type: 'local', path: 'grammar' },
    patches: [],
    license: 'MIT',
    cli: { version: '0.27.1' },
    abi: 15,
    wasm: { file: 'grammar.wasm', sha256: HEX64 },
  };
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
    ['lockVersion 2', (l) => ({ ...l, lockVersion: 2 })],
    ['wasm sha256 with uppercase hex', (l) => ({ ...l, wasm: { file: 'grammar.wasm', sha256: 'A'.repeat(64) } })],
    ['wasm sha256 too short', (l) => ({ ...l, wasm: { file: 'grammar.wasm', sha256: 'a'.repeat(63) } })],
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
