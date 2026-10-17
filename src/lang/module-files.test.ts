import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { readModuleFile, readModuleInputs } from './module-files.ts';
import type { ReadModuleInputsResult } from './module-files.ts';

const toyDir = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

const temps: TempDir[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) {
    temp.cleanup();
  }
});

/** A fresh copy of the toy module inside a temp folder that also has a sibling for escape tests. */
function copyToy(): { root: string; moduleDir: string } {
  const temp = makeTempDir();
  temps.push(temp);
  const moduleDir = path.join(temp.path, 'toy');
  fs.cpSync(toyDir, moduleDir, { recursive: true });
  return { root: temp.path, moduleDir };
}

function failure(result: ReadModuleInputsResult) {
  assert.equal(result.ok, false, 'expected the read to fail');
  if (result.ok) {
    throw new Error('unreachable');
  }
  return result.diagnostics;
}

function codes(result: ReadModuleInputsResult): string[] {
  return failure(result).map((d) => d.code);
}

/** Create a symlink, or report that the OS refuses (Windows without developer mode). */
function trySymlink(target: string, linkPath: string, type: 'file' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, linkPath, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
    return true;
  } catch {
    return false;
  }
}

describe('readModuleInputs: the toy module', () => {
  it('returns the manifest, the lock and a GrammarInput whose hash equals the lock', () => {
    const result = readModuleInputs(toyDir);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.manifest.name, 'toy');
    assert.equal(result.lock.name, 'atlas_toy');
    assert.equal(result.input.name, 'atlas_toy');
    assert.equal(result.input.expectedSha256, result.lock.wasm.sha256);
    assert.equal(createHash('sha256').update(result.input.wasm).digest('hex'), result.lock.wasm.sha256);
    assert.deepEqual(Object.keys(result.input.queries).sort(), ['imports', 'refs', 'tags']);
    assert.match(result.input.queries.tags ?? '', /definition\.function/);
  });
});

describe('readModuleInputs: confinement', () => {
  it('rejects a wasm symlink that resolves outside the module folder with path_escape', (t: TestContext) => {
    const { root, moduleDir } = copyToy();
    const outside = path.join(root, 'outside.wasm');
    fs.copyFileSync(path.join(toyDir, 'grammar.wasm'), outside);
    fs.rmSync(path.join(moduleDir, 'grammar.wasm'));
    if (!trySymlink(outside, path.join(moduleDir, 'grammar.wasm'), 'file')) {
      t.skip('this OS refused to create a symlink');
      return;
    }
    const diagnostics = failure(readModuleInputs(moduleDir));
    assert.deepEqual(diagnostics.map((d) => d.code), ['path_escape']);
    assert.equal(diagnostics[0]?.subject, 'grammar.wasm');
  });

  it('rejects a manifest that is a symlink to a file outside the folder with path_escape', (t: TestContext) => {
    const { root, moduleDir } = copyToy();
    const outside = path.join(root, 'outside.json');
    fs.copyFileSync(path.join(toyDir, 'atlas-lang.json'), outside);
    fs.rmSync(path.join(moduleDir, 'atlas-lang.json'));
    if (!trySymlink(outside, path.join(moduleDir, 'atlas-lang.json'), 'file')) {
      t.skip('this OS refused to create a symlink');
      return;
    }
    assert.deepEqual(codes(readModuleInputs(moduleDir)), ['path_escape']);
  });

  it('rejects a query reached through a directory link to a sibling whose name shares the folder prefix', (t: TestContext) => {
    const { root, moduleDir } = copyToy();
    // "<root>/toy-evil" starts with the string "<root>/toy": a raw prefix check would wrongly accept it.
    const evil = path.join(root, 'toy-evil');
    fs.mkdirSync(evil);
    fs.copyFileSync(path.join(toyDir, 'queries', 'tags.scm'), path.join(evil, 'tags.scm'));
    fs.rmSync(path.join(moduleDir, 'queries'), { recursive: true });
    if (!trySymlink(evil, path.join(moduleDir, 'queries'), 'dir')) {
      t.skip('this OS refused to create a symlink');
      return;
    }
    assert.ok(codes(readModuleInputs(moduleDir)).includes('path_escape'));
  });

  it('accepts a symlink whose target is still inside the module folder', (t: TestContext) => {
    const { moduleDir } = copyToy();
    fs.mkdirSync(path.join(moduleDir, 'assets'));
    fs.renameSync(path.join(moduleDir, 'grammar.wasm'), path.join(moduleDir, 'assets', 'real.wasm'));
    if (!trySymlink(path.join(moduleDir, 'assets', 'real.wasm'), path.join(moduleDir, 'grammar.wasm'), 'file')) {
      t.skip('this OS refused to create a symlink');
      return;
    }
    assert.equal(readModuleInputs(moduleDir).ok, true);
  });

  // The containment test is the shared `isInside` (IN-03, plan 02-44). These cases pin the behaviour across the
  // replacement of the private copy; they pass before and after.
  it('dot-dot directory name: a directory called ..assets inside the folder is a child, not a parent', () => {
    const { moduleDir } = copyToy();
    fs.mkdirSync(path.join(moduleDir, '..assets'));
    fs.writeFileSync(path.join(moduleDir, '..assets', 'sample.toy'), 'fn main {\n}\n');
    const read = readModuleFile(moduleDir, path.join('..assets', 'sample.toy'), 'fixture');
    assert.equal(read.ok, true, JSON.stringify(read));
    if (read.ok) assert.equal(read.bytes.toString('utf8'), 'fn main {\n}\n');
  });

  it('a link inside the folder that points out of it is path_escape, and so is the folder itself', (t: TestContext) => {
    const { root, moduleDir } = copyToy();
    const outside = path.join(root, 'outside.toy');
    fs.writeFileSync(outside, 'fn leak {\n}\n');
    if (!trySymlink(outside, path.join(moduleDir, 'leak.toy'), 'file')) {
      t.skip('this OS refused to create a symlink');
      return;
    }
    const leaked = readModuleFile(moduleDir, 'leak.toy', 'fixture');
    assert.equal(leaked.ok, false);
    if (!leaked.ok) assert.equal(leaked.diagnostic.code, 'path_escape');

    const folder = readModuleFile(moduleDir, '.', 'fixture');
    assert.equal(folder.ok, false);
    if (!folder.ok) assert.equal(folder.diagnostic.code, 'path_escape');
  });
});

