import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CommandRunner } from '../command-runner/index.ts';
import type { ReadTextResult } from '../source-tree/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import { BUNDLED_VERSION, compilerFallbackDiagnostic, detectTypeScriptInstall, selectCompiler } from './index.ts';
import type { ProjectFs } from './index.ts';

// Detection reads package.json as data. Nothing here starts a process, runs a worker or loads a compiler.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const readPackageJson = (name: string): string => fs.readFileSync(path.join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8');

/** A fake reader over a map; `reads` records every path asked for, in order. */
function fakeFs(tree: Readonly<Record<string, string>>): { readonly fs: ProjectFs; readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fs: {
      async readText(p: string): Promise<ReadTextResult> {
        reads.push(p);
        const text = tree[p];
        return text === undefined ? { kind: 'missing' } : { kind: 'ok', text };
      },
      async exists(paths) {
        return new Set(paths.filter((p) => tree[p] !== undefined));
      },
    },
  };
}

const ROOT_PACKAGE = 'node_modules/typescript/package.json';

const SYNC_LAYOUT = JSON.stringify({
  name: 'typescript',
  version: '7.1.0-dev.20261017.1',
  exports: { '.': './lib/version.cjs', './package.json': './package.json', './sync': './dist/api/sync/api.js', './async': './dist/api/async/api.js', './ast': './dist/ast/index.js' },
});
const BARE_LAYOUT = JSON.stringify({ name: 'typescript', version: '7.2.0', exports: { '.': './lib/version.cjs', './package.json': './package.json' } });
const SIX = JSON.stringify({ name: 'typescript', version: '6.0.2', main: './lib/typescript.js' });
const FIVE = JSON.stringify({ name: 'typescript', version: '5.9.2', main: './lib/typescript.js' });

test('project-6: the repository own 6.0.3 package.json is used as is', async () => {
  const { fs: reader } = fakeFs({ [ROOT_PACKAGE]: readPackageJson('typescript') });
  const install = await detectTypeScriptInstall(reader, '');
  assert.equal(install.case, 'project-6');
  assert.equal(install.version, '6.0.3');
  assert.equal(install.dir, 'node_modules/typescript');
  assert.deepEqual(install.diagnostics, []);
  const choice = selectCompiler(install);
  assert.deepEqual(choice, { source: 'project', version: '6.0.3', dir: 'node_modules/typescript', case: 'project-6' });
  assert.equal(compilerFallbackDiagnostic(choice), undefined, 'a project compiler is no fallback');
});

test('project-7-unstable with the real alias: the typescript-7 package.json copied into node_modules', async () => {
  const text = readPackageJson('typescript-7');
  assert.match(text, /"\.\/unstable\/sync"/, 'the alias must expose the unstable subpath');
  const { fs: reader } = fakeFs({ [ROOT_PACKAGE]: text });
  const install = await detectTypeScriptInstall(reader, '');
  assert.equal(install.case, 'project-7-unstable');
  assert.equal(install.version, '7.0.2');
  assert.ok(install.exportKeys.includes('./unstable/sync'));
  const choice = selectCompiler(install);
  assert.deepEqual(choice, { source: 'bundled', version: BUNDLED_VERSION, reason: 'project compiler is 7.x with the unstable layout', case: 'project-7-unstable' });
  const note = compilerFallbackDiagnostic(choice);
  assert.equal(note?.code, 'compiler_fallback');
  assert.ok(note?.message.includes('project-7-unstable'), 'the message names the case');
  assert.ok(!note?.message.includes('7.0.2'), 'the message carries no text from the repository');
  assert.equal(note?.subject, undefined);
});

test('project-7-sync fixture: a 7.1-style ./sync layout', async () => {
  const install = await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: SYNC_LAYOUT }).fs, '');
  assert.equal(install.case, 'project-7-sync');
  assert.deepEqual(selectCompiler(install), { source: 'bundled', version: '6.0.3', reason: 'project compiler is 7.x with the sync layout', case: 'project-7-sync' });
});

