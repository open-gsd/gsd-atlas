import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canonicalCommand, commandHash } from './index.ts';

const REPO = path.resolve(path.sep, 'r');

describe('commandHash: the exact-argv approval hash (D-15)', () => {
  it('hashes the same spec to the same lower-case 64-hex value', () => {
    const a = commandHash({ executable: 'node', args: ['a', 'b'] }, REPO);
    const b = commandHash({ executable: 'node', args: ['a', 'b'] }, REPO);
    assert.equal(a, b);
    assert.match(a ?? '', /^[0-9a-f]{64}$/);
  });

  it('is the sha256 of the canonical JSON text', () => {
    const text = canonicalCommand({ executable: 'node', args: ['x'] }, REPO);
    assert.equal(text, '{"executable":"node","args":["x"],"cwd":"."}');
    assert.equal(commandHash({ executable: 'node', args: ['x'] }, REPO), createHash('sha256').update(text ?? '').digest('hex'));
  });

  it('keeps the key order executable, args, cwd', () => {
    const text = canonicalCommand({ cwd: REPO, args: ['x'], executable: 'node' }, REPO) ?? '';
    assert.deepEqual(Object.keys(JSON.parse(text) as object), ['executable', 'args', 'cwd']);
  });

  it("does not confuse ['a b'] with ['a','b'] (no argument joining)", () => {
    assert.notEqual(
      commandHash({ executable: 'node', args: ['a b'] }, REPO),
      commandHash({ executable: 'node', args: ['a', 'b'] }, REPO),
    );
  });

  it('a different executable or argument hashes differently', () => {
    const base = commandHash({ executable: 'node', args: ['a'] }, REPO);
    assert.notEqual(base, commandHash({ executable: 'nodejs', args: ['a'] }, REPO));
    assert.notEqual(base, commandHash({ executable: 'node', args: ['b'] }, REPO));
    assert.notEqual(base, commandHash({ executable: 'node', args: ['a', ''] }, REPO));
  });

  it('an undefined cwd and the repository root hash equal', () => {
    assert.equal(
      commandHash({ executable: 'node', args: [] }, REPO),
      commandHash({ executable: 'node', args: [], cwd: REPO }, REPO),
    );
    assert.equal(
      commandHash({ executable: 'node', args: [] }, REPO),
      commandHash({ executable: 'node', args: [], cwd: '.' }, REPO),
    );
  });

  it('a sub-directory of the repository is a different command', () => {
    const root = commandHash({ executable: 'node', args: [] }, REPO);
    const sub = commandHash({ executable: 'node', args: [], cwd: path.join(REPO, 'sub') }, REPO);
    assert.notEqual(root, sub);
    assert.equal(canonicalCommand({ executable: 'node', args: [], cwd: path.join(REPO, 'sub', 'deep') }, REPO)?.endsWith('"cwd":"sub/deep"}'), true);
  });

  it('a relative cwd is taken against the repository root', () => {
    assert.equal(
      commandHash({ executable: 'node', args: [], cwd: 'sub' }, REPO),
      commandHash({ executable: 'node', args: [], cwd: path.join(REPO, 'sub') }, REPO),
    );
  });

  it('has no hash for a cwd outside the repository', () => {
    assert.equal(commandHash({ executable: 'node', args: [], cwd: path.resolve(path.sep, 'elsewhere') }, REPO), null);
    assert.equal(commandHash({ executable: 'node', args: [], cwd: '..' }, REPO), null);
    assert.equal(commandHash({ executable: 'node', args: [], cwd: path.join(REPO, '..', 'r2') }, REPO), null);
    assert.equal(canonicalCommand({ executable: 'node', args: [], cwd: path.resolve(path.sep, 'elsewhere') }, REPO), null);
  });

  it('accepts a directory whose name merely starts with two dots', () => {
    assert.notEqual(commandHash({ executable: 'node', args: [], cwd: path.join(REPO, '..cache') }, REPO), null);
  });

  it('has no hash when the repository is not an absolute path', () => {
    assert.equal(commandHash({ executable: 'node', args: [] }, 'relative/repo'), null);
  });

  it('canonicalises a Windows-style cwd inside the repository to forward slashes', () => {
    const text = canonicalCommand({ executable: 'node', args: [], cwd: 'C:\\r\\sub\\deep' }, 'C:\\r', path.win32);
    assert.equal(text, '{"executable":"node","args":[],"cwd":"sub/deep"}');
    assert.equal(canonicalCommand({ executable: 'node', args: [], cwd: 'C:\\r' }, 'C:\\r', path.win32)?.endsWith('"cwd":"."}'), true);
    assert.equal(canonicalCommand({ executable: 'node', args: [], cwd: 'D:\\r\\sub' }, 'C:\\r', path.win32), null);
    assert.equal(canonicalCommand({ executable: 'node', args: [], cwd: 'C:\\other' }, 'C:\\r', path.win32), null);
  });
});