describe('readModuleInputs: bad module content never throws', () => {
  it('reports wasm_missing when the wasm is absent', () => {
    const { moduleDir } = copyToy();
    fs.rmSync(path.join(moduleDir, 'grammar.wasm'));
    assert.deepEqual(codes(readModuleInputs(moduleDir)), ['wasm_missing']);
  });

  it('reports every independent problem at once (wasm, lock and a query)', () => {
    const { moduleDir } = copyToy();
    fs.rmSync(path.join(moduleDir, 'grammar.wasm'));
    fs.rmSync(path.join(moduleDir, 'grammar.lock'));
    fs.rmSync(path.join(moduleDir, 'queries', 'refs.scm'));
    assert.deepEqual(codes(readModuleInputs(moduleDir)).sort(), ['lock_missing', 'query_missing', 'wasm_missing']);
  });

  it('reports manifest_too_large for a manifest over 64 KiB', () => {
    const { moduleDir } = copyToy();
    const original = fs.readFileSync(path.join(moduleDir, 'atlas-lang.json'), 'utf8');
    fs.writeFileSync(path.join(moduleDir, 'atlas-lang.json'), original + ' '.repeat(64 * 1024));
    assert.deepEqual(codes(readModuleInputs(moduleDir)), ['manifest_too_large']);
  });

  it('reports manifest_invalid for an invalid manifest and for text that is not JSON', () => {
    const { moduleDir } = copyToy();
    fs.writeFileSync(path.join(moduleDir, 'atlas-lang.json'), '{"schemaVersion": 2}');
    assert.ok(codes(readModuleInputs(moduleDir)).every((c) => c === 'manifest_invalid'));
    fs.writeFileSync(path.join(moduleDir, 'atlas-lang.json'), 'not json {');
    assert.deepEqual(codes(readModuleInputs(moduleDir)), ['manifest_invalid']);
  });

  it('reports manifest_unreadable when the manifest or the folder is missing', () => {
    const { root, moduleDir } = copyToy();
    fs.rmSync(path.join(moduleDir, 'atlas-lang.json'));
    assert.deepEqual(codes(readModuleInputs(moduleDir)), ['manifest_unreadable']);
    assert.deepEqual(codes(readModuleInputs(path.join(root, 'no-such-folder'))), ['manifest_unreadable']);
  });

  it('reports lock_invalid for a lock that does not parse', () => {
    const { moduleDir } = copyToy();
    fs.writeFileSync(path.join(moduleDir, 'grammar.lock'), '{"lockVersion": 1}');
    assert.ok(codes(readModuleInputs(moduleDir)).every((c) => c === 'lock_invalid'));
  });

  it('reports wasm_too_large and query_too_large for files over their caps', () => {
    const { moduleDir } = copyToy();
    fs.writeFileSync(path.join(moduleDir, 'grammar.wasm'), Buffer.alloc(8 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(moduleDir, 'queries', 'refs.scm'), ';'.repeat(256 * 1024 + 1));
    assert.deepEqual(codes(readModuleInputs(moduleDir)).sort(), ['query_too_large', 'wasm_too_large']);
  });
});
