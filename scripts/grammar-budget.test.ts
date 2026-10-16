import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeTempDir } from '../src/test-kit/index.ts';
import type { TempDir } from '../src/test-kit/index.ts';
import { GrammarBudgetError, checkBudget, runCli } from './grammar-budget.ts';

const toyDir = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'modules', 'toy');

const temps: TempDir[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) {
    temp.cleanup();
  }
});

function copyToy(): string {
  const temp = makeTempDir();
  temps.push(temp);
  const moduleDir = path.join(temp.path, 'toy');
  fs.cpSync(toyDir, moduleDir, { recursive: true });
  return moduleDir;
}

describe('toy manifest', () => {
  it('atlas-lang.json is the toy module with the 0.5 percent parse budget', () => {
    const text = fs.readFileSync(path.join(toyDir, 'atlas-lang.json'), 'utf8');
    const manifest = JSON.parse(text) as { name: string; parseBudget: number };
    assert.equal(manifest.name, 'toy');
    assert.equal(manifest.parseBudget, 0.005);
  });
});

describe('checkBudget', () => {
  it('passes the clean toy fixtures with ratio 0', async () => {
    const result = await checkBudget(toyDir);
    assert.equal(result.ok, true);
    assert.equal(result.module, 'toy');
    assert.equal(result.errorBytes, 0);
    assert.ok(result.totalBytes > 0);
    assert.equal(result.ratio, 0);
    assert.equal(result.budget, 0.005);
    assert.deepEqual(result.files.map((f) => f.file), ['basic.toy', 'bom.toy', 'crlf.toy', 'emoji.toy']);
  });

  it('fails the negative fixture with a ratio above the manifest budget', async () => {
    const result = await checkBudget(toyDir, { fixturesDir: 'fixtures-negative' });
    assert.equal(result.ok, false);
    assert.ok(result.errorBytes > 0);
    assert.ok(result.ratio > result.budget);
  });

  it('uses strictly greater: a ratio equal to the budget passes', async () => {
    const negative = await checkBudget(toyDir, { fixturesDir: 'fixtures-negative' });
    const atLimit = await checkBudget(toyDir, { fixturesDir: 'fixtures-negative', budget: negative.ratio });
    assert.equal(atLimit.ok, true);
    const justUnder = await checkBudget(toyDir, { fixturesDir: 'fixtures-negative', budget: negative.ratio / 2 });
    assert.equal(justUnder.ok, false);
  });

  it('never measures golden files or files the manifest does not claim', async () => {
    const moduleDir = copyToy();
    fs.writeFileSync(path.join(moduleDir, 'fixtures', 'basic.toy.golden.json'), '{{{ not toy');
    fs.writeFileSync(path.join(moduleDir, 'fixtures', 'notes.txt'), '??? (( not toy');
    const result = await checkBudget(moduleDir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.files.map((f) => f.file), ['basic.toy', 'bom.toy', 'crlf.toy', 'emoji.toy']);
  });

  it('fails when the fixtures folder has nothing to measure rather than passing silently', async () => {
    const result = await checkBudget(toyDir, { fixturesDir: 'no-such-folder' });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
  });

  it('rejects a fixtures-dir that is not a plain folder name', async () => {
    await assert.rejects(checkBudget(toyDir, { fixturesDir: '../fixtures' }), GrammarBudgetError);
    await assert.rejects(checkBudget(toyDir, { fixturesDir: path.join(toyDir, 'fixtures') }), GrammarBudgetError);
  });

  it('throws a GrammarBudgetError for a module whose files cannot be read', async () => {
    const moduleDir = copyToy();
    fs.rmSync(path.join(moduleDir, 'grammar.wasm'));
    await assert.rejects(checkBudget(moduleDir), GrammarBudgetError);
  });
});

describe('CLI (runCli)', () => {
  async function run(argv: string[]) {
    let out = '';
    const code = await runCli(argv, (text) => {
      out += text;
    });
    return { code, out };
  }

  it('exits 0 and prints module, errorBytes, totalBytes, ratio and budget for the clean fixtures', async () => {
    const { code, out } = await run([toyDir]);
    assert.equal(code, 0);
    assert.match(out, /toy: errorBytes 0 totalBytes \d+ ratio 0\.000000 budget 0\.005 OK/);
  });

  it('exits 1 for the negative fixtures and prints a ratio above the budget', async () => {
    const { code, out } = await run([toyDir, '--fixtures-dir', 'fixtures-negative']);
    assert.equal(code, 1);
    const match = /ratio (\d+\.\d+) budget (0\.005) OVER BUDGET/.exec(out);
    assert.ok(match, out);
    assert.ok(Number(match[1]) > Number(match[2]));
  });

  it('with no arguments checks every discovered module and exits 0', async () => {
    const { code, out } = await run([]);
    assert.equal(code, 0);
    assert.match(out, /^toy: /m);
  });
});
