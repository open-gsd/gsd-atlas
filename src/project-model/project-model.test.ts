import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type { ReadTextResult } from '../source-tree/index.ts';
import { PROJECT_MODEL_IDS, createTypeScriptProjectModel } from './index.ts';
import type { ProjectDescription, ProjectFs } from './index.ts';

// ---------------------------------------------------------------------------------------------
// Helpers: a fake reader over a map, a temporary tree for the compiler, and the differential.

/** A repository as data: repo-relative path to text. `exists` answers membership. */
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

const FIXTURES = path.join(import.meta.dirname, '__fixtures__');
const fixture = (...segments: string[]): string => fs.readFileSync(path.join(FIXTURES, ...segments), 'utf8');

/** Runs `body` with `tree` written to a fresh temporary directory (real path), then removes it. */
function withTree<T>(tree: Readonly<Record<string, string>>, body: (root: string) => T): T {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pm-')));
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

const compilerHost: ts.ParseConfigHost = { ...ts.sys, useCaseSensitiveFileNames: true };

/** The compiler's own file list for `configRel` in a tree already written to `root` (repo-relative POSIX paths). */
function compilerFileNames(root: string, configRel: string): Set<string> {
  const configPath = path.join(root, ...configRel.split('/'));
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(read.error, undefined, 'the compiler could not read ' + configRel);
  const parsed = ts.parseJsonConfigFileContent(read.config, compilerHost, path.dirname(configPath), undefined, configPath);
  return new Set(parsed.fileNames.map((f) => path.relative(root, f).split(path.sep).join('/')));
}

async function describeTree(tree: Readonly<Record<string, string>>, overlayPaths?: readonly string[]): Promise<ProjectDescription> {
  const f = fakeFs(tree);
  return createTypeScriptProjectModel(f).describe({ overlayPaths: overlayPaths ?? Object.keys(tree), fs: f });
}

/**
 * The differential: for every tree path, the model's `matches` must equal the compiler's membership. Returns the
 * disagreements (empty when equal), as `path: model vs compiler` strings.
 */
async function disagreements(tree: Readonly<Record<string, string>>, configRel: string): Promise<string[]> {
  const description = await describeTree(tree);
  return withTree(tree, (root) => {
    const compiler = compilerFileNames(root, configRel);
    const bad: string[] = [];
    for (const p of Object.keys(tree)) {
      const model = description.matches(configRel, p);
      if (model !== compiler.has(p)) bad.push(`${p}: model ${String(model)} vs compiler ${String(compiler.has(p))}`);
    }
    return bad;
  });
}

// ---------------------------------------------------------------------------------------------
// Task 1: the tracer on a gsd-core-shaped fixture.

const CORE_LIKE_TREE = {
  'tsconfig.json': fixture('core-like', 'tsconfig.json'),
  'tsconfig.build.json': fixture('core-like', 'tsconfig.build.json'),
  'src/a.cts': 'export {};\n',
  'src/sub/b.cts': 'export {};\n',
  'src/a.test.cts': 'export {};\n',
  'src/c.ts': 'export {};\n',
  'out/lib/a.cjs': '"use strict";\n',
  'docs/readme.md': '# docs\n',
} as const;
const CORE_LIKE_PATHS = Object.keys(CORE_LIKE_TREE).filter((p) => !p.endsWith('.json'));

test('the registered project model ids are the built-in ones', () => {
  assert.deepEqual([...PROJECT_MODEL_IDS], ['typescript']);
  assert.equal(createTypeScriptProjectModel(fakeFs({})).id, 'typescript');
});

test('core-like membership: tsconfig.json extends tsconfig.build.json', async () => {
  const description = await describeTree(CORE_LIKE_TREE, CORE_LIKE_PATHS);
  assert.equal(description.configs.length, 1);
  const config = description.configs[0];
  assert.ok(config !== undefined);
  assert.equal(config.path, 'tsconfig.json');
  assert.deepEqual(config.chain, ['tsconfig.json', 'tsconfig.build.json']);
  assert.equal(config.rootDir, 'src');
  assert.equal(config.outDir, 'out/lib');
  assert.deepEqual(config.include, ['src/**/*.cts']);
  assert.deepEqual(config.exclude, ['src/**/*.test.cts']);
  assert.equal(config.allowJs, false);
  assert.deepEqual(config.references, []);
  assert.match(config.hash, /^[0-9a-f]{64}$/);

  assert.equal(description.matches('tsconfig.json', 'src/a.cts'), true);
  assert.equal(description.matches('tsconfig.json', 'src/sub/b.cts'), true);
  assert.equal(description.matches('tsconfig.json', 'src/a.test.cts'), false, 'excluded by the inherited exclude');
  assert.equal(description.matches('tsconfig.json', 'src/c.ts'), false, 'the include names only .cts');
  assert.equal(description.matches('tsconfig.json', 'out/lib/a.cjs'), false);
  assert.equal(description.matches('tsconfig.json', 'docs/readme.md'), false);
  assert.equal(description.matches('tsconfig.build.json', 'src/a.cts'), false, 'a config that was not discovered matches nothing');
  assert.equal(description.ownerOf('src/a.cts'), 'tsconfig.json');
  assert.equal(description.ownerOf('src/c.ts'), undefined);
});

test('differential against the compiler: core-like fixture', async () => {
  assert.deepEqual(await disagreements(CORE_LIKE_TREE, 'tsconfig.json'), []);
});

test('differential against the compiler: the same files with nothing excluded and allowJs', async () => {
  const tree = {
    'tsconfig.json': '{ "compilerOptions": { "allowJs": true, "outDir": "out" } }\n',
    'src/a.ts': '', 'src/a.js': '', 'src/b.js': '', 'src/c.d.ts': '', 'src/c.js': '', 'src/d.tsx': '', 'src/d.jsx': '',
    'src/e.cts': '', 'src/e.cjs': '', 'src/f.mts': '', 'src/f.mjs': '', 'src/g.json': '{}',
    'out/a.js': '', 'node_modules/p/index.ts': '', 'readme.md': '',
  };
  assert.deepEqual(await disagreements(tree, 'tsconfig.json'), []);
});

test('no tsconfig: zero configs, no owners, no throw', async () => {
  const tree = { 'src/a.ts': 'export {};\n', 'src/b.ts': 'export {};\n' };
  const description = await describeTree(tree);
  assert.deepEqual(description.configs, []);
  assert.equal(description.ownerOf('src/a.ts'), undefined);
  assert.equal(description.ownerOf('src/b.ts'), undefined);
  assert.equal(description.matches('tsconfig.json', 'src/a.ts'), false);
  assert.deepEqual(description.diagnostics.filter((d) => d.severity === 'error'), []);
});

test('no typescript import in production files', () => {
  const files = fs.readdirSync(import.meta.dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.ok(files.length > 0, 'expected production files in src/project-model');
  const importsTypeScript = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]typescript(?:-\d+)?(?:\/[^'"]*)?['"]/;
  for (const f of files) {
    const text = fs.readFileSync(path.join(import.meta.dirname, f), 'utf8');
    assert.ok(!importsTypeScript.test(text), `${f} must not import the TypeScript package (TSM-07)`);
  }
});

// ---------------------------------------------------------------------------------------------
// Task 2: extends, include/exclude rules against the compiler, references, owners, JSONC.

const SRC_FILES: Readonly<Record<string, string>> = {
  'src/a.ts': '',
  'src/b.cts': '',
  'src/sub/c.ts': '',
  'src/sub/deep/d.ts': '',
  'src/.hidden.ts': '',
  'src/.dot/e.ts': '',
  'src/node_modules/f.ts': '',
  'src/a.test.ts': '',
  'src/x/y/z.cts': '',
  'src/1.cts': '',
  'src/ab.cts': '',
  'lib/g.ts': '',
  'h.ts': '',
  'node_modules/pkg/i.ts': '',
  'sub/j.ts': '',
  'docs/readme.md': '',
};

/** The disagreements of `config` text over `SRC_FILES` plus the extra files, as one flat list. */
async function diffConfig(config: string, extra: Readonly<Record<string, string>> = {}): Promise<string[]> {
  return disagreements({ ...SRC_FILES, ...extra, 'tsconfig.json': config }, 'tsconfig.json');
}

test('extends array: later entries override earlier ones, the config overrides both', async () => {
  const tree = {
    ...SRC_FILES,
    'base/one.json': '{ "include": ["../src/sub"], "exclude": ["../src/sub/deep"] }',
    'base/two.json': '{ "include": ["../lib", "../src/a.ts"] }',
    'tsconfig.json': '{ "extends": ["./base/one.json", "./base/two.json"] }',
  };
  assert.deepEqual(await disagreements(tree, 'tsconfig.json'), []);
  const description = await describeTree(tree);
  const config = description.configs.find((c) => c.path === 'tsconfig.json');
  assert.deepEqual(config?.chain, ['tsconfig.json', 'base/one.json', 'base/two.json']);
  assert.deepEqual(config?.include, ['lib', 'src/a.ts'], 'the later extends entry replaced the earlier include');
  assert.deepEqual(config?.exclude, ['src/sub/deep'], 'exclude came from the only entry that set it');
  assert.equal(description.matches('tsconfig.json', 'lib/g.ts'), true);
  assert.equal(description.matches('tsconfig.json', 'src/sub/c.ts'), false);

  const own = { ...tree, 'tsconfig.json': '{ "extends": ["./base/one.json", "./base/two.json"], "include": ["sub"] }' };
  assert.deepEqual(await disagreements(own, 'tsconfig.json'), [], 'an include of the config itself wins');
});

test('extends resolves include against the config that wrote it', async () => {
  const tree = {
    ...SRC_FILES,
    'packages/a/src/own.ts': '',
    'packages/a/tsconfig.json': '{ "extends": "../../base/tsconfig.base.json" }',
    'base/tsconfig.base.json': '{ "compilerOptions": { "outDir": "dist" }, "include": ["../src", "../packages/a/src"] }',
  };
  assert.deepEqual(await disagreements(tree, 'packages/a/tsconfig.json'), []);
  const description = await describeTree(tree);
  assert.deepEqual(description.configs.find((c) => c.path === 'packages/a/tsconfig.json')?.include, ['src', 'packages/a/src']);
  assert.equal(description.matches('packages/a/tsconfig.json', 'src/a.ts'), true, 'a spec from the base reaches above the config');
});

test('extends without a .json suffix and with ${configDir} agree with the compiler', async () => {
  const tree = {
    ...SRC_FILES,
    'packages/a/src/own.ts': '',
    'packages/a/src/sub/own2.ts': '',
    'config/shared.json': '{ "include": ["${configDir}/src"], "exclude": ["${configDir}/src/sub"], "compilerOptions": { "outDir": "${configDir}/out" } }',
    'packages/a/tsconfig.json': '{ "extends": "../../config/shared" }',
  };
  assert.deepEqual(await disagreements(tree, 'packages/a/tsconfig.json'), []);
  const description = await describeTree(tree);
  const config = description.configs.find((c) => c.path === 'packages/a/tsconfig.json');
  assert.deepEqual(config?.include, ['packages/a/src']);
  assert.equal(config?.outDir, 'packages/a/out');
  assert.equal(description.matches('packages/a/tsconfig.json', 'packages/a/src/sub/own2.ts'), false);
});

test('extends package: a scoped package resolves through node_modules', async () => {
  const tree = {
    ...SRC_FILES,
    'node_modules/@scope/pkg/tsconfig.json': '{ "compilerOptions": { "allowJs": true }, "include": ["${configDir}/src"] }',
    'node_modules/plain/base.json': '{ "exclude": ["${configDir}/src/sub"] }',
    'tsconfig.json': '{ "extends": ["@scope/pkg/tsconfig.json", "plain/base.json"] }',
    'src/k.js': '',
  };
  assert.deepEqual(await disagreements(tree, 'tsconfig.json'), []);
  const description = await describeTree(tree);
  const config = description.configs.find((c) => c.path === 'tsconfig.json');
  assert.deepEqual(config?.chain, ['tsconfig.json', 'node_modules/@scope/pkg/tsconfig.json', 'node_modules/plain/base.json']);
  assert.equal(config?.allowJs, true);
  assert.equal(description.matches('tsconfig.json', 'src/k.js'), true);

  const bare = await describeTree({ ...tree, 'node_modules/@scope/pkg2/tsconfig.json': '{}', 'tsconfig.json': '{ "extends": "@scope/pkg2" }' });
  assert.deepEqual(bare.configs.find((c) => c.path === 'tsconfig.json')?.chain, ['tsconfig.json', 'node_modules/@scope/pkg2/tsconfig.json']);
});

test('extends outside repo: a climb above the root and a refused link are diagnostics, the rest still loads', async () => {
  const tree = {
    'src/a.ts': '',
    'tsconfig.json': '{ "extends": "../outside/tsconfig.json", "include": ["src"] }',
    'pkg/tsconfig.json': '{ "extends": "../../elsewhere.json", "include": ["x"] }',
    'pkg/x/b.ts': '',
  };
  const description = await describeTree(tree);
  const codes = description.diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`);
  assert.ok(codes.includes('extends_outside_repo:tsconfig.json'), JSON.stringify(codes));
  assert.ok(codes.includes('extends_outside_repo:pkg/tsconfig.json'), JSON.stringify(codes));
  assert.equal(description.matches('tsconfig.json', 'src/a.ts'), true, 'the config still applies its own include');
  assert.equal(description.matches('pkg/tsconfig.json', 'pkg/x/b.ts'), true);

  // A link the reader refuses (it answers `escape`) is treated the same way, and the file is never opened by the model.
  const base = fakeFs({ 'src/a.ts': '', 'tsconfig.json': '{ "extends": "./link/base.json", "include": ["src"] }' });
  const refusing: ProjectFs = {
    async readText(p) {
      return p === 'link/base.json' ? { kind: 'escape' } : base.readText(p);
    },
    exists: base.exists,
  };
  const viaLink = await createTypeScriptProjectModel(refusing).describe({ overlayPaths: ['src/a.ts'], fs: refusing });
  assert.ok(viaLink.diagnostics.some((d) => d.code === 'extends_outside_repo'));
  assert.equal(viaLink.matches('tsconfig.json', 'src/a.ts'), true);
});

test('extends cycle, unresolved and too deep are diagnostics, not throws', async () => {
  const missing = await describeTree({ 'src/a.ts': '', 'tsconfig.json': '{ "extends": "./nope.json", "include": ["src"] }' });
  assert.ok(missing.diagnostics.some((d) => d.code === 'extends_unresolved' && d.subject === 'tsconfig.json'));
  assert.equal(missing.matches('tsconfig.json', 'src/a.ts'), true);

  const cycle = await describeTree({
    'src/a.ts': '',
    'tsconfig.json': '{ "extends": "./b.json", "include": ["src"] }',
    'b.json': '{ "extends": "./tsconfig.json", "exclude": ["nothing"] }',
  });
  assert.ok(cycle.diagnostics.some((d) => d.code === 'extends_cycle'), JSON.stringify(cycle.diagnostics));
  const config = cycle.configs.find((c) => c.path === 'tsconfig.json');
  assert.deepEqual(config?.chain, ['tsconfig.json', 'b.json'], 'the repeated link is ignored once');
  assert.equal(cycle.matches('tsconfig.json', 'src/a.ts'), true);

  const self = await describeTree({ 'src/a.ts': '', 'tsconfig.json': '{ "extends": "./tsconfig.json", "include": ["src"] }' });
  assert.ok(self.diagnostics.some((d) => d.code === 'extends_cycle'));

  const deep: Record<string, string> = { 'src/a.ts': '', 'tsconfig.json': '{ "extends": "./c1.json", "include": ["src"] }' };
  for (let i = 1; i <= 30; i += 1) deep[`c${String(i)}.json`] = `{ "extends": "./c${String(i + 1)}.json" }`;
  deep['c31.json'] = '{}';
  const tooDeep = await describeTree(deep);
  assert.ok(tooDeep.diagnostics.some((d) => d.code === 'extends_too_deep'), JSON.stringify(tooDeep.diagnostics));
  assert.ok((tooDeep.configs.find((c) => c.path === 'tsconfig.json')?.chain.length ?? 99) <= 16, 'the chain is cut at the depth limit');
});

test('include spec table: more than fifteen specs agree with the compiler', async () => {
  const specs = [
    'src', 'src/', 'src/*', 'src/**', 'src/**/*', '**/*.cts', 'src/?.cts', '**/*', '*.ts', 'src/a.ts', './src', 'lib/../src',
    '**/sub/*', 'src/*/c.ts', 'src/**/d.ts', 'src/sub', 'src/s*', '**/node_modules/**/*', 'src/.dot', '.', 'src/**/*.cts', 'src/a?.cts',
  ];
  assert.ok(specs.length >= 15);
  const bad: string[] = [];
  for (const spec of specs) {
    for (const found of await diffConfig(JSON.stringify({ include: [spec] }))) bad.push(`include ${spec}: ${found}`);
  }
  assert.deepEqual(bad, []);
  // A trailing recursive wildcard is invalid in `include`: the compiler drops it and finds nothing.
  const description = await describeTree({ ...SRC_FILES, 'tsconfig.json': '{ "include": ["src/**"] }' });
  assert.equal(description.matches('tsconfig.json', 'src/a.ts'), false);
  assert.ok(description.diagnostics.some((d) => d.code === 'tsconfig_spec_invalid'));
});

test('exclude spec table: a directory name excludes everything under it', async () => {
  const excludes = ['src/sub', 'src/sub/', '**/*.test.ts', 'src/*', 'src/**', 'src/x', 'node_modules', '**/sub', 'src/sub/deep/*', 'src/a.ts', 'src/.dot', '**/*.cts', 'lib', 'src/s*'];
  const bad: string[] = [];
  for (const spec of excludes) {
    for (const found of await diffConfig(JSON.stringify({ exclude: [spec] }))) bad.push(`exclude ${spec}: ${found}`);
    for (const found of await diffConfig(JSON.stringify({ include: ['src', 'lib'], exclude: [spec] }))) bad.push(`include+exclude ${spec}: ${found}`);
  }
  assert.deepEqual(bad, []);
  const description = await describeTree({ ...SRC_FILES, 'tsconfig.json': '{ "exclude": ["src/sub"] }' });
  assert.equal(description.matches('tsconfig.json', 'src/sub/deep/d.ts'), false);
  assert.equal(description.matches('tsconfig.json', 'src/a.ts'), true);
});

test('files: always included, even with an unsupported extension, and not affected by exclude', async () => {
  const config = JSON.stringify({ files: ['src/a.ts', 'docs/readme.md', 'src/sub/c.ts'], exclude: ['src', 'docs'] });
  assert.deepEqual(await diffConfig(config), []);
  const description = await describeTree({ ...SRC_FILES, 'tsconfig.json': config });
  assert.equal(description.matches('tsconfig.json', 'docs/readme.md'), true);
  assert.equal(description.matches('tsconfig.json', 'src/sub/c.ts'), true);
  assert.equal(description.matches('tsconfig.json', 'src/b.cts'), false, 'files alone means no wildcard include');
  const both = JSON.stringify({ files: ['docs/readme.md'], include: ['src/sub'] });
  assert.deepEqual(await diffConfig(both), []);
});

test('outDir excluded only without exclude', async () => {
  const extra = { 'out/gen.ts': '', 'out/deep/gen2.ts': '', 'types/t.d.ts': '' };
  const cases: Record<string, string> = {
    'outDir, no exclude': JSON.stringify({ compilerOptions: { outDir: 'out' } }),
    'outDir and exclude': JSON.stringify({ compilerOptions: { outDir: 'out' }, exclude: ['lib'] }),
    'outDir and empty exclude': JSON.stringify({ compilerOptions: { outDir: 'out' }, exclude: [] }),
    'declarationDir, no exclude': JSON.stringify({ compilerOptions: { declarationDir: 'types' } }),
    'both dirs, no exclude': JSON.stringify({ compilerOptions: { outDir: 'out', declarationDir: 'types' } }),
    'outDir with include': JSON.stringify({ compilerOptions: { outDir: 'out' }, include: ['out', 'src'] }),
  };
  for (const [name, config] of Object.entries(cases)) assert.deepEqual(await diffConfig(config, extra), [], name);

  const withDefault = await describeTree({ ...SRC_FILES, ...extra, 'tsconfig.json': cases['outDir, no exclude'] ?? '' });
  assert.equal(withDefault.matches('tsconfig.json', 'out/gen.ts'), false);
  assert.deepEqual(withDefault.configs[0]?.exclude, ['out']);
  const withExclude = await describeTree({ ...SRC_FILES, ...extra, 'tsconfig.json': cases['outDir and exclude'] ?? '' });
  assert.equal(withExclude.matches('tsconfig.json', 'out/gen.ts'), true);

  // An outDir inherited through extends counts, read against the config that set it (measured against the compiler).
  const inheritedFiles = { ...SRC_FILES, ...extra, 'base/out/gen.ts': '', 'base/types/t.ts': '', 'base/x.ts': '' };
  const inheritedCases: Record<string, Record<string, string>> = {
    'outDir from a base in another directory': { 'base/b.json': '{ "compilerOptions": { "outDir": "out" } }', 'tsconfig.json': '{ "extends": "./base/b.json" }' },
    'declarationDir from a base': { 'base/b.json': '{ "compilerOptions": { "declarationDir": "types" } }', 'tsconfig.json': '{ "extends": "./base/b.json" }' },
    'own outDir overrides the inherited one': { 'base/b.json': '{ "compilerOptions": { "outDir": "out" } }', 'tsconfig.json': '{ "extends": "./base/b.json", "compilerOptions": { "outDir": "types" } }' },
    'inherited exclude beats an inherited outDir': { 'base/b.json': '{ "compilerOptions": { "outDir": "out" } }', 'base/e.json': '{ "exclude": ["x.ts"] }', 'tsconfig.json': '{ "extends": ["./base/b.json", "./base/e.json"] }' },
    'outDir with a configDir template': { 'tsconfig.json': '{ "compilerOptions": { "outDir": "${configDir}/out" } }' },
    'inherited outDir with a configDir template': { 'base/b.json': '{ "compilerOptions": { "outDir": "${configDir}/out" } }', 'tsconfig.json': '{ "extends": "./base/b.json" }' },
  };
  for (const [name, configs] of Object.entries(inheritedCases)) {
    assert.deepEqual(await disagreements({ ...inheritedFiles, ...configs }, 'tsconfig.json'), [], name);
  }
  const fromBase = await describeTree({ ...inheritedFiles, ...inheritedCases['outDir from a base in another directory'] });
  assert.equal(fromBase.matches('tsconfig.json', 'base/out/gen.ts'), false);
  assert.equal(fromBase.matches('tsconfig.json', 'out/gen.ts'), true);
  assert.equal(fromBase.configs.find((c) => c.path === 'tsconfig.json')?.outDir, 'base/out');
});

test('allowJs extensions', async () => {
  const extra = { 'src/k.js': '', 'src/l.jsx': '', 'src/m.cjs': '', 'src/n.mjs': '', 'src/o.d.cts': '', 'src/p.d.mts': '', 'src/q.mts': '', 'src/b.cjs': '', 'src/ab.js': '' };
  assert.deepEqual(await diffConfig(JSON.stringify({ compilerOptions: { allowJs: true } }), extra), []);
  assert.deepEqual(await diffConfig(JSON.stringify({ compilerOptions: { allowJs: false } }), extra), []);
  assert.deepEqual(await diffConfig('{}', extra), []);
  const off = await describeTree({ ...SRC_FILES, ...extra, 'tsconfig.json': '{}' });
  assert.equal(off.matches('tsconfig.json', 'src/k.js'), false);
  assert.equal(off.matches('tsconfig.json', 'src/o.d.cts'), true, '.d.cts is a TypeScript file');
  assert.equal(off.matches('tsconfig.json', 'src/p.d.mts'), true);
  const on = await describeTree({ ...SRC_FILES, ...extra, 'tsconfig.json': '{ "compilerOptions": { "allowJs": true } }' });
  for (const p of ['src/k.js', 'src/l.jsx', 'src/m.cjs', 'src/n.mjs']) assert.equal(on.matches('tsconfig.json', p), true, p);
  assert.equal(on.matches('tsconfig.json', 'src/b.cjs'), false, 'src/b.cts hides src/b.cjs');
  assert.equal(on.matches('tsconfig.json', 'src/ab.js'), true);
  // jsconfig.json defaults allowJs to true, as the compiler does.
  const js = await describeTree({ 'src/k.js': '', 'jsconfig.json': '{}' });
  assert.equal(js.configs[0]?.allowJs, true);
  assert.equal(js.matches('jsconfig.json', 'src/k.js'), true);
});

test('references discovered: a referenced config in a directory with no source of its own', async () => {
  const tree = {
    'src/a.ts': '',
    'tsconfig.json': '{ "files": [], "references": [{ "path": "./packages/core" }, { "path": "./apps/web/tsconfig.app.json" }, { "path": "../outside" }] }',
    'packages/core/tsconfig.json': '{ "include": ["lib"], "references": [{ "path": "../util" }] }',
    'packages/core/lib/c.ts': '',
    'packages/util/tsconfig.json': '{}',
    'packages/util/u.ts': '',
    'apps/web/tsconfig.app.json': '{ "include": ["app"] }',
    'apps/web/app/w.ts': '',
  };
  const description = await describeTree(tree, ['src/a.ts']);
  assert.deepEqual(description.configs.map((c) => c.path), [
    'apps/web/tsconfig.app.json', 'packages/core/tsconfig.json', 'packages/util/tsconfig.json', 'tsconfig.json',
  ]);
  assert.deepEqual(description.configs.find((c) => c.path === 'tsconfig.json')?.references, ['packages/core/tsconfig.json', 'apps/web/tsconfig.app.json']);
  assert.ok(description.diagnostics.some((d) => d.code === 'reference_outside_repo'));
  assert.equal(description.matches('packages/core/tsconfig.json', 'packages/core/lib/c.ts'), true);
});

test('extra configs: a config nothing references can be described on request', async () => {
  const tree = { 'src/a.ts': '', 'tsconfig.json': '{}', 'tsconfig.build.json': '{ "include": ["src"] }', 'notes.txt': '' };
  const f = fakeFs(tree);
  const model = createTypeScriptProjectModel(f);
  const plain = await model.describe({ overlayPaths: ['src/a.ts'], fs: f });
  assert.deepEqual(plain.configs.map((c) => c.path), ['tsconfig.json']);
  const extra = await model.describe({ overlayPaths: ['src/a.ts'], fs: f, extraConfigs: ['tsconfig.build.json', './tsconfig.json', 'missing.json', '../x.json', 'notes.txt'] });
  assert.deepEqual(extra.configs.map((c) => c.path), ['tsconfig.build.json', 'tsconfig.json']);
  assert.equal(extra.matches('tsconfig.build.json', 'src/a.ts'), true);
});

test('references discovered: the cap of 200 configs keeps the first in lexical order', async () => {
  const tree: Record<string, string> = {};
  for (let i = 0; i < 205; i += 1) {
    const dir = `p${String(i).padStart(3, '0')}`;
    tree[`${dir}/tsconfig.json`] = '{}';
    tree[`${dir}/a.ts`] = '';
  }
  const description = await describeTree(tree);
  assert.equal(description.configs.length, 200);
  assert.equal(description.configs[0]?.path, 'p000/tsconfig.json');
  assert.equal(description.configs[199]?.path, 'p199/tsconfig.json');
  assert.ok(description.diagnostics.some((d) => d.code === 'too_many_configs'));
});

test('owner nearest then name then lexical', async () => {
  // Only tsconfig.json and jsconfig.json are found by directory; the other names come in through references.
  const references = ['a/tsconfig.test.json', 'a/tsconfig.build.json', 'b/tsconfig.test.json', 'b/tsconfig.build.json', 'c/tsconfig.spec.json']
    .map((p) => ({ path: `packages/${p}` }));
  const tree = {
    'tsconfig.json': JSON.stringify({ include: ['packages'], references }),
    'packages/a/tsconfig.json': '{ "include": ["src"] }',
    'packages/a/tsconfig.test.json': '{ "include": ["src"] }',
    'packages/a/tsconfig.build.json': '{ "include": ["src"] }',
    'packages/a/src/x.ts': '',
    'packages/b/tsconfig.test.json': '{ "include": ["src"] }',
    'packages/b/tsconfig.build.json': '{ "include": ["src"] }',
    'packages/b/src/y.ts': '',
    'packages/c/tsconfig.json': '{ "include": ["src"] }',
    'packages/c/tsconfig.spec.json': '{ "include": ["src"] }',
    'packages/c/src/z.ts': '',
    'loose.ts': '',
  };
  const description = await describeTree(tree);
  assert.equal(description.ownerOf('packages/a/src/x.ts'), 'packages/a/tsconfig.json', 'nearest directory, then a plain name');
  assert.equal(description.ownerOf('packages/b/src/y.ts'), 'packages/b/tsconfig.build.json', 'no plain name: lexical order, build before test');
  assert.equal(description.ownerOf('packages/c/src/z.ts'), 'packages/c/tsconfig.json');
  assert.equal(description.ownerOf('loose.ts'), undefined, 'a file matched by no config has no owner');
});

test('owner nearest then name then lexical: the pure rule', async () => {
  const { chooseOwner } = await import('./owners.ts');
  assert.equal(chooseOwner('packages/a/src/x.ts', ['tsconfig.json', 'packages/a/tsconfig.json']), 'packages/a/tsconfig.json');
  assert.equal(chooseOwner('packages/a/src/x.ts', ['packages/a/tsconfig.test.json', 'packages/a/tsconfig.build.json']), 'packages/a/tsconfig.build.json');
  assert.equal(chooseOwner('packages/a/src/x.ts', ['packages/a/tsconfig.test.json', 'packages/a/tsconfig.json', 'packages/a/tsconfig.build.json']), 'packages/a/tsconfig.json');
  assert.equal(chooseOwner('packages/a/src/x.ts', ['packages/a/jsconfig.json', 'packages/a/tsconfig.json']), 'packages/a/jsconfig.json', 'same name class: lexical order');
  assert.equal(chooseOwner('packages/a/x.ts', ['packages/a/src/tsconfig.json', 'tsconfig.json']), 'tsconfig.json', 'an ancestor beats a nearer non-ancestor');
  assert.equal(chooseOwner('packages/a/x.ts', ['packages/b/tsconfig.json', 'packages/a/src/tsconfig.json']), 'packages/a/src/tsconfig.json', 'among non-ancestors the one sharing more of the path wins');
  assert.equal(chooseOwner('a.ts', []), undefined);
  // The answer does not depend on the order the configs are listed in.
  const list = ['packages/a/tsconfig.test.json', 'tsconfig.json', 'packages/a/tsconfig.build.json', 'packages/a/tsconfig.json'];
  assert.equal(chooseOwner('packages/a/src/x.ts', list), chooseOwner('packages/a/src/x.ts', [...list].reverse()));
});

test('jsonc comments and trailing commas', async () => {
  const text = '\ufeff// leading comment\n{\n  /* block */ "compilerOptions": { "outDir": "out", }, // trailing\n  "include": ["src", "a//b",], "exclude": [ "src/sub" ],\n}\n';
  const description = await describeTree({ ...SRC_FILES, 'tsconfig.json': text });
  const config = description.configs[0];
  assert.deepEqual(config?.include, ['src', 'a/b'], 'a string containing // is data, not a comment');
  assert.deepEqual(config?.exclude, ['src/sub']);
  assert.equal(config?.outDir, 'out');
  assert.deepEqual(await disagreements({ ...SRC_FILES, 'tsconfig.json': text.replace('"a//b",', '') }, 'tsconfig.json'), []);

  const crlf = await describeTree({ ...SRC_FILES, 'tsconfig.json': text.replace(/\n/g, '\r\n') });
  assert.equal(crlf.configs[0]?.hash, config?.hash, 'CRLF and a BOM do not change the config hash');

  const unclosed = await describeTree({ ...SRC_FILES, 'tsconfig.json': '{ "include": ["src"] } /* never closed' });
  assert.deepEqual(unclosed.configs, [], 'an unclosed comment skips the config');
  assert.ok(unclosed.diagnostics.some((d) => d.code === 'tsconfig_invalid' && d.subject === 'tsconfig.json'));
  const notObject = await describeTree({ ...SRC_FILES, 'tsconfig.json': '[1, 2]' });
  assert.deepEqual(notObject.configs, []);
  assert.ok(notObject.diagnostics.some((d) => d.code === 'tsconfig_invalid'));
  const empty = await describeTree({ ...SRC_FILES, 'tsconfig.json': '' });
  assert.deepEqual(empty.configs, []);
});

test('a hostile config cannot make the model throw', async () => {
  const hostile = [
    '{ "extends": 42, "include": "src", "files": {"a":1}, "exclude": [1, null], "compilerOptions": [], "references": "x" }',
    '{ "extends": [null, "", {}], "compilerOptions": { "outDir": 5, "rootDir": {}, "allowJs": "yes", "jsx": 3 } }',
    '{ "include": ["\\u0000", "[", "(((", "**/**/**", "a/**/../b", "\\\\\\\\x"] }',
    '{ "files": ["/etc/passwd", "C:/x", "../../x"], "include": ["/abs/**", "C:\\\\win"] }',
  ];
  for (const text of hostile) {
    const description = await describeTree({ ...SRC_FILES, 'tsconfig.json': text });
    for (const p of Object.keys(SRC_FILES)) assert.equal(typeof description.matches('tsconfig.json', p), 'boolean');
  }
});

// ---------------------------------------------------------------------------------------------
// Task 3: the resolution context and the compiler decision inside a description.

const sha256 = (text: string): string => createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
const PACKAGE_JSON = 'node_modules/typescript/package.json';
const compilerPackage = (version: string, exportKeys: readonly string[] = []): string =>
  JSON.stringify({ name: 'typescript', version, exports: Object.fromEntries(exportKeys.map((k) => [k, './x.js'])) });

test('context: the id names the compiler identity and configHashes are the sorted sha256 of every chain file', async () => {
  const description = await describeTree(CORE_LIKE_TREE, CORE_LIKE_PATHS);
  assert.equal(description.context.id, 'typescript:6.0.3:bundled');
  assert.deepEqual(description.context.configHashes, [sha256(CORE_LIKE_TREE['tsconfig.json']), sha256(CORE_LIKE_TREE['tsconfig.build.json'])].sort());
  assert.equal(description.compiler.source, 'bundled');
  assert.equal(description.compiler.case, 'none');
  assert.equal(description.compiler.reason, 'no project compiler');
  assert.equal(description.diagnostics.filter((d) => d.code === 'compiler_fallback').length, 1, 'the fallback is reported once per description');
});

test('context: changing a byte of a chain file changes the hashes, and only that one', async () => {
  const before = await describeTree(CORE_LIKE_TREE, CORE_LIKE_PATHS);
  const edited = { ...CORE_LIKE_TREE, 'tsconfig.build.json': CORE_LIKE_TREE['tsconfig.build.json'].replace('out/lib', 'out/lub') };
  const after = await describeTree(edited, CORE_LIKE_PATHS);
  assert.notDeepEqual(after.context.configHashes, before.context.configHashes);
  assert.equal(after.context.id, before.context.id, 'the compiler identity did not change');
  const shared = after.context.configHashes.filter((h) => before.context.configHashes.includes(h));
  assert.deepEqual(shared, [sha256(CORE_LIKE_TREE['tsconfig.json'])], 'the derived config is byte-identical');
  // A change in the extending file alone changes the context too.
  const derived = await describeTree({ ...CORE_LIKE_TREE, 'tsconfig.json': '{ "extends": "./tsconfig.build.json", "compilerOptions": {} }' }, CORE_LIKE_PATHS);
  assert.notDeepEqual(derived.context.configHashes, before.context.configHashes);
});

test('context: a BOM and CRLF do not change the hashes', async () => {
  const before = await describeTree(CORE_LIKE_TREE, CORE_LIKE_PATHS);
  const crlf = { ...CORE_LIKE_TREE, 'tsconfig.build.json': `﻿${CORE_LIKE_TREE['tsconfig.build.json'].replace(/\n/g, '\r\n')}` };
  const after = await describeTree(crlf, CORE_LIKE_PATHS);
  assert.deepEqual(after.context, before.context);
});

test('context: changing the project compiler version changes the id, and a 6.x project compiler is used as is', async () => {
  const withSix = (version: string): Record<string, string> => ({ ...CORE_LIKE_TREE, [PACKAGE_JSON]: compilerPackage(version) });
  const a = await describeTree(withSix('6.0.2'), CORE_LIKE_PATHS);
  const b = await describeTree(withSix('6.0.3'), CORE_LIKE_PATHS);
  assert.equal(a.context.id, 'typescript:6.0.2:project');
  assert.equal(b.context.id, 'typescript:6.0.3:project');
  assert.notEqual(a.context.id, b.context.id);
  assert.deepEqual(a.context.configHashes, b.context.configHashes, 'configs did not change');
  assert.deepEqual(a.compiler, { source: 'project', version: '6.0.2', dir: 'node_modules/typescript', case: 'project-6' });
  assert.equal(a.diagnostics.some((d) => d.code === 'compiler_fallback'), false);
  const bundled = await describeTree(CORE_LIKE_TREE, CORE_LIKE_PATHS);
  assert.notEqual(bundled.context.id, b.context.id, 'the bundled 6.0.3 and a project 6.0.3 are different identities');
});

test('context: a 7.x project compiler selects the bundled one and says which case', async () => {
  const cases: Record<string, readonly string[]> = {
    'project-7-unstable': ['.', './unstable/sync'],
    'project-7-sync': ['.', './sync'],
    'project-7-unknown-layout': ['.', './package.json'],
  };
  for (const [name, keys] of Object.entries(cases)) {
    const description = await describeTree({ ...CORE_LIKE_TREE, [PACKAGE_JSON]: compilerPackage('7.0.2', keys) }, CORE_LIKE_PATHS);
    assert.equal(description.compiler.source, 'bundled', name);
    assert.equal(description.compiler.case, name);
    assert.equal(description.context.id, 'typescript:6.0.3:bundled', name);
    const notes = description.diagnostics.filter((d) => d.code === 'compiler_fallback');
    assert.equal(notes.length, 1, name);
    assert.ok(notes[0]?.message.includes(name), name);
  }
});

test('context: reordering or repeating the overlay paths changes nothing', async () => {
  const a = await describeTree(CORE_LIKE_TREE, CORE_LIKE_PATHS);
  const b = await describeTree(CORE_LIKE_TREE, [...CORE_LIKE_PATHS, ...CORE_LIKE_PATHS].reverse());
  assert.deepEqual(b.context, a.context);
  assert.deepEqual(b.compiler, a.compiler);
  assert.deepEqual(b.configs, a.configs);
  assert.deepEqual(b.diagnostics, a.diagnostics);
});

test('compiler detection starts at the first owner config directory', async () => {
  const tree = {
    'tsconfig.json': '{ "files": [] }',
    'packages/a/tsconfig.json': '{ "include": ["src"] }',
    'packages/a/src/x.ts': '',
    'packages/a/node_modules/typescript/package.json': compilerPackage('6.0.2'),
    [PACKAGE_JSON]: compilerPackage('5.9.2'),
  };
  const description = await describeTree(tree);
  assert.deepEqual(description.compiler, { source: 'project', version: '6.0.2', dir: 'packages/a/node_modules/typescript', case: 'project-6' });
  const rootOnly = await describeTree({ 'tsconfig.json': '{ "files": [] }', 'readme.md': '', [PACKAGE_JSON]: compilerPackage('6.0.1') });
  assert.equal(rootOnly.compiler.version, '6.0.1', 'with nothing owned, the root is used');
  assert.equal(rootOnly.compiler.source, 'project');
});
