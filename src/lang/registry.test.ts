import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { makeTempDir, realPath } from '../test-kit/index.ts';
import { resolveModule, resolveModules } from './index.ts';
import type { ModuleSource, Roots } from './index.ts';

const TOY = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

const temp = makeTempDir();
after(() => {
  temp.cleanup();
});

let counter = 0;

interface World {
  readonly roots: Roots;
  /** Folder a module called `name` occupies in the given source (not created). */
  folder(source: ModuleSource, name: string): string;
  /** Copy the toy module into `source` as `name`; `edit` may change the copy's manifest. */
  place(source: ModuleSource, name: string, edit?: (manifest: Record<string, unknown>) => void): string;
}

/** Four separate temp locations, one per search tier. Every directory comes from makeTempDir. */
function makeWorld(): World {
  counter += 1;
  const base = path.join(temp.path, `world-${String(counter)}`);
  const roots: Roots = {
    repoRoot: path.join(base, 'repo'),
    userDir: path.join(base, 'user'),
    builtinDir: path.join(base, 'builtin'),
    npmRoots: [path.join(base, 'npm')],
  };
  const folder = (source: ModuleSource, name: string): string => {
    switch (source) {
      case 'repo':
        return path.join(roots.repoRoot, '.gsd-atlas', 'languages', name);
      case 'user':
        return path.join(roots.userDir, 'languages', name);
      case 'npm':
        return path.join(roots.npmRoots[0]!, 'node_modules', `gsd-atlas-lang-${name}`);
      case 'builtin':
        return path.join(roots.builtinDir!, name);
    }
  };
  const place = (source: ModuleSource, name: string, edit?: (manifest: Record<string, unknown>) => void): string => {
    const dest = folder(source, name);
    fs.cpSync(TOY, dest, { recursive: true });
    if (edit !== undefined) {
      const manifestPath = path.join(dest, 'atlas-lang.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      edit(manifest);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return dest;
  };
  return { roots, folder, place };
}

const sameDir = (actual: string, expected: string): void => {
  assert.equal(realPath(actual), realPath(expected));
};

describe('resolveModules: four-location precedence (D-03)', () => {
  it('reports repo as active with the user, npm and builtin copies shadowed in that order, then drops one tier at a time', () => {
    const w = makeWorld();
    const dirs = {
      repo: w.place('repo', 'toy'),
      user: w.place('user', 'toy'),
      npm: w.place('npm', 'toy'),
      builtin: w.place('builtin', 'toy'),
    };

    // All four present: repo wins.
    let result = resolveModules(w.roots);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.modules.length, 1);
    let toy = result.modules[0]!;
    assert.equal(toy.name, 'toy');
    assert.equal(toy.source, 'repo');
    sameDir(toy.dir, dirs.repo);
    assert.deepEqual(toy.shadowed.map((s) => s.source), ['user', 'npm', 'builtin']);
    sameDir(toy.shadowed[0]!.dir, dirs.user);
    sameDir(toy.shadowed[1]!.dir, dirs.npm);
    sameDir(toy.shadowed[2]!.dir, dirs.builtin);

    // Repo copy removed: user wins.
    fs.rmSync(dirs.repo, { recursive: true });
    result = resolveModules(w.roots);
    toy = result.modules[0]!;
    assert.equal(toy.source, 'user');
    sameDir(toy.dir, dirs.user);
    assert.deepEqual(toy.shadowed.map((s) => s.source), ['npm', 'builtin']);

    // User copy removed: npm wins.
    fs.rmSync(dirs.user, { recursive: true });
    result = resolveModules(w.roots);
    toy = result.modules[0]!;
    assert.equal(toy.source, 'npm');
    sameDir(toy.dir, dirs.npm);
    assert.deepEqual(toy.shadowed.map((s) => s.source), ['builtin']);

    // npm copy removed: builtin wins, nothing shadowed.
    fs.rmSync(dirs.npm, { recursive: true });
    result = resolveModules(w.roots);
    toy = result.modules[0]!;
    assert.equal(toy.source, 'builtin');
    sameDir(toy.dir, dirs.builtin);
    assert.deepEqual(toy.shadowed, []);

    // Builtin copy removed: toy is absent.
    fs.rmSync(dirs.builtin, { recursive: true });
    result = resolveModules(w.roots);
    assert.deepEqual(result.modules, []);
    assert.deepEqual(result.diagnostics, []);
  });

  it('describes the active module: extensions, version and the active grammar tier', () => {
    const w = makeWorld();
    w.place('user', 'toy');
    const toy = resolveModules(w.roots).modules[0]!;
    assert.deepEqual(toy.extensions, ['.toy']);
    assert.deepEqual(toy.inactiveExtensions, []);
    assert.equal(toy.version, '0.1.0');
    assert.deepEqual(toy.tiers, [{ tier: 'grammar', active: true }]);
  });

  it('finds the npm scoped package name as well as the unscoped one', () => {
    const w = makeWorld();
    const scoped = path.join(w.roots.npmRoots[0]!, 'node_modules', '@opengsd', 'atlas-lang-toy');
    fs.cpSync(TOY, scoped, { recursive: true });
    const toy = resolveModules(w.roots).modules[0]!;
    assert.equal(toy.source, 'npm');
    sameDir(toy.dir, scoped);
  });

  it('lets an unscoped npm package shadow the scoped one in the same npm root', () => {
    const w = makeWorld();
    const unscoped = w.place('npm', 'toy');
    const scoped = path.join(w.roots.npmRoots[0]!, 'node_modules', '@opengsd', 'atlas-lang-toy');
    fs.cpSync(TOY, scoped, { recursive: true });
    const toy = resolveModules(w.roots).modules[0]!;
    sameDir(toy.dir, unscoped);
    assert.deepEqual(toy.shadowed.map((s) => s.source), ['npm']);
    sameDir(toy.shadowed[0]!.dir, scoped);
  });

  it('searches every npm root in the given order', () => {
    const w = makeWorld();
    const second = path.join(temp.path, `second-npm-${String(counter)}`);
    const roots: Roots = { ...w.roots, npmRoots: [...w.roots.npmRoots, second] };
    const first = w.place('npm', 'toy');
    const other = path.join(second, 'node_modules', 'gsd-atlas-lang-toy');
    fs.cpSync(TOY, other, { recursive: true });
    const toy = resolveModules(roots).modules[0]!;
    sameDir(toy.dir, first);
    sameDir(toy.shadowed[0]!.dir, other);
  });

  it('treats a missing search directory as an empty tier, and a null builtin dir as none', () => {
    const w = makeWorld();
    const result = resolveModules({ ...w.roots, builtinDir: null });
    assert.deepEqual(result, { modules: [], diagnostics: [] });
  });

  it('lists several modules sorted by name', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    w.place('user', 'alpha', (m) => {
      m['name'] = 'alpha';
    });
    const names = resolveModules(w.roots).modules.map((m) => m.name);
    assert.deepEqual(names, ['alpha', 'toy']);
  });

  it('skips a stray file in a languages folder without a diagnostic', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    fs.writeFileSync(path.join(w.roots.repoRoot, '.gsd-atlas', 'languages', 'README.md'), 'not a module');
    const result = resolveModules(w.roots);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.modules.map((m) => m.name), ['toy']);
  });
});

