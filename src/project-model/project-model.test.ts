import assert from 'node:assert/strict';
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
