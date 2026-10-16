import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGrammarEngine } from '../grammar-engine/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { runLangTest as runWithRoots } from './index.ts';
import type { LangTestOptions, Roots } from './index.ts';

const TOY = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');
const OTHER_FIXTURES = ['emoji.toy', 'crlf.toy', 'bom.toy'];

const engine = createGrammarEngine();
const temps = [makeTempDir()];
const tmp = temps[0]!;
after(async () => {
  await engine.dispose();
  for (const t of temps) {
    t.cleanup();
  }
});

/** Roots that point at nothing: folder targets never consult the registry. */
const NO_ROOTS: Roots = {
  repoRoot: path.join(tmp.path, 'no-repo'),
  userDir: path.join(tmp.path, 'no-user'),
  builtinDir: null,
  npmRoots: [],
};
const runLangTest = (options: Omit<LangTestOptions, 'roots'> & { readonly roots?: Roots }) =>
  runWithRoots({ roots: NO_ROOTS, ...options });

let counter = 0;
/** A copy of the toy module in a fresh folder; `only` limits the copied fixtures to those names. */
function copyToy(only?: readonly string[]): string {
  counter += 1;
  const dest = path.join(tmp.path, `toy-${String(counter)}`);
  fs.cpSync(TOY, dest, { recursive: true });
  if (only !== undefined) {
    for (const name of [...OTHER_FIXTURES, 'basic.toy']) {
      if (!only.includes(name)) {
        fs.rmSync(path.join(dest, 'fixtures', name), { force: true });
        fs.rmSync(path.join(dest, 'fixtures', `${name}.golden.json`), { force: true });
      }
    }
  }
  return dest;
}

function keysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      keysDeep(item, into);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      keysDeep(item, into);
    }
  }
  return into;
}

describe('runLangTest', () => {
  it('passes the toy module over the basic fixture and its checked-in golden', async () => {
    const report = await runLangTest({ target: copyToy(['basic.toy']), engine });
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.ok, true);
    assert.equal(report.module, 'toy');
    assert.deepEqual(report.fixtures, [{ file: 'basic.toy', ok: true }]);
  });

  it('accepts a relative target', async () => {
    const dir = copyToy(['basic.toy']);
    const report = await runLangTest({ target: path.relative(process.cwd(), dir), engine });
    assert.equal(report.ok, true);
  });

  it('carries no parse-quality number in the report (D-02)', async () => {
    const report = await runLangTest({ target: copyToy(['basic.toy']), engine });
    const forbidden = ['errorBytes', 'totalBytes', 'ratio', 'parseBudget', 'missingNodes'];
    const keys = keysDeep(report);
    for (const name of forbidden) {
      assert.ok(!keys.includes(name), `${name} must not appear in the lang test report`);
    }
  });

  it('reports module_not_found for a target that is not a directory', async () => {
    for (const target of [path.join(tmp.path, 'nosuch'), '', path.join(TOY, 'atlas-lang.json')]) {
      const report = await runLangTest({ target, engine });
      assert.equal(report.ok, false);
      assert.deepEqual(
        report.diagnostics.map((d) => d.code),
        ['module_not_found'],
      );
    }
  });

  it('reports golden_missing for a fixture without a golden file', async () => {
    const dir = copyToy(['basic.toy']);
    fs.rmSync(path.join(dir, 'fixtures', 'basic.toy.golden.json'));
    const report = await runLangTest({ target: dir, engine });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['golden_missing'],
    );
    assert.deepEqual(report.fixtures, [{ file: 'basic.toy', ok: false }]);
  });

  it('reports golden_mismatch naming the fixture, the capture and both values', async () => {
    const dir = copyToy(['basic.toy']);
    const goldenPath = path.join(dir, 'fixtures', 'basic.toy.golden.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as { captures: Array<Record<string, unknown>> };
    const index = golden.captures.findIndex((c) => c['text'] === 'main');
    assert.ok(index >= 0, 'the basic golden has a capture whose text is main');
    golden.captures[index]!['text'] = 'mian';
    fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2));
    const report = await runLangTest({ target: dir, engine });
    assert.equal(report.ok, false);
    const [problem] = report.diagnostics;
    assert.equal(problem?.code, 'golden_mismatch');
    assert.ok(problem.message.includes('basic.toy'));
    assert.ok(problem.message.includes(`capture ${String(index)}`));
    assert.ok(problem.message.includes('"mian"') && problem.message.includes('"main"'));
  });

  it('reports golden_invalid for a golden that is not JSON', async () => {
    const dir = copyToy(['basic.toy']);
    fs.writeFileSync(path.join(dir, 'fixtures', 'basic.toy.golden.json'), '{ not json');
    const report = await runLangTest({ target: dir, engine });
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['golden_invalid'],
    );
  });

  it('does not treat a curated recall truth file (<fixture>.truth.json) as a fixture', async () => {
    const dir = copyToy(['basic.toy']);
    fs.writeFileSync(path.join(dir, 'fixtures', 'basic.truth.json'), JSON.stringify({ schema: 1, fixture: 'basic.toy', items: [] }));
    const report = await runLangTest({ target: dir, engine });
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.ok, true);
    assert.deepEqual(report.fixtures, [{ file: 'basic.toy', ok: true }]);
  });

  it('fails a module whose fixtures folder is missing or empty', async () => {
    const missing = copyToy();
    fs.rmSync(path.join(missing, 'fixtures'), { recursive: true });
    const empty = copyToy();
    fs.rmSync(path.join(empty, 'fixtures'), { recursive: true });
    fs.mkdirSync(path.join(empty, 'fixtures'));
    for (const dir of [missing, empty]) {
      const report = await runLangTest({ target: dir, engine });
      assert.equal(report.ok, false);
      assert.deepEqual(
        report.diagnostics.map((d) => d.code),
        ['fixture_unreadable'],
      );
    }
  });
});