describe('resolveModules: an invalid module is skipped, never a crash', () => {
  it('skips a repo copy with an invalid manifest (manifest_invalid) and falls through to the valid user copy', () => {
    const w = makeWorld();
    const bad = w.place('repo', 'toy');
    fs.writeFileSync(path.join(bad, 'atlas-lang.json'), '{}');
    const good = w.place('user', 'toy');

    const result = resolveModules(w.roots);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.every((d) => d.code === 'manifest_invalid' && d.severity === 'warning'));
    assert.ok(
      result.diagnostics.every((d) => d.message.includes(realPath(bad))),
      'each diagnostic names the skipped folder',
    );
    const toy = result.modules[0]!;
    assert.equal(toy.source, 'user');
    sameDir(toy.dir, good);
    assert.deepEqual(toy.shadowed, []);
  });

  it('skips a manifest that is not JSON', () => {
    const w = makeWorld();
    const bad = w.place('repo', 'toy');
    fs.writeFileSync(path.join(bad, 'atlas-lang.json'), '{ nope');
    const result = resolveModules(w.roots);
    assert.deepEqual(result.modules, []);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['manifest_invalid']);
  });
});

describe('resolveModule', () => {
  it('returns the same entry resolveModules lists, found by name', () => {
    const w = makeWorld();
    w.place('npm', 'toy');
    w.place('builtin', 'toy');
    const found = resolveModule(w.roots, 'toy');
    assert.deepEqual(found.entry, resolveModules(w.roots).modules[0]);
    assert.deepEqual(found.diagnostics, []);
  });

  it('returns no entry for an unknown name, and for a name that is not a module id', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    for (const name of ['nosuch', '..', '', 'a/b', 'Toy']) {
      const found = resolveModule(w.roots, name);
      assert.equal(found.entry, undefined, name);
    }
  });

  it('reports the skipped invalid copy of that module only', () => {
    const w = makeWorld();
    fs.writeFileSync(path.join(w.place('repo', 'toy'), 'atlas-lang.json'), '{}');
    fs.writeFileSync(path.join(w.place('repo', 'other', (m) => {
      m['name'] = 'other';
    }), 'atlas-lang.json'), '{}');
    w.place('user', 'toy');
    const found = resolveModule(w.roots, 'toy');
    assert.equal(found.entry?.source, 'user');
    assert.ok(found.diagnostics.length > 0);
    assert.ok(found.diagnostics.every((d) => d.message.includes(`${path.sep}toy`)));
  });
});

describe('the registry reads only the roots it is given', () => {
  it('does not reference os.homedir or process.cwd', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'registry.ts'), 'utf8');
    assert.ok(!source.includes('homedir'), 'registry.ts must not read the home directory');
    assert.ok(!source.includes('process.cwd'), 'registry.ts must not read the working directory');
    assert.ok(!source.includes('child_process'), 'registry.ts must not start processes');
  });
});
