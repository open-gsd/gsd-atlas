import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildAndReadCitations,
  compareLines,
  runCheck,
  runCli,
  sampleNumbers,
  withinThreshold,
} from './adr-citations-check.ts';
import type { StoreHit } from './adr-citations-check.ts';

/** The oracle's own fixture repository: ADR-1 in a JSDoc, ADR #2 §3 and adr 0003 in comments, ADR-9 only in a string. */
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

/** A copy of the fixture in a fresh git repository under the OS temp directory. */
function tempRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'adr-check-test-')));
  for (const rel of listFiles(FIXTURE)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE, ...rel.split('/')), target);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=check', '-c', 'user.email=check@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
  return dir;
}

function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe('compareLines', () => {
  const hit = (file: string, line: number): { file: string; line: number } => ({ file, line });

  it('pairs a store line with an oracle line in the same file within the slack of two lines', () => {
    const result = compareLines([hit('a.ts', 10), hit('b.ts', 4)], [hit('a.ts', 12), hit('b.ts', 4)], 2);
    assert.equal(result.agree, 2);
    assert.deepEqual(result.storeOnly, []);
    assert.deepEqual(result.oracleOnly, []);
  });

  it('three lines away, another file or no counterpart is a difference on the side that has it', () => {
    const result = compareLines([hit('a.ts', 10), hit('b.ts', 1)], [hit('a.ts', 13), hit('c.ts', 1)], 2);
    assert.equal(result.agree, 0);
    assert.deepEqual(result.oracleOnly, [hit('a.ts', 10), hit('b.ts', 1)]);
    assert.deepEqual(result.storeOnly, [hit('a.ts', 13), hit('c.ts', 1)]);
  });

  it('pairs each line once: two oracle lines and one store line leave one oracle_only', () => {
    const result = compareLines([hit('a.ts', 5), hit('a.ts', 6)], [hit('a.ts', 5)], 2);
    assert.equal(result.agree, 1);
    assert.deepEqual(result.oracleOnly, [hit('a.ts', 6)]);
    assert.deepEqual(result.storeOnly, []);
  });

  it('counts a line once however many mentions it holds', () => {
    const result = compareLines([hit('a.ts', 5)], [hit('a.ts', 5), hit('a.ts', 5)], 2);
    assert.equal(result.agree, 1);
    assert.deepEqual(result.storeOnly, []);
  });
});

describe('sampleNumbers', () => {
  const census = Array.from({ length: 100 }, (_, index) => index + 1);

  it('is deterministic for a seed, sorted, without repeats, and differs between seeds', () => {
    const first = sampleNumbers(census, 20, 7);
    assert.deepEqual(sampleNumbers(census, 20, 7), first);
    assert.equal(first.length, 20);
    assert.equal(new Set(first).size, 20);
    assert.deepEqual([...first].sort((a, b) => a - b), first);
    assert.notDeepEqual(sampleNumbers(census, 20, 8), first);
  });

  it('does not depend on the order the census arrives in, and returns all of a census smaller than the sample', () => {
    assert.deepEqual(sampleNumbers([...census].reverse(), 20, 7), sampleNumbers(census, 20, 7));
    assert.deepEqual(sampleNumbers([3, 1, 2], 20, 7), [1, 2, 3]);
    assert.deepEqual(sampleNumbers([], 20, 7), []);
  });
});

describe('withinThreshold', () => {
  it('allows differences up to 2 percent of the oracle total and no more', () => {
    assert.equal(withinThreshold(0, 0, 0), true);
    assert.equal(withinThreshold(2, 0, 100), true, 'exactly 2 percent');
    assert.equal(withinThreshold(1, 2, 100), false, 'store_only plus oracle_only is 3 percent');
    assert.equal(withinThreshold(0, 1, 0), false, 'a difference with nothing to compare against');
  });
});

describe('adr-citations-check against the oracle fixture repository', () => {
  let dir = '';
  let storeHits: readonly StoreHit[] = [];
  let work = '';

  before(async () => {
    dir = tempRepo();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-check-work-'));
    storeHits = await buildAndReadCitations(dir, work);
  });

  after(() => {
    removeTree(dir);
    removeTree(work);
  });

  const stored = async (): Promise<readonly StoreHit[]> => storeHits;

  it('the store holds the comment citations of the fixture and none from the string literal', () => {
    assert.deepEqual(
      storeHits.map((h) => [h.number, h.file]).sort(),
      [
        [1, 'src/lib.cts'],
        [2, 'src/user.cts'],
        [3, 'src/user.cts'],
      ],
    );
  });

  it('agrees on the fixture: every cited number matches the oracle, exit 0, no differences', async () => {
    const lines: string[] = [];
    const report = await runCheck({ dir, sample: 20, seed: 7, readStoreCitations: stored, out: (line) => lines.push(line) });
    assert.equal(report.ok, true);
    assert.equal(report.storeOnly, 0);
    assert.equal(report.oracleOnly, 0);
    assert.equal(report.agree, 3);
    assert.deepEqual(
      report.rows.map((row) => row.number),
      [1, 2, 3],
    );
    const text = lines.join('\n');
    assert.match(text, /^store_only 0$/m);
    assert.match(text, /^oracle_only 0$/m);
    assert.match(text, /^agree 3$/m);
  });

  it('agrees on the fixture through the command line and exits 0', async () => {
    let written = '';
    const code = await runCli(['--dir', dir, '--sample', '20', '--seed', '7'], (text) => {
      written += text;
    }, { readStoreCitations: stored });
    assert.equal(code, 0, written);
    assert.match(written, /adr-citations-check: OK/);
  });

  it('reports a difference when the store misses a citation the oracle has, and exits 1', async () => {
    const missing = async (): Promise<readonly StoreHit[]> => storeHits.filter((h) => h.number !== 1);
    const lines: string[] = [];
    const report = await runCheck({ dir, readStoreCitations: missing, out: (line) => lines.push(line) });
    assert.equal(report.ok, false);
    assert.equal(report.oracleOnly, 1);
    assert.equal(report.storeOnly, 0);
    assert.match(lines.join('\n'), /^oracle_only 1$/m);
    assert.match(lines.join('\n'), /oracle_only: src\/lib\.cts:14 \(ADR-1\)/);
    let written = '';
    const code = await runCli(['--dir', dir], (text) => {
      written += text;
    }, { readStoreCitations: missing });
    assert.equal(code, 1);
    assert.match(written, /adr-citations-check: FAILED/);
  });

  it('reports a difference when the store invents a citation, and exits 1', async () => {
    const invented = async (): Promise<readonly StoreHit[]> => [...storeHits, { file: 'src/lib.cts', line: 14, number: 9 }];
    const report = await runCheck({ dir, numbers: [1, 2, 3, 9], readStoreCitations: invented, out: () => undefined });
    assert.equal(report.ok, false);
    assert.equal(report.storeOnly, 1);
    assert.equal(report.oracleOnly, 0);
  });

  it('names the numbers it was given, in order, and ignores the census sample', async () => {
    const report = await runCheck({ dir, numbers: [3, 1], readStoreCitations: stored, out: () => undefined });
    assert.deepEqual(
      report.rows.map((row) => row.number),
      [1, 3],
    );
    assert.equal(report.ok, true);
  });

  it('exits 2 with a usage line when --dir is missing or a flag is unknown', async () => {
    let written = '';
    assert.equal(await runCli([], (text) => { written += text; }), 2);
    assert.match(written, /usage/i);
    written = '';
    assert.equal(await runCli(['--dir', dir, '--bogus'], (text) => { written += text; }), 2);
    assert.match(written, /usage|unknown/i);
  });
});
