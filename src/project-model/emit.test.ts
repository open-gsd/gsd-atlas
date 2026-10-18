import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReadTextResult } from '../source-tree/index.ts';
import { createTypeScriptProjectModel } from './index.ts';
import type { ProjectDescription, ProjectFs } from './index.ts';

// ---------------------------------------------------------------------------------------------
// Helpers: a fake reader over a map of repo-relative path to text.

function fakeFs(tree: Readonly<Record<string, string>>): ProjectFs {
  return {
    async readText(p: string): Promise<ReadTextResult> {
      if (p.startsWith('/') || p.split('/').includes('..')) return { kind: 'escape' };
      const text = tree[p];
      return text === undefined ? { kind: 'missing' } : { kind: 'ok', text };
    },
    async exists(paths: readonly string[]): Promise<ReadonlySet<string>> {
      return new Set(paths.filter((p) => tree[p] !== undefined));
    },
  };
}

async function describeTree(tree: Readonly<Record<string, string>>, overlayPaths?: readonly string[]): Promise<ProjectDescription> {
  const f = fakeFs(tree);
  return createTypeScriptProjectModel(f).describe({ overlayPaths: overlayPaths ?? Object.keys(tree), fs: f });
}

const config = (compilerOptions: Record<string, unknown>, rest: Record<string, unknown> = {}): string =>
  JSON.stringify({ compilerOptions, ...rest });

// ---------------------------------------------------------------------------------------------
// Task 1: the tracer subset. Task 2 adds the rest of the table, the edge cases and the compiler differential.

describe('emit map: the extension rules the tracer needs (TSM-03)', () => {
  it('cts to cjs: the output maps to its source and the source to its output', async () => {
    const description = await describeTree({
      'tsconfig.json': config({ rootDir: 'src', outDir: 'out', module: 'nodenext' }, { include: ['src/**/*.cts'] }),
      'src/lib.cts': 'export {};\n',
      'src/user.cts': 'export {};\n',
      'consumer.cjs': '"use strict";\n',
    });
    const { emit } = description;
    assert.equal(emit.outputToSource('out/lib.cjs'), 'src/lib.cts');
    assert.deepStrictEqual(emit.sourceToOutputs('src/lib.cts'), ['out/lib.cjs']);
    assert.equal(emit.isOutput('out/lib.cjs'), true);
    assert.equal(emit.isOutput('src/lib.cts'), false);
    assert.equal(emit.isOutput('consumer.cjs'), false);
    assert.equal(emit.outputToSource('out/user.cjs'), 'src/user.cts');
    assert.deepStrictEqual(emit.sourceToOutputs('consumer.cjs'), [], 'a file no config includes has no output');
  });

  it('mts to mjs: the extension map keeps the module flavour', async () => {
    const { emit } = await describeTree({
      'tsconfig.json': config({ rootDir: 'src', outDir: 'dist' }, { include: ['src'] }),
      'src/esm.mts': 'export {};\n',
      'src/sub/other.mts': 'export {};\n',
    });
    assert.deepStrictEqual(emit.sourceToOutputs('src/esm.mts'), ['dist/esm.mjs']);
    assert.equal(emit.outputToSource('dist/sub/other.mjs'), 'src/sub/other.mts');
  });

  it('ts to js: rootDir is stripped and outDir is added, and with no outDir the output sits next to its source', async () => {
    const withOut = await describeTree({
      'tsconfig.json': config({ rootDir: 'src', outDir: 'build' }, { include: ['src'] }),
      'src/a/x.ts': 'export {};\n',
    });
    assert.deepStrictEqual(withOut.emit.sourceToOutputs('src/a/x.ts'), ['build/a/x.js']);
    const beside = await describeTree({
      'tsconfig.json': config({}, { include: ['src'] }),
      'src/a/x.ts': 'export {};\n',
    });
    assert.deepStrictEqual(beside.emit.sourceToOutputs('src/a/x.ts'), ['src/a/x.js']);
    assert.equal(beside.emit.outputToSource('src/a/x.js'), 'src/a/x.ts');
  });

  it('a noEmit config that extends the build config still places outputs by the inherited outDir (the gsd-core pair)', async () => {
    // gsd-core: tsconfig.json (noEmit, include src/**/*.cts) extends tsconfig.build.json, which nothing references, so
    // discovery by directory finds only the typecheck config and the build's outDir comes through `extends`.
    const { emit } = await describeTree({
      'tsconfig.build.json': config({ rootDir: 'src', outDir: 'gsd-core/bin/lib' }, { include: ['src/**/*.cts'] }),
      'tsconfig.json': config({ noEmit: true }, { extends: './tsconfig.build.json', include: ['src/**/*.cts'] }),
      'src/semver-compare.cts': 'export {};\n',
    });
    assert.deepStrictEqual(emit.sourceToOutputs('src/semver-compare.cts'), ['gsd-core/bin/lib/semver-compare.cjs']);
    assert.equal(emit.outputToSource('gsd-core/bin/lib/semver-compare.cjs'), 'src/semver-compare.cts');
  });

  it('a noEmit config with no outDir maps nothing: it writes no .js beside its sources', async () => {
    const { emit } = await describeTree({
      'tsconfig.json': config({ noEmit: true }, { include: ['src'] }),
      'src/a.cts': 'export {};\n',
    });
    assert.deepStrictEqual(emit.sourceToOutputs('src/a.cts'), []);
    assert.equal(emit.isOutput('src/a.cjs'), false);
  });

  it('no tsconfig: nothing is an output and nothing throws', async () => {
    const { emit } = await describeTree({ 'src/lib.cts': 'export {};\n', 'out/lib.cjs': '"use strict";\n' });
    assert.equal(emit.outputToSource('out/lib.cjs'), undefined);
    assert.equal(emit.isOutput('out/lib.cjs'), false);
    assert.deepStrictEqual(emit.sourceToOutputs('src/lib.cts'), []);
  });
});
