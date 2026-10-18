import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildAndReadRelations, censusOf, compareSubtypes, runCheck, runCli } from './relations-check.ts';
import type { StoredRelation } from './relations-check.ts';

/** The oracle's own fixture repository: Sub extends Base, Square extends Shape, Boom extends Error (a library class). */
const FIXTURE = path.join(import.meta.dirname, 'eval', '__fixtures__', 'oracle-repo');

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** A copy of the fixture in a fresh git repository under the OS temp directory, with `extra` files added. */
function tempRepo(extra: Readonly<Record<string, string>> = {}): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relations-check-test-')));
  for (const rel of listFiles(FIXTURE)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE, ...rel.split('/')), target);
  }
  for (const [rel, text] of Object.entries(extra)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=check', '-c', 'user.email=check@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
  return dir;
}

function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const brief = (relations: readonly StoredRelation[]): string[] =>
  relations.map((item) => `${item.relation} ${item.from.qualifiedName} -> ${item.to.qualifiedName}`).sort();

describe('compareSubtypes', () => {
  const pair = (file: string, name: string): { file: string; name: string } => ({ file, name });

  it('pairs a subtype of the oracle with the same file and name in the store, and leaves the rest on their side', () => {
    const result = compareSubtypes([pair('a.cts', 'A'), pair('b.cts', 'B')], [pair('a.cts', 'A'), pair('c.cts', 'C')]);
    assert.equal(result.agree, 1);
    assert.deepEqual(result.oracleOnly, [pair('b.cts', 'B')]);
    assert.deepEqual(result.storeOnly, [pair('c.cts', 'C')]);
  });

  it('counts a pair once however often a side lists it, and the same name in another file is another subtype', () => {
    const result = compareSubtypes([pair('a.cts', 'A'), pair('a.cts', 'A')], [pair('a.cts', 'A'), pair('a.cts', 'A'), pair('b.cts', 'A')]);
    assert.equal(result.agree, 1);
    assert.deepEqual(result.storeOnly, [pair('b.cts', 'A')]);
    assert.deepEqual(result.oracleOnly, []);
  });
});

describe('relations-check against the oracle fixture repository', () => {
  let dir = '';
  let work = '';
  let stored: readonly StoredRelation[] = [];

  before(async () => {
    dir = tempRepo();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'relations-check-work-'));
    stored = await buildAndReadRelations(dir, work, censusOf({ repoDir: dir, tsconfig: 'tsconfig.json' }).targets);
  });

  after(() => {
    removeTree(dir);
    removeTree(work);
  });

  const storedRelations = async (): Promise<readonly StoredRelation[]> => stored;

  it('the census is the repository classes and interfaces that have a subtype, and the library base is listed apart', () => {
    const census = censusOf({ repoDir: dir, tsconfig: 'tsconfig.json' });
    assert.deepEqual(census.targets.map((target) => [target.definedIn, target.symbol, target.kind]), [
      ['src/lib.cts', 'Base', 'class'],
      ['src/lib.cts', 'Shape', 'interface'],
    ]);
    assert.deepEqual(census.libraryBases, ['Error']);
  });

  it('the store holds the extends relations of the fixture and none for the library class', () => {
    assert.deepEqual(brief(stored), ['extends Square -> Shape', 'extends Sub -> Base']);
  });

  it('agrees on the fixture: the store and the oracle name the same subtypes, exit 0, no differences', async () => {
    const lines: string[] = [];
    const report = await runCheck({ dir, readStoreRelations: storedRelations, out: (line) => lines.push(line) });
    assert.equal(report.ok, true);
    assert.equal(report.agree, 2);
    assert.equal(report.storeOnly, 0);
    assert.equal(report.oracleOnly, 0);
    const text = lines.join('\n');
    assert.match(text, /^agree 2$/m);
    assert.match(text, /^store_only 0$/m);
    assert.match(text, /^oracle_only 0$/m);
  });

  it('library base is reported separately: Error is listed with its subclasses, is not stored and is not a difference', async () => {
    const lines: string[] = [];
    const report = await runCheck({ dir, readStoreRelations: storedRelations, out: (line) => lines.push(line) });
    const text = lines.join('\n');
    const heading = text.indexOf('library bases (not stored)');
    assert.ok(heading >= 0, text);
    assert.match(text.slice(heading), /^Error 1$/m);
    assert.deepEqual(report.libraryBases, [{ name: 'Error', subtypes: 1 }]);
    assert.equal(report.ok, true);
  });

  it('agrees on the fixture through the command line and exits 0', async () => {
    let written = '';
    const code = await runCli(['--dir', dir], (text) => {
      written += text;
    }, { readStoreRelations: storedRelations });
    assert.equal(code, 0, written);
    assert.match(written, /relations-check: OK/);
  });

  it('a relation the store misses is oracle_only and exits 1', async () => {
    const missing = async (): Promise<readonly StoredRelation[]> => stored.filter((item) => item.from.qualifiedName !== 'Sub');
    const lines: string[] = [];
    const report = await runCheck({ dir, readStoreRelations: missing, out: (line) => lines.push(line) });
    assert.equal(report.ok, false);
    assert.equal(report.oracleOnly, 1);
    assert.equal(report.storeOnly, 0);
    assert.match(lines.join('\n'), /oracle_only: src\/shapes\.cts Sub \(Base\)/);
    let written = '';
    const code = await runCli(['--dir', dir], (text) => {
      written += text;
    }, { readStoreRelations: missing });
    assert.equal(code, 1);
    assert.match(written, /relations-check: FAILED/);
  });

  it('a relation the store invents is store_only and exits 1', async () => {
    const invented = async (): Promise<readonly StoredRelation[]> => [
      ...stored,
      {
        relation: 'extends',
        from: { path: 'src/user.cts', qualifiedName: 'Phantom', kind: 'class' },
        to: { path: 'src/lib.cts', qualifiedName: 'Base', kind: 'class' },
      },
    ];
    const report = await runCheck({ dir, readStoreRelations: invented, out: () => undefined });
    assert.equal(report.ok, false);
    assert.equal(report.storeOnly, 1);
    assert.equal(report.oracleOnly, 0);
  });

  it('a usage error exits 2 and says why', async () => {
    let written = '';
    assert.equal(await runCli([], (text) => void (written += text)), 2);
    assert.match(written, /--dir is required/);
    written = '';
    assert.equal(await runCli(['--dir', dir, '--nope'], (text) => void (written += text)), 2);
    assert.match(written, /usage:/);
  });
});

describe('relations-check on a copy with an implements and a mixin', () => {
  let dir = '';
  let work = '';

  before(() => {
    dir = tempRepo({
      'src/extra.cts': [
        'export interface Runner {',
        '  run(): void;',
        '}',
        'export class Impl implements Runner {',
        '  run(): void {}',
        '}',
        'export class Impl2 implements Runner {',
        '  run(): void {}',
        '}',
        '',
      ].join('\n'),
    });
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'relations-check-work-'));
  });

  after(() => {
    removeTree(dir);
    removeTree(work);
  });

  it('agrees through the real Host and worker: implements counts like extends', async () => {
    const lines: string[] = [];
    const report = await runCheck({ dir, out: (line) => lines.push(line) });
    assert.equal(report.ok, true, lines.join('\n'));
    assert.equal(report.agree, 4, lines.join('\n'));
    assert.equal(report.storeOnly, 0);
    assert.equal(report.oracleOnly, 0);
    assert.deepEqual(report.libraryBases, [{ name: 'Error', subtypes: 1 }]);
  });
});
