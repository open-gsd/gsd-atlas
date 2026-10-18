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

describe('resolveModules: module health checks', () => {
  it('skips a folder whose manifest name differs from the folder (name_mismatch) and uses the valid user copy', () => {
    const w = makeWorld();
    const wrong = w.place('repo', 'toy', (m) => {
      m['name'] = 'other';
    });
    const good = w.place('user', 'toy');
    const result = resolveModules(w.roots);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['name_mismatch']);
    assert.equal(result.diagnostics[0]!.severity, 'warning');
    assert.ok(result.diagnostics[0]!.message.includes(realPath(wrong)));
    assert.deepEqual(result.modules.map((m) => [m.name, m.source]), [['toy', 'user']]);
    sameDir(result.modules[0]!.dir, good);
    assert.deepEqual(result.modules[0]!.shadowed, []);
  });

  it('applies name_mismatch to npm packages by their package-name suffix', () => {
    const w = makeWorld();
    w.place('npm', 'toy', (m) => {
      m['name'] = 'other';
    });
    const result = resolveModules(w.roots);
    assert.deepEqual(result.modules, []);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['name_mismatch']);
  });

  it('skips a module whose tiers lack grammar (grammar_tier_missing) and falls through to the next tier', () => {
    const w = makeWorld();
    w.place('repo', 'toy', (m) => {
      m['tiers'] = ['platform'];
    });
    w.place('builtin', 'toy');
    const result = resolveModules(w.roots);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['grammar_tier_missing']);
    assert.deepEqual(result.modules.map((m) => [m.name, m.source]), [['toy', 'builtin']]);
  });

  it('skips a folder whose manifest is a directory (manifest_unreadable) and falls through', () => {
    const w = makeWorld();
    const broken = w.place('repo', 'toy');
    fs.rmSync(path.join(broken, 'atlas-lang.json'));
    fs.mkdirSync(path.join(broken, 'atlas-lang.json'));
    w.place('user', 'toy');
    const result = resolveModules(w.roots);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['manifest_unreadable']);
    assert.deepEqual(result.modules.map((m) => m.source), ['user']);
  });

  it('skips a languages folder without any manifest (manifest_unreadable) instead of crashing', () => {
    const w = makeWorld();
    fs.mkdirSync(w.folder('repo', 'empty'), { recursive: true });
    const result = resolveModules(w.roots);
    assert.deepEqual(result.modules, []);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['manifest_unreadable']);
  });
});

describe('resolveModules: extension collisions', () => {
  const toy2 = (m: Record<string, unknown>): void => {
    m['name'] = 'toy2';
  };

  it('reports extension_collision as an error naming both modules and marks the lower one inactive for the extension', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    w.place('user', 'toy2', toy2);
    const result = resolveModules(w.roots);
    const collisions = result.diagnostics.filter((d) => d.code === 'extension_collision');
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0]!.severity, 'error');
    assert.ok(collisions[0]!.message.includes('toy (repo') && collisions[0]!.message.includes('toy2 (user'));
    assert.ok(collisions[0]!.message.includes('.toy'));
    const [first, second] = result.modules;
    assert.equal(first!.name, 'toy');
    assert.deepEqual(first!.inactiveExtensions, []);
    assert.equal(second!.name, 'toy2');
    assert.deepEqual(second!.extensions, ['.toy']);
    assert.deepEqual(second!.inactiveExtensions, ['.toy']);
  });

  it('lets the higher-precedence module win silently when it declares replace, with an info note', () => {
    const w = makeWorld();
    w.place('repo', 'toy2', (m) => {
      toy2(m);
      m['replace'] = true;
    });
    w.place('user', 'toy');
    const result = resolveModules(w.roots);
    assert.ok(!result.diagnostics.some((d) => d.code === 'extension_collision'));
    const note = result.diagnostics.find((d) => d.code === 'extension_replaced');
    assert.equal(note?.severity, 'info');
    const byName = Object.fromEntries(result.modules.map((m) => [m.name, m]));
    assert.deepEqual(byName['toy2']!.inactiveExtensions, []);
    assert.deepEqual(byName['toy']!.inactiveExtensions, ['.toy']);
  });

  it('does not let a lower-precedence module take an extension by declaring replace', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    w.place('user', 'toy2', (m) => {
      toy2(m);
      m['replace'] = true;
    });
    const result = resolveModules(w.roots);
    assert.ok(result.diagnostics.some((d) => d.code === 'extension_collision'));
    assert.deepEqual(result.modules.find((m) => m.name === 'toy2')!.inactiveExtensions, ['.toy']);
  });

  it('breaks a tie inside one source by module name, and compares extensions without case', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    w.place('repo', 'toy2', (m) => {
      toy2(m);
      m['extensions'] = ['.TOY', '.t2'];
    });
    const result = resolveModules(w.roots);
    const second = result.modules.find((m) => m.name === 'toy2')!;
    assert.deepEqual(second.inactiveExtensions, ['.TOY']);
    assert.deepEqual(second.extensions, ['.TOY', '.t2']);
    assert.deepEqual(result.modules.find((m) => m.name === 'toy')!.inactiveExtensions, []);
  });

  it('does not report a collision between a module and its own shadowed copy', () => {
    const w = makeWorld();
    w.place('repo', 'toy');
    w.place('user', 'toy');
    const result = resolveModules(w.roots);
    assert.deepEqual(result.diagnostics, []);
  });
});