describe('runLangTest by module id (D-03)', () => {
  function rootsWithToyIn(repoCopy: string): Roots {
    counter += 1;
    const repoRoot = path.join(tmp.path, `id-repo-${String(counter)}`);
    fs.mkdirSync(path.join(repoRoot, '.gsd-atlas', 'languages'), { recursive: true });
    fs.cpSync(repoCopy, path.join(repoRoot, '.gsd-atlas', 'languages', 'toy'), { recursive: true });
    return { ...NO_ROOTS, repoRoot };
  }

  it('resolves a bare id through the registry and tests that module', async () => {
    const roots = rootsWithToyIn(copyToy(['basic.toy']));
    const report = await runLangTest({ target: 'toy', roots, engine });
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.ok, true);
    assert.equal(report.module, 'toy');
    assert.deepEqual(report.fixtures, [{ file: 'basic.toy', ok: true }]);
  });

  it('reports module_not_found for an id no location holds', async () => {
    const roots = rootsWithToyIn(copyToy(['basic.toy']));
    const report = await runLangTest({ target: 'nosuch', roots, engine });
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.map((d) => d.code), ['module_not_found']);
  });

  it('does not treat a target with a path separator as an id', async () => {
    const roots = rootsWithToyIn(copyToy(['basic.toy']));
    for (const target of ['./toy-no-such', 'languages/toy', 'a\\toy']) {
      const report = await runLangTest({ target, roots, engine });
      assert.deepEqual(report.diagnostics.map((d) => d.code), ['module_not_found'], target);
    }
  });

  it('keeps a skipped copy as a warning and tests the valid lower-tier copy', async () => {
    const roots = rootsWithToyIn(copyToy(['basic.toy']));
    const userCopy = path.join(tmp.path, `id-user-${String(counter)}`, 'languages', 'toy');
    fs.cpSync(copyToy(['basic.toy']), userCopy, { recursive: true });
    fs.writeFileSync(path.join(roots.repoRoot, '.gsd-atlas', 'languages', 'toy', 'atlas-lang.json'), '{}');
    const report = await runLangTest({ target: 'toy', roots: { ...roots, userDir: path.dirname(path.dirname(userCopy)) }, engine });
    assert.equal(report.ok, true);
    assert.ok(report.diagnostics.length > 0);
    assert.ok(report.diagnostics.every((d) => d.code === 'manifest_invalid' && d.severity === 'warning'));
  });

  it('tests a folder path as a folder even when the registry holds a module of that name', async () => {
    const roots = rootsWithToyIn(copyToy(['basic.toy']));
    const report = await runLangTest({ target: copyToy(['emoji.toy']), roots, engine });
    assert.deepEqual(report.fixtures, [{ file: 'emoji.toy', ok: true }]);
  });
});

describe('runLangTest confinement (T-01-37)', () => {
  const skip = process.platform === 'win32' ? 'creating symlinks needs elevated rights on Windows' : false;

  it('does not read a fixture that is a symlink pointing out of the module folder', { skip }, async () => {
    const dir = copyToy(['basic.toy']);
    const outside = path.join(tmp.path, 'outside.toy');
    fs.writeFileSync(outside, 'fn secret {\n}\n');
    const link = path.join(dir, 'fixtures', 'basic.toy');
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    const report = await runLangTest({ target: dir, engine });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['path_escape'],
    );
    assert.ok(!JSON.stringify(report).includes('secret'));
  });

  it('does not read a golden that is a symlink pointing out of the module folder', { skip }, async () => {
    const dir = copyToy(['basic.toy']);
    const outside = path.join(tmp.path, 'outside.golden.json');
    fs.copyFileSync(path.join(dir, 'fixtures', 'basic.toy.golden.json'), outside);
    const link = path.join(dir, 'fixtures', 'basic.toy.golden.json');
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    const report = await runLangTest({ target: dir, engine });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['path_escape'],
    );
  });

  it('refuses a fixture over the size cap without reading it into the engine', async () => {
    const dir = copyToy(['basic.toy']);
    fs.writeFileSync(path.join(dir, 'fixtures', 'basic.toy'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const report = await runLangTest({ target: dir, engine });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['fixture_unreadable'],
    );
  });

  it('reports a fixture that is not valid UTF-8 as fixture_unreadable', async () => {
    const dir = copyToy(['basic.toy']);
    fs.writeFileSync(path.join(dir, 'fixtures', 'basic.toy'), Buffer.from([0x66, 0x6e, 0xc3, 0x28]));
    const report = await runLangTest({ target: dir, engine });
    assert.deepEqual(
      report.diagnostics.map((d) => d.code),
      ['fixture_unreadable'],
    );
  });
});
