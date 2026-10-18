import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
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

async function describeTree(
  tree: Readonly<Record<string, string>>,
  overlayPaths?: readonly string[],
  extraConfigs?: readonly string[],
): Promise<ProjectDescription> {
  const f = fakeFs(tree);
  return createTypeScriptProjectModel(f).describe({
    overlayPaths: overlayPaths ?? Object.keys(tree),
    fs: f,
    ...(extraConfigs === undefined ? {} : { extraConfigs }),
  });
}

// ---------------------------------------------------------------------------------------------
// The compiler as oracle: `ts.getOutputFileNames` over the same tree written to a temporary directory.

function withTree<T>(tree: Readonly<Record<string, string>>, body: (root: string) => T): T {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-emit-')));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const target = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Source to sorted output paths (source maps left out; an output equal to its own input left out) as the compiler reports them. */
function compilerOutputs(root: string, configRel: string): Map<string, string[]> {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    useCaseSensitiveFileNames: true,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, ...configRel.split('/')), {}, host);
  assert.ok(parsed !== undefined, 'the compiler could not read ' + configRel);
  const rel = (p: string): string => path.relative(root, p).split(path.sep).join('/');
  const out = new Map<string, string[]>();
  for (const file of parsed.fileNames) {
    const outputs = ts
      .getOutputFileNames(parsed, file, false)
      .map(rel)
      .filter((o) => !o.endsWith('.map') && o !== rel(file))
      .sort();
    out.set(rel(file), outputs);
  }
  return out;
}

/**
 * The differential: for every source the compiler lists, the model's outputs must equal the compiler's, and for every
 * other path of the tree the model must report none. Returns what each said, for the explicit assertions after it.
 */
async function agreeWithCompiler(
  tree: Readonly<Record<string, string>>,
  configRel = 'tsconfig.json',
): Promise<{ readonly description: ProjectDescription; readonly compiler: ReadonlyMap<string, string[]> }> {
  const description = await describeTree(tree);
  const compiler = withTree(tree, (root) => compilerOutputs(root, configRel));
  const bad: string[] = [];
  for (const p of Object.keys(tree)) {
    const mine = [...description.emit.sourceToOutputs(p)].sort();
    const theirs = compiler.get(p) ?? [];
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) bad.push(`${p}: model ${JSON.stringify(mine)} vs compiler ${JSON.stringify(theirs)}`);
  }
  assert.deepStrictEqual(bad, [], 'the model and the compiler disagree');
  return { description, compiler };
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

// ---------------------------------------------------------------------------------------------
// Task 2: the whole table, each case checked against the compiler, then the edge cases around it.

const SRC_OUT = { rootDir: 'src', outDir: 'out' };