describe('resolveModules: a precise command or adapter is data, never run (T-01-36)', () => {
  const ALL_TIERS = ['grammar', 'precise', 'platform'];

  it('reports a precise.command as command_not_approved and never executes it (marker file stays absent)', () => {
    const w = makeWorld();
    const marker = path.join(temp.path, `marker-${String(counter)}.txt`);
    w.place('repo', 'toy', (m) => {
      m['tiers'] = ALL_TIERS;
      m['precise'] = { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] };
    });
    const result = resolveModules(w.roots);
    const found = resolveModule(w.roots, 'toy');
    assert.equal(fs.existsSync(marker), false, 'the manifest command must never run');
    for (const toy of [result.modules[0]!, found.entry!]) {
      assert.deepEqual(toy.tiers, [
        { tier: 'grammar', active: true },
        { tier: 'precise', active: false, reason: 'command_not_approved' },
        { tier: 'platform', active: false, reason: 'no_sdk_provider' },
      ]);
    }
    for (const diagnostics of [result.diagnostics, found.diagnostics]) {
      assert.deepEqual(diagnostics.map((d) => [d.code, d.severity]), [['precise_command_inactive', 'info']]);
    }
  });

  it('reports a precise.adapter as adapter_not_available', () => {
    const w = makeWorld();
    w.place('repo', 'toy', (m) => {
      m['tiers'] = ['grammar', 'precise'];
      m['precise'] = { adapter: 'toy-adapter' };
    });
    const toy = resolveModules(w.roots).modules[0]!;
    assert.deepEqual(toy.tiers, [
      { tier: 'grammar', active: true },
      { tier: 'precise', active: false, reason: 'adapter_not_available' },
    ]);
  });

  it('reports a precise tier with nothing declared as precise_not_declared, without a note', () => {
    const w = makeWorld();
    w.place('repo', 'toy', (m) => {
      m['tiers'] = ['grammar', 'precise'];
    });
    const result = resolveModules(w.roots);
    assert.deepEqual(result.modules[0]!.tiers[1], { tier: 'precise', active: false, reason: 'precise_not_declared' });
    assert.deepEqual(result.diagnostics, []);
  });

  it('secret marker: the reason text for an unapproved precise command is fixed, names gsd-atlas allow and holds no manifest text', () => {
    const w = makeWorld();
    const marker = 'SECRET-MARKER';
    w.place('repo', 'toy', (m) => {
      m['tiers'] = ALL_TIERS;
      m['precise'] = { command: ['not-a-real-program', `--token=${marker}`, `/etc/${marker}`] };
    });
    const result = resolveModules(w.roots);
    const found = resolveModule(w.roots, 'toy');
    for (const seen of [JSON.stringify(result), JSON.stringify(found)]) {
      assert.ok(!seen.includes(marker), 'no part of the manifest command reaches a reason or a diagnostic');
      assert.ok(!seen.includes('not-a-real-program'), 'not even the executable');
    }
    const note = result.diagnostics.find((d) => d.code === 'precise_command_inactive');
    assert.match(note?.message ?? '', /gsd-atlas allow/, 'the diagnostic says how to approve');
    assert.match(note?.message ?? '', /user-level config approves it/, 'and still says why the tier is inactive');
    // The same sentence for two modules whose commands differ: it is fixed text, not built from the command.
    const second = makeWorld();
    second.place('repo', 'toy', (m) => {
      m['tiers'] = ALL_TIERS;
      m['precise'] = { command: ['another-program', 'a', 'b', 'c'] };
    });
    const other = resolveModules(second.roots).diagnostics.find((d) => d.code === 'precise_command_inactive');
    assert.equal(other?.message, note?.message);
  });

  it('keeps a module with a precise command usable: it is still listed and its grammar tier is active', () => {
    const w = makeWorld();
    w.place('user', 'toy', (m) => {
      m['precise'] = { command: ['definitely-not-a-real-program'] };
    });
    const toy = resolveModules(w.roots).modules[0]!;
    assert.equal(toy.source, 'user');
    assert.deepEqual(toy.tiers, [
      { tier: 'grammar', active: true },
      { tier: 'precise', active: false, reason: 'command_not_approved' },
    ]);
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