test('project-7-unknown-layout fixture: neither subpath', async () => {
  const install = await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: BARE_LAYOUT }).fs, '');
  assert.equal(install.case, 'project-7-unknown-layout');
  assert.deepEqual(selectCompiler(install), { source: 'bundled', version: '6.0.3', reason: 'project compiler is 7.x with an unknown layout', case: 'project-7-unknown-layout' });
  const noExports = await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: JSON.stringify({ version: '7.0.0' }) }).fs, '');
  assert.equal(noExports.case, 'project-7-unknown-layout', 'a 7.x package with no exports at all');
  assert.deepEqual(noExports.exportKeys, []);
});

test('project-7: the unstable subpath wins when both are present', async () => {
  const both = JSON.stringify({ version: '7.1.0', exports: { './sync': './a.js', './unstable/sync': './b.js' } });
  assert.equal((await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: both }).fs, '')).case, 'project-7-unstable');
});

test('project-other: another major falls back to the bundled compiler', async () => {
  const install = await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: FIVE }).fs, '');
  assert.equal(install.case, 'project-other');
  assert.equal(install.version, '5.9.2');
  assert.deepEqual(selectCompiler(install), { source: 'bundled', version: '6.0.3', reason: 'project compiler is not 6.x', case: 'project-other' });
  const eight = await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: JSON.stringify({ version: '8.0.0-beta' }) }).fs, '');
  assert.equal(eight.case, 'project-other');
});

test('none: no package, and an unusable package.json is none with a diagnostic', async () => {
  const absent = await detectTypeScriptInstall(fakeFs({}).fs, 'packages/a');
  assert.equal(absent.case, 'none');
  assert.deepEqual(absent.diagnostics, []);
  assert.deepEqual(selectCompiler(absent), { source: 'bundled', version: '6.0.3', reason: 'no project compiler', case: 'none' });

  const hostile = [
    '{ not json',
    '[]',
    '"6.0.3"',
    JSON.stringify({ name: 'typescript' }),
    JSON.stringify({ version: 6 }),
    JSON.stringify({ version: '6.0.3; rm -rf /' }),
    JSON.stringify({ version: '6.0' }),
    JSON.stringify({ version: '9'.repeat(7) + '.0.0' }),
  ];
  for (const text of hostile) {
    const install = await detectTypeScriptInstall(fakeFs({ [ROOT_PACKAGE]: text }).fs, '');
    assert.equal(install.case, 'none', text);
    assert.deepEqual(install.diagnostics.map((d) => d.code), ['typescript_package_invalid'], text);
    assert.equal(install.diagnostics[0]?.subject, ROOT_PACKAGE);
  }
  const notFile: ProjectFs = { async readText() { return { kind: 'not_file' }; }, async exists() { return new Set(); } };
  assert.deepEqual((await detectTypeScriptInstall(notFile, '')).diagnostics.map((d) => d.code), ['typescript_package_invalid']);
});

test('walk order: the nearest node_modules wins, then each parent up to the root', async () => {
  const { fs: reader, reads } = fakeFs({ [ROOT_PACKAGE]: SIX, 'packages/node_modules/typescript/package.json': FIVE });
  const install = await detectTypeScriptInstall(reader, 'packages/a');
  assert.deepEqual(reads, ['packages/a/node_modules/typescript/package.json', 'packages/node_modules/typescript/package.json']);
  assert.equal(install.case, 'project-other', 'packages/node_modules is nearer than the root one');
  assert.equal(install.dir, 'packages/node_modules/typescript');

  const rootOnly = fakeFs({ [ROOT_PACKAGE]: SIX });
  assert.equal((await detectTypeScriptInstall(rootOnly.fs, 'packages/a/b')).case, 'project-6');
  assert.deepEqual(rootOnly.reads, [
    'packages/a/b/node_modules/typescript/package.json',
    'packages/a/node_modules/typescript/package.json',
    'packages/node_modules/typescript/package.json',
    ROOT_PACKAGE,
  ]);
  const own = fakeFs({ 'packages/a/node_modules/typescript/package.json': SIX, [ROOT_PACKAGE]: FIVE });
  assert.equal((await detectTypeScriptInstall(own.fs, 'packages/a')).case, 'project-6');
  assert.deepEqual(own.reads, ['packages/a/node_modules/typescript/package.json'], 'it stops at the first package');
});

