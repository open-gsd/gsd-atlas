import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EmitLookup } from '../facts/index.ts';
import { resolveSpecifier } from './specifier.ts';

const paths = (...list: string[]): ReadonlySet<string> => new Set(list);

/** An EmitLookup over a fixed table: output path to source, as one build with `rootDir: src` and `outDir: out` makes it. */
function emitOf(table: Readonly<Record<string, string>>): EmitLookup {
  return {
    outputToSource: (p) => table[p],
    sourceToOutputs: (p) => Object.entries(table).filter(([, source]) => source === p).map(([output]) => output),
    isOutput: (p) => table[p] !== undefined,
  };
}

describe('resolveSpecifier with an emit lookup (TSM-03)', () => {
  const emit = emitOf({ 'out/lib.cjs': 'src/lib.cts', 'out/deep/util.cjs': 'src/deep/util.cts' });

  it('a require of the emit output of an included source resolves to the source when nothing sits at the output path', () => {
    const overlay = paths('consumer.cjs', 'src/lib.cts', 'src/deep/util.cts');
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/lib.cjs', overlay, emit), ['src/lib.cts']);
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/deep/util.cjs', overlay, emit), ['src/deep/util.cts']);
    assert.deepStrictEqual(resolveSpecifier('tools/run.cjs', '../out/lib.cjs', paths('tools/run.cjs', 'src/lib.cts'), emit), ['src/lib.cts']);
  });

  it('a tracked file at the output path as well makes both candidates, sorted, so the importer is ambiguous', () => {
    const overlay = paths('consumer.cjs', 'src/lib.cts', 'out/lib.cjs');
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/lib.cjs', overlay, emit), ['out/lib.cjs', 'src/lib.cts']);
  });

  it('without an emit lookup the plain rule applies, and a path the lookup does not know changes nothing', () => {
    const overlay = paths('consumer.cjs', 'src/lib.cts');
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/lib.cjs', overlay), []);
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/lib.cjs', overlay, emitOf({})), []);
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/other.cjs', overlay, emit), []);
  });

  it('never offers a source the overlay does not hold, and never a path outside the overlay', () => {
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/lib.cjs', paths('consumer.cjs'), emit), []);
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', '../out/lib.cjs', paths('consumer.cjs', 'src/lib.cts'), emit), []);
    const hostile = emitOf({ 'out/lib.cjs': '../../etc/passwd' });
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', './out/lib.cjs', paths('consumer.cjs', 'src/lib.cts'), hostile), []);
  });

  it('a package name and an absolute path stay unresolved even when the lookup knows a path of that spelling', () => {
    const odd = emitOf({ 'lodash.js': 'src/lodash.ts', 'abs.cjs': 'src/abs.cts' });
    const overlay = paths('consumer.cjs', 'src/lodash.ts', 'src/abs.cts');
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', 'lodash.js', overlay, odd), []);
    assert.deepStrictEqual(resolveSpecifier('consumer.cjs', '/abs.cjs', overlay, odd), []);
  });
});
