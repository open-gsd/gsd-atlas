import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGrammarEngine } from '../grammar-engine/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { runLangTest } from './index.ts';

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