// ---------------------------------------------------------------------------------------------
// Links, through the real confined reader.

const unusedRunner = { run: () => Promise.reject(new Error('the reader never starts a process')) } as unknown as CommandRunner;

async function withRepos<T>(body: (repo: string, outside: string) => Promise<T>): Promise<T> {
  const holder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-inst-')));
  const repo = path.join(holder, 'repo');
  const outside = path.join(holder, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  try {
    return await body(repo, outside);
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
}

function realFs(repo: string): ProjectFs {
  const tree = createSourceTree({ runner: unusedRunner, repoDir: repo });
  return {
    readText: (p) => tree.readText(repo, p),
    async exists(paths) {
      return new Set(paths.filter((p) => fs.existsSync(path.join(repo, ...p.split('/')))));
    },
  };
}

/** A directory link, or undefined when the platform will not make one (Windows without the privilege). */
function tryLink(target: string, at: string): boolean {
  try {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, 'junction');
    return true;
  } catch {
    return false;
  }
}

test('symlink inside repo: a pnpm-style link to a directory in the repository is read', async (t) => {
  await withRepos(async (repo) => {
    fs.mkdirSync(path.join(repo, '.pnpm', 'typescript@6.0.2', 'node_modules', 'typescript'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.pnpm', 'typescript@6.0.2', 'node_modules', 'typescript', 'package.json'), SIX);
    if (!tryLink(path.join(repo, '.pnpm', 'typescript@6.0.2', 'node_modules', 'typescript'), path.join(repo, 'node_modules', 'typescript'))) {
      t.skip('this platform could not create a directory link');
      return;
    }
    const install = await detectTypeScriptInstall(realFs(repo), '');
    assert.equal(install.case, 'project-6');
    assert.equal(install.version, '6.0.2');
    assert.deepEqual(install.diagnostics, []);
  });
});

test('symlink outside repo: a link that leaves the repository is reported and treated as none', async (t) => {
  await withRepos(async (repo, outside) => {
    fs.writeFileSync(path.join(outside, 'package.json'), SIX);
    if (!tryLink(outside, path.join(repo, 'node_modules', 'typescript'))) {
      t.skip('this platform could not create a directory link');
      return;
    }
    const install = await detectTypeScriptInstall(realFs(repo), '');
    assert.equal(install.case, 'none');
    assert.deepEqual(install.diagnostics.map((d) => d.code), ['compiler_outside_repo']);
    assert.equal(install.diagnostics[0]?.subject, ROOT_PACKAGE);
    assert.equal(selectCompiler(install).source, 'bundled');
  });
});

test('no compiler loaded: detection reads data only and no typescript module is in the module graph', () => {
  const production = fs.readdirSync(import.meta.dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const loads = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:node:)?(?:typescript(?:-\d+)?|child_process|worker_threads|vm)(?:\/[^'"]*)?['"]/;
  for (const f of production) {
    assert.ok(!loads.test(fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')), `${f} must not import a compiler, a process or a worker`);
  }
  const install = fs.readFileSync(path.join(import.meta.dirname, 'install.ts'), 'utf8');
  assert.ok(/\breadText\b/.test(install), 'detection goes through ProjectFs.readText');
  assert.ok(!/\b(?:readFileSync|readFile|statSync|existsSync|realpath)\b/.test(install), 'detection does not touch the file system by itself');
  const cached = Object.keys(createRequire(import.meta.url).cache).filter((k) => /[\\/]node_modules[\\/]typescript(?:-\d+)?[\\/]/.test(k));
  assert.deepEqual(cached, [], 'no typescript module was loaded into this process');
});
