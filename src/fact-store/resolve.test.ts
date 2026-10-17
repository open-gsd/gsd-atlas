import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { contextKey, overlaySnapshotId } from './cache.ts';
import { candidatePaths, resolveSpecifier } from './specifier.ts';

describe('overlaySnapshotId', () => {
  it('is the sha256 of the sorted path and hash pairs, in hex, whatever the map order', () => {
    const expected = createHash('sha256')
      .update('src/a.ts\u0000aaa\u0000src/b.ts\u0000bbb\u0000')
      .digest('hex');
    assert.equal(overlaySnapshotId(new Map([['src/a.ts', 'aaa'], ['src/b.ts', 'bbb']])), expected);
    assert.equal(overlaySnapshotId(new Map([['src/b.ts', 'bbb'], ['src/a.ts', 'aaa']])), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  it('differs when a hash or a path changes, and two overlays with identical contents share an id', () => {
    const base = new Map([['src/a.ts', 'aaa'], ['src/b.ts', 'bbb']]);
    const id = overlaySnapshotId(base);
    assert.equal(overlaySnapshotId(new Map(base)), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.ts', 'aaa'], ['src/b.ts', 'ccc']])), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.ts', 'aaa'], ['src/c.ts', 'bbb']])), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.ts', 'aaa']])), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.tsaaa', '']])), overlaySnapshotId(new Map([['src/a.ts', 'aaa']])));
  });

  it('gives an overlay with no files an id of its own', () => {
    assert.equal(overlaySnapshotId(new Map()), createHash('sha256').digest('hex'));
  });
});

describe('contextKey', () => {
  it('is the JSON of the id and the sorted config hashes, so the order of hashes does not matter', () => {
    const key = contextKey({ id: 'ctx', configHashes: ['b', 'a'] });
    assert.equal(key, '{"id":"ctx","configHashes":["a","b"]}');
    assert.equal(contextKey({ id: 'ctx', configHashes: ['a', 'b'] }), key);
  });

  it('accepts an empty context: an id and no config hashes', () => {
    assert.equal(contextKey({ id: 'grammar', configHashes: [] }), '{"id":"grammar","configHashes":[]}');
  });
});

const paths = (...list: string[]): ReadonlySet<string> => new Set(list);

describe('resolveSpecifier', () => {
  it('resolves ./b to src/b.ts, to src/b/index.ts when only that exists, and to both, sorted, when both exist', () => {
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './b', paths('src/main.ts', 'src/b.ts')), ['src/b.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './b', paths('src/main.ts', 'src/b/index.ts')), ['src/b/index.ts']);
    assert.deepStrictEqual(
      resolveSpecifier('src/main.ts', './b', paths('src/b/index.ts', 'src/main.ts', 'src/b.ts')),
      ['src/b.ts', 'src/b/index.ts'],
    );
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './missing', paths('src/main.ts', 'src/b.ts')), []);
  });

  it('resolves nothing for a package name, a scoped package, an absolute path or a node: built-in', () => {
    const overlay = paths('src/main.ts', 'lodash.ts', 'lodash/index.ts', 'src/lodash.ts');
    for (const specifier of ['lodash', '@scope/pkg', '/abs', 'node:fs', 'src/lodash', '']) {
      assert.deepStrictEqual(resolveSpecifier('src/main.ts', specifier, overlay), [], specifier);
    }
  });

  it('matches both foo.cts and foo.cjs for ../lib/x.cjs from src/a/main.ts', () => {
    const overlay = paths('src/a/main.ts', 'src/lib/x.cts', 'src/lib/x.cjs', 'src/lib/y.cjs');
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../lib/x.cjs', overlay), ['src/lib/x.cjs', 'src/lib/x.cts']);
  });

  it('matches src/a.b.ts for a specifier with an extra dot in the base name (./a.b)', () => {
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './a.b', paths('src/main.ts', 'src/a.b.ts')), ['src/a.b.ts']);
  });

  it('matches by exact path, by extension-stripped path and by extension-stripped specifier', () => {
    const overlay = paths('src/main.ts', 'src/util.js', 'src/util.ts');
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util.js', overlay), ['src/util.js', 'src/util.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util.ts', paths('src/main.ts', 'src/util.ts')), ['src/util.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util', overlay), ['src/util.js', 'src/util.ts']);
  });

  it('a specifier that ends in a slash, a dot or two dots names a directory index only', () => {
    const overlay = paths('src/main.ts', 'src/util.ts', 'src/util/index.ts', 'src/index.ts', 'index.ts');
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util/', overlay), ['src/util/index.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', '.', overlay), ['src/index.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', '..', overlay), ['index.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util/', paths('src/main.ts', 'src/util.ts')), []);
  });

  it('a specifier that climbs above the root resolves to nothing, and ordinary .. hops resolve', () => {
    const overlay = paths('src/a/main.ts', 'src/lib/util.ts', 'util.ts');
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../../../util', overlay), []);
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../../util', overlay), ['util.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../lib/util', overlay), ['src/lib/util.ts']);
    assert.deepStrictEqual(resolveSpecifier('main.ts', './util', overlay), ['util.ts']);
  });
});