describe('emit map: the extension table, checked against ts.getOutputFileNames (TSM-03)', () => {
  it('ts to js: nested sources keep their directories under outDir', async () => {
    const { description } = await agreeWithCompiler({
      'tsconfig.json': config({ rootDir: 'src', outDir: 'build' }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
      'src/deep/er/b.ts': 'export {};\n',
    });
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/deep/er/b.ts'), ['build/deep/er/b.js']);
  });

  it('cts to cjs and mts to mjs together with ts to js, in one project', async () => {
    const { description } = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, module: 'nodenext' }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
      'src/b.cts': 'export {};\n',
      'src/c.mts': 'export {};\n',
    });
    assert.deepStrictEqual(
      ['src/a.ts', 'src/b.cts', 'src/c.mts'].map((p) => description.emit.sourceToOutputs(p)),
      [['out/a.js'], ['out/b.cjs'], ['out/c.mjs']],
    );
  });

  it('tsx jsx preserve: .tsx becomes .jsx under preserve and .js otherwise, and allowJs .jsx follows the same rule', async () => {
    const preserve = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, jsx: 'preserve', allowJs: true }, { include: ['src'] }),
      'src/ui.tsx': 'export {};\n',
      'src/plain.ts': 'export {};\n',
      'src/legacy.jsx': 'export {};\n',
    });
    assert.deepStrictEqual(preserve.description.emit.sourceToOutputs('src/ui.tsx'), ['out/ui.jsx']);
    assert.deepStrictEqual(preserve.description.emit.sourceToOutputs('src/plain.ts'), ['out/plain.js']);
    assert.deepStrictEqual(preserve.description.emit.sourceToOutputs('src/legacy.jsx'), ['out/legacy.jsx']);
    const react = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, jsx: 'react-jsx', allowJs: true }, { include: ['src'] }),
      'src/ui.tsx': 'export {};\n',
      'src/legacy.jsx': 'export {};\n',
    });
    assert.deepStrictEqual(react.description.emit.sourceToOutputs('src/ui.tsx'), ['out/ui.js']);
    assert.deepStrictEqual(react.description.emit.sourceToOutputs('src/legacy.jsx'), ['out/legacy.js']);
  });

  it('declaration files never emit: .d.ts, .d.cts and .d.mts have no output and are never outputs', async () => {
    const { description } = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, declaration: true }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
      'src/types.d.ts': 'export {};\n',
      'src/types.d.cts': 'export {};\n',
      'src/types.d.mts': 'export {};\n',
    });
    for (const p of ['src/types.d.ts', 'src/types.d.cts', 'src/types.d.mts']) {
      assert.deepStrictEqual(description.emit.sourceToOutputs(p), [], p);
      assert.equal(description.emit.isOutput(p), false, p);
    }
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/a.ts'), ['out/a.d.ts', 'out/a.js']);
  });

  it('allowJs outputs: .js, .cjs, .mjs and .jsx inputs are written to outDir, and without allowJs they are not sources', async () => {
    const tree = {
      'src/a.js': 'module.exports = 1;\n',
      'src/b.cjs': 'module.exports = 1;\n',
      'src/c.mjs': 'export default 1;\n',
      'src/d.jsx': 'export default 1;\n',
      'src/e.ts': 'export {};\n',
    };
    const on = await agreeWithCompiler({ 'tsconfig.json': config({ ...SRC_OUT, allowJs: true }, { include: ['src'] }), ...tree });
    assert.deepStrictEqual(
      ['src/a.js', 'src/b.cjs', 'src/c.mjs', 'src/d.jsx', 'src/e.ts'].map((p) => on.description.emit.sourceToOutputs(p)),
      [['out/a.js'], ['out/b.cjs'], ['out/c.mjs'], ['out/d.js'], ['out/e.js']],
    );
    const off = await agreeWithCompiler({ 'tsconfig.json': config(SRC_OUT, { include: ['src'] }), ...tree });
    assert.deepStrictEqual(off.description.emit.sourceToOutputs('src/a.js'), []);
    assert.deepStrictEqual(off.description.emit.sourceToOutputs('src/e.ts'), ['out/e.js']);
  });

  it('declarations to declarationDir: kind declaration, in declarationDir when set and in outDir otherwise', async () => {
    const split = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, declaration: true, declarationDir: 'types', module: 'nodenext' }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
      'src/b.cts': 'export {};\n',
      'src/c.mts': 'export {};\n',
    });
    assert.deepStrictEqual(split.description.emit.outputsOf('src/b.cts'), [
      { path: 'out/b.cjs', kind: 'js' },
      { path: 'types/b.d.cts', kind: 'declaration' },
    ]);
    assert.deepStrictEqual(split.description.emit.sourceToOutputs('src/c.mts'), ['out/c.mjs', 'types/c.d.mts']);
    assert.equal(split.description.emit.outputToSource('types/a.d.ts'), 'src/a.ts');

    const together = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, declaration: true }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
    });
    assert.deepStrictEqual(together.description.emit.sourceToOutputs('src/a.ts'), ['out/a.d.ts', 'out/a.js']);

    const composite = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, composite: true }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
    });
    assert.deepStrictEqual(composite.description.emit.sourceToOutputs('src/a.ts'), ['out/a.d.ts', 'out/a.js'], 'composite implies declaration');

    const only = await agreeWithCompiler({
      'tsconfig.json': config({ ...SRC_OUT, declaration: true, emitDeclarationOnly: true }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
    });
    assert.deepStrictEqual(only.description.emit.sourceToOutputs('src/a.ts'), ['out/a.d.ts']);
  });
});

