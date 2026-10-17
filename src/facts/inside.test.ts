import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isInside } from './inside.ts';

describe('isInside (posix paths)', () => {
  const posix = path.posix;

  it('the same path is inside', () => {
    assert.equal(isInside('/a/b', '/a/b', posix), true);
  });

  it('a child and a deep descendant are inside', () => {
    assert.equal(isInside('/a/b', '/a/b/c', posix), true);
    assert.equal(isInside('/a/b', '/a/b/c/d/e.ts', posix), true);
  });

  it('sibling prefix: /a/bc is not inside /a/b', () => {
    assert.equal(isInside('/a/b', '/a/bc', posix), false);
    assert.equal(isInside('/a/b', '/a/bc/d', posix), false);
  });

  it('the parent and unrelated paths are outside', () => {
    assert.equal(isInside('/a/b', '/a', posix), false);
    assert.equal(isInside('/a/b', '/', posix), false);
    assert.equal(isInside('/a/b', '/x/y', posix), false);
    assert.equal(isInside('/a/b', '/a/b/../c', posix), false);
  });

  it('dot-dot name: a directory called ..cache below the root is inside', () => {
    assert.equal(isInside('/a/b', '/a/b/..cache', posix), true);
    assert.equal(isInside('/a/b', '/a/b/..cache/x.ts', posix), true);
    assert.equal(isInside('/a/b', '/a/b/..', posix), false, 'a path that resolves to the parent is outside');
  });

  it('trailing separators on either argument do not matter', () => {
    assert.equal(isInside('/a/b/', '/a/b/c', posix), true);
    assert.equal(isInside('/a/b', '/a/b/c/', posix), true);
    assert.equal(isInside('/a/b/', '/a/b/', posix), true);
    assert.equal(isInside('/a/b/', '/a/bc/', posix), false);
  });

  it('the root of the file system contains everything absolute', () => {
    assert.equal(isInside('/', '/a/b', posix), true);
  });

  it('the default flavour is the one of the running platform', () => {
    const root = path.resolve('some', 'root');
    assert.equal(isInside(root, path.join(root, 'x')), true);
    assert.equal(isInside(root, `${root}x`), false);
  });
});

describe('isInside (windows paths, run on every OS)', () => {
  const win32 = path.win32;

  it('windows drive: a path below the root is inside, another drive is not', () => {
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\b\\c', win32), true);
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\b', win32), true);
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\bc', win32), false);
    assert.equal(isInside('C:\\a', 'D:\\x', win32), false);
    assert.equal(isInside('C:\\a', 'D:\\a\\b', win32), false);
  });

  it('windows case: differing case counts as inside', () => {
    assert.equal(isInside('C:\\a\\b', 'c:\\A\\B\\c', win32), true);
    assert.equal(isInside('c:\\A\\B', 'C:\\a\\b', win32), true);
    assert.equal(isInside('C:\\a\\b', 'C:\\A\\BC', win32), false);
  });

  it('windows dot-dot name and forward slashes', () => {
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\b\\..cache', win32), true);
    assert.equal(isInside('C:\\a\\b', 'C:\\a', win32), false);
    assert.equal(isInside('C:\\a\\b', 'C:/a/b/c', win32), true);
  });
});