describe('candidatePaths', () => {
  it('lists the resolved base, the base with each claimed extension and the directory index files, in code-unit order', () => {
    assert.deepStrictEqual(candidatePaths('src/main.ts', './b', ['.ts', '.cts']), [
      'src/b',
      'src/b.cts',
      'src/b.ts',
      'src/b/index.cts',
      'src/b/index.ts',
    ]);
  });

  it('adds the extension-stripped variants for a specifier that ends in an extension', () => {
    assert.deepStrictEqual(candidatePaths('src/a/main.ts', '../lib/x.cjs', ['.cts', '.ts']), [
      'src/lib/x',
      'src/lib/x.cjs',
      'src/lib/x.cjs.cts',
      'src/lib/x.cjs.ts',
      'src/lib/x.cjs/index.cts',
      'src/lib/x.cjs/index.ts',
      'src/lib/x.cts',
      'src/lib/x.ts',
    ]);
  });

  it('names only the index file for a specifier that is a directory, and nothing for non-relative or escaping ones', () => {
    assert.deepStrictEqual(candidatePaths('src/main.ts', './util/', ['.ts']), ['src/util/index.ts']);
    assert.deepStrictEqual(candidatePaths('src/main.ts', '.', ['.ts']), ['src/index.ts']);
    assert.deepStrictEqual(candidatePaths('src/main.ts', '..', ['.ts']), ['index.ts']);
    for (const specifier of ['lodash', '@scope/pkg', '/abs', 'node:fs', '', '../../x']) {
      assert.deepStrictEqual(candidatePaths('src/main.ts', specifier, ['.ts']), [], specifier);
    }
  });

  it('has no duplicates and is sorted whatever the extensions repeat', () => {
    const list = candidatePaths('src/main.ts', './b', ['.ts', '.ts', '.js']);
    assert.deepStrictEqual(list, [...new Set(list)].sort());
  });

  it('contains every path the rule can match: resolving over the candidates that exist gives the rule\'s answer', () => {
    const everything = [
      'src/main.ts',
      'src/b.ts',
      'src/b.js',
      'src/b/index.ts',
      'src/b.cjs',
      'src/b.cts',
      'src/a.b.ts',
      'src/util/index.js',
      'src/util.ts',
      'index.ts',
      'src/index.ts',
      'src/other.ts',
    ];
    const extensions = ['.cjs', '.cts', '.js', '.ts'];
    const specifiers = ['./b', './b.js', './b.cjs', './a.b', './util', './util/', '.', '..', './missing', './other.ts'];
    for (const specifier of specifiers) {
      const universe = paths(...everything);
      const probed = paths(...everything.filter((p) => candidatePaths('src/main.ts', specifier, extensions).includes(p)));
      assert.deepStrictEqual(resolveSpecifier('src/main.ts', specifier, probed), resolveSpecifier('src/main.ts', specifier, universe), specifier);
    }
  });
});