describe('emit map: rootDir, outDir and where they come from (TSM-03)', () => {
  it('default rootDir: TypeScript 6 roots the output tree at the config directory, so sources keep their src segment', async () => {
    const root = await agreeWithCompiler({
      'tsconfig.json': config({ outDir: 'out' }, { include: ['src'] }),
      'src/a/x.ts': 'export {};\n',
      'src/b/y.ts': 'export {};\n',
    });
    assert.deepStrictEqual(root.description.emit.sourceToOutputs('src/a/x.ts'), ['out/src/a/x.js']);
    const nested = await agreeWithCompiler({
      'pkg/tsconfig.json': config({ outDir: 'out' }, { include: ['src'] }),
      'pkg/src/x.ts': 'export {};\n',
    }, 'pkg/tsconfig.json');
    assert.deepStrictEqual(nested.description.emit.sourceToOutputs('pkg/src/x.ts'), ['pkg/out/src/x.js']);
  });

  it('no outDir: the output sits next to its source, and a .js that is its own output is not an output', async () => {
    const { description } = await agreeWithCompiler({
      'tsconfig.json': config({ allowJs: true }, { include: ['src'] }),
      'src/a/x.ts': 'export {};\n',
      'src/b.cts': 'export {};\n',
      'src/c.js': 'module.exports = 1;\n',
    });
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/a/x.ts'), ['src/a/x.js']);
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/b.cts'), ['src/b.cjs']);
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/c.js'), [], 'it would overwrite its own input');
    assert.equal(description.emit.isOutput('src/c.js'), false);
  });

  it('inherited outDir: rootDir and outDir resolve against the config that wrote them, not the config that extends it', async () => {
    const { description } = await agreeWithCompiler({
      'config/base.json': config({ rootDir: '../src', outDir: '../build' }),
      'tsconfig.json': JSON.stringify({ extends: './config/base.json', include: ['src'] }),
      'src/a.ts': 'export {};\n',
    });
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/a.ts'), ['build/a.js']);
    assert.equal(description.emit.outputToSource('build/a.js'), 'src/a.ts');

    const inside = await agreeWithCompiler({
      'config/base.json': config({ outDir: 'dist' }),
      'tsconfig.json': JSON.stringify({ extends: './config/base.json', include: ['src'] }),
      'src/a.ts': 'export {};\n',
    });
    assert.deepStrictEqual(inside.description.emit.sourceToOutputs('src/a.ts'), ['config/dist/src/a.js'], 'dist is config/dist, the directory of the base');
  });

  it('an outDir that leaves the repository drops that config\'s outputs with a diagnostic (T-03-223)', async () => {
    for (const outDir of ['../elsewhere', '/abs/out']) {
      const { emit } = await describeTree({
        'tsconfig.json': config({ rootDir: 'src', outDir }, { include: ['src'] }),
        'src/a.ts': 'export {};\n',
      });
      assert.deepStrictEqual(emit.sourceToOutputs('src/a.ts'), [], outDir);
      assert.deepStrictEqual(emit.diagnostics.map((d) => [d.code, d.subject]), [['emit_outside_repo', 'tsconfig.json']], outDir);
    }
  });

  it('outFile writes one bundle, so no source has a per-file output', async () => {
    const { emit } = await describeTree({
      'tsconfig.json': config({ outFile: 'out/all.js', module: 'amd' }, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
    });
    assert.deepStrictEqual(emit.sourceToOutputs('src/a.ts'), []);
  });
});

describe('emit map: ambiguity and overlap (T-03-221, T-03-222)', () => {
  it('ambiguous output: two sources emitting to one path make the inverse ambiguous, with a diagnostic naming both', async () => {
    const { emit } = await describeTree({
      'tsconfig.json': config(SRC_OUT, { include: ['src'] }),
      'src/a.ts': 'export {};\n',
      'src/a.tsx': 'export {};\n',
      'src/b.ts': 'export {};\n',
    });
    assert.equal(emit.outputToSource('out/a.js'), undefined, 'nothing is guessed');
    assert.equal(emit.isOutput('out/a.js'), true, 'it is still an output, so a tracked file there gets no facts');
    assert.deepStrictEqual(emit.sourceToOutputs('src/a.ts'), ['out/a.js']);
    assert.deepStrictEqual(emit.sourceToOutputs('src/a.tsx'), ['out/a.js']);
    assert.equal(emit.outputToSource('out/b.js'), 'src/b.ts', 'the unambiguous neighbour is unaffected');
    const [only, ...rest] = emit.diagnostics;
    assert.equal(rest.length, 0);
    assert.equal(only?.code, 'emit_ambiguous');
    assert.equal(only?.subject, 'out/a.js');
    assert.match(only?.message ?? '', /src\/a\.ts/);
    assert.match(only?.message ?? '', /src\/a\.tsx/);
  });

  it('ambiguous output across two configs: the same output from two different sources', async () => {
    const description = await describeTree(
      {
        'tsconfig.json': config({ rootDir: 'src', outDir: 'out' }, { include: ['src'] }),
        'tsconfig.other.json': config({ rootDir: 'lib', outDir: 'out' }, { include: ['lib'] }),
        'src/shared.ts': 'export {};\n',
        'lib/shared.ts': 'export {};\n',
      },
      undefined,
      ['tsconfig.other.json'],
    );
    assert.equal(description.configs.length, 2);
    assert.equal(description.emit.outputToSource('out/shared.js'), undefined);
    assert.equal(description.emit.isOutput('out/shared.js'), true);
    assert.deepStrictEqual(description.emit.diagnostics.map((d) => d.code), ['emit_ambiguous']);
  });

  it('the same source reached through two configs is not ambiguous when both put its output in one place', async () => {
    const description = await describeTree(
      {
        'tsconfig.json': config(SRC_OUT, { include: ['src'] }),
        'tsconfig.copy.json': config(SRC_OUT, { include: ['src'] }),
        'src/a.ts': 'export {};\n',
      },
      undefined,
      ['tsconfig.copy.json'],
    );
    assert.equal(description.emit.outputToSource('out/a.js'), 'src/a.ts');
    assert.deepStrictEqual(description.emit.diagnostics, []);
  });

  it('output overlaps source: a path that is a source of one config and an output of another stays a source', async () => {
    const description = await describeTree(
      {
        'tsconfig.json': config({ rootDir: 'src', outDir: 'gen' }, { include: ['src'] }),
        'tsconfig.gen.json': config({ allowJs: true, noEmit: true }, { include: ['gen'] }),
        'src/x.ts': 'export {};\n',
        'gen/x.js': 'module.exports = 1;\n',
      },
      undefined,
      ['tsconfig.gen.json'],
    );
    assert.equal(description.emit.isOutput('gen/x.js'), false, 'never dropped from the index');
    assert.equal(description.emit.outputToSource('gen/x.js'), undefined);
    assert.deepStrictEqual(description.emit.sourceToOutputs('src/x.ts'), ['gen/x.js'], 'the first config still says where it writes');
    assert.deepStrictEqual(description.emit.diagnostics.map((d) => [d.code, d.subject]), [['emit_overlaps_source', 'gen/x.js']]);
  });
});
