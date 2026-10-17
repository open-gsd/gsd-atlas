import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';

import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import type { SetupResult, SetupRunner, SetupSpec, TempGitRepo } from '../src/test-kit/index.ts';
import { evaluateGates, readStoreSummary, runCli, runCorpusGates } from './corpus-gates.ts';
import type { Check, CorpusGatesOptions, CorpusGatesReport, GateInputs, StoreSummary } from './corpus-gates.ts';

/** A real git runner for the test kit: argument arrays only, no shell. */
const runner: SetupRunner = {
  run(spec: SetupSpec): Promise<SetupResult> {
    const result = spawnSync(spec.executable, [...spec.args], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...process.env, ...spec.env },
      ...(spec.stdin === undefined ? {} : { input: spec.stdin }),
    });
    return Promise.resolve({ ok: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  },
};

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 12\n';

/** TypeScript and JavaScript sources, a tracked one of every kind the source set drops, an ignored file and an untracked one. */
async function makeCorpusRepo(): Promise<TempGitRepo> {
  return createTempGitRepo({
    runner,
    world: {
      committed: {
        'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
        'src/b.js': 'module.exports = { beta() { return 2; } };\n',
        'gen.ts': 'export const generated = 1;\n',
        'vendor/v.ts': 'export const vendored = 1;\n',
        'bin.ts': 'export const binary = 1;\0\n',
        'lfs.ts': LFS_POINTER,
        'README.md': '# not a source file\n',
        'notes.txt': 'plain text\n',
        '.gitattributes': 'gen.ts linguist-generated=true\nvendor/** linguist-vendored=true\n',
      },
      ignored: ['ignored.ts'],
      working: {
        'ignored.ts': 'export const ignoredOne = 1;\n',
        'fresh.ts': 'export function freshOne(): number {\n  return 3;\n}\n',
      },
    },
  });
}

function fetchFrom(repo: TempGitRepo): NonNullable<CorpusGatesOptions['fetch']> {
  return () => Promise.resolve({ dir: repo.dir, sha: '0'.repeat(40) });
}

/** Gate inputs that pass every check; a case overrides one field to break one check. */
function passing(): GateInputs {
  return {
    first: { files: 8, parsed: 8, linked: 0, removed: 0, skipped: 4, failed: 0, failedCodes: {}, elapsedMs: 10 },
    second: { files: 8, parsed: 0, linked: 8, removed: 0, skipped: 4, failed: 0, failedCodes: {}, elapsedMs: 5 },
    // 8 kept + 1 oversize + 2 unclaimed + 1 snapshot-skipped + 2 dropped = 14 listed paths
    gitFiles: new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'big.ts', 'x.md', 'y.md', 'link.ts', 'gen.ts', 'bin.ts']),
    audit: {
      total: 14,
      unclaimed: 2,
      snapshotSkipped: ['link.ts'],
      oversize: ['big.ts'],
      kept: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'],
      dropped: { generated_skipped: ['gen.ts'], binary_skipped: ['bin.ts'] },
    },
    // one aggregate diagnostic for the unclaimed files + the snapshot skip + the two dropped files
    store: {
      modules: [{ module: 'typescript', files: 1000, errorFiles: 5 }],
      indexedPaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'big.ts'],
    },
    databaseBytes: 1000,
    maxStoreBytes: 52_428_800,
    maxParseErrorRatio: 0.005,
  };
}

const byName = (checks: readonly Check[], name: string) => {
  const found = checks.find((check) => check.name === name);
  assert.ok(found, `no check named "${name}" in ${checks.map((c) => c.name).join(' | ')}`);
  return found;
};

describe('the gates over a real local repository through the composed Host', () => {
  let repo: TempGitRepo;
  let tmpRoot: ReturnType<typeof makeTempDir>;
  let report: CorpusGatesReport;
  const lines: string[] = [];

  before(async () => {
    repo = await makeCorpusRepo();
    tmpRoot = makeTempDir();
    report = await runCorpusGates({ corpus: 'demo', fetch: fetchFrom(repo), tmpRoot: tmpRoot.path, out: (line) => lines.push(line) });
  });
  after(() => {
    tmpRoot.cleanup();
    repo.cleanup();
  });

  it('every check passes and the printed lines say PASS for each', () => {
    assert.ok(report.ok, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
    for (const check of report.checks) assert.ok(lines.some((line) => line.startsWith(`PASS ${check.name}`)), `no PASS line for ${check.name}`);
    assert.ok(!lines.some((line) => line.includes('FAIL')));
  });

  it('accounting identity: indexed plus skipped plus unclaimed equals the listed files', () => {
    const check = byName(report.checks, 'accounting identity');
    assert.ok(check.ok, check.detail);
    // the repository lists 10 files: 3 indexed (a.ts, b.js, fresh.ts), 4 dropped by the source-set rules, 3 with no claiming module
    assert.equal(report.first.files, 3);
    assert.equal(report.audit.total, 10);
    assert.equal(report.audit.unclaimed, 3);
  });

  it('ignored file absent: only tracked and untracked-not-ignored sources are indexed, and none of the dropped kinds', () => {
    const indexed = new Set(report.store.indexedPaths);
    assert.deepEqual([...indexed].sort(), ['fresh.ts', 'src/a.ts', 'src/b.js']);
    for (const absent of ['ignored.ts', 'gen.ts', 'vendor/v.ts', 'bin.ts', 'lfs.ts', 'README.md']) {
      assert.ok(!indexed.has(absent), `${absent} must not be indexed`);
    }
    assert.ok(byName(report.checks, 'indexed paths are in the git file list').ok);
    assert.ok(byName(report.checks, 'indexed set equals the audited source set').ok);
  });

  it('second build parses zero files and links every one', () => {
    assert.equal(report.second.parsed, 0);
    assert.equal(report.second.linked, report.first.files);
    assert.ok(byName(report.checks, 'second build parses zero files').ok);
  });

  it('parse-error ratio is computed per module from the store, and database size is measured and small', () => {
    const typescript = report.store.modules.find((row) => row.module === 'typescript');
    assert.ok(typescript && typescript.files >= 2, 'the TypeScript module indexed the .ts files');
    assert.ok(byName(report.checks, 'parse-error ratio typescript').ok);
    assert.ok(report.databaseBytes > 0 && report.databaseBytes < 52_428_800);
    assert.ok(byName(report.checks, 'database size').ok);
  });

  it('the work directory is removed afterwards and the repository under test is left alone', () => {
    assert.equal(fs.existsSync(report.workDir), false);
    assert.equal(fs.readdirSync(tmpRoot.path).length, 0);
    assert.ok(fs.existsSync(path.join(repo.dir, 'src', 'a.ts')));
    assert.equal(fs.existsSync(path.join(repo.dir, '.git', 'gsd-atlas')), false, 'the store went to the override directory, not into the repository');
  });
});

describe('evaluateGates', () => {
  it('passes the baseline inputs', () => {
    const checks = evaluateGates(passing());
    assert.deepEqual(checks.filter((check) => !check.ok), []);
  });

  it('accounting identity fails when a file is unaccounted for, and names the figures', () => {
    const inputs = passing();
    const broken = { ...inputs, first: { ...inputs.first, skipped: inputs.first.skipped - 1 } };
    const check = byName(evaluateGates(broken), 'accounting identity');
    assert.equal(check.ok, false);
    assert.match(check.detail, /13/);
    assert.match(check.detail, /14/);
  });

  it('second build parses zero files fails when it parsed one or linked fewer than the file count', () => {
    const inputs = passing();
    const parsed = evaluateGates({ ...inputs, second: { ...inputs.second, parsed: 1, linked: 7 } });
    assert.equal(byName(parsed, 'second build parses zero files').ok, false);
    const fewer = evaluateGates({ ...inputs, second: { ...inputs.second, linked: 7 } });
    assert.equal(byName(fewer, 'second build parses zero files').ok, false);
  });

  it('parse-error ratio is files with errors over files, at most 0.005 per module', () => {
    const inputs = passing();
    const at = (errorFiles: number, files: number) =>
      byName(evaluateGates({ ...inputs, store: { ...inputs.store, modules: [{ module: 'typescript', files, errorFiles }] } }), 'parse-error ratio typescript');
    assert.equal(at(5, 1000).ok, true, '5 in 1000 is exactly 0.005, which passes');
    assert.equal(at(6, 1000).ok, false, '6 in 1000 is over');
    assert.equal(at(1, 100).ok, false, '1 in 100 is over');
    assert.equal(at(0, 3).ok, true);
    const two = evaluateGates({
      ...inputs,
      store: {
        ...inputs.store,
        modules: [
          { module: 'typescript', files: 1000, errorFiles: 0 },
          { module: 'javascript', files: 100, errorFiles: 2 },
        ],
      },
    });
    assert.equal(byName(two, 'parse-error ratio typescript').ok, true, 'a good module is not pooled with a bad one');
    assert.equal(byName(two, 'parse-error ratio javascript').ok, false);
  });

  it('database size fails above the limit and passes at it', () => {
    const inputs = passing();
    assert.equal(byName(evaluateGates({ ...inputs, databaseBytes: 52_428_800 }), 'database size').ok, true);
    assert.equal(byName(evaluateGates({ ...inputs, databaseBytes: 52_428_801 }), 'database size').ok, false);
  });

  it('a path outside the git file list, or a dropped kind in the store, fails the named check', () => {
    const inputs = passing();
    const foreign = evaluateGates({ ...inputs, store: { ...inputs.store, indexedPaths: [...inputs.store.indexedPaths, 'not/in/git.ts'] } });
    assert.equal(byName(foreign, 'indexed paths are in the git file list').ok, false);
    assert.equal(byName(foreign, 'indexed set equals the audited source set').ok, false);
    const generated = evaluateGates({ ...inputs, store: { ...inputs.store, indexedPaths: [...inputs.store.indexedPaths, 'gen.ts'] } });
    assert.equal(byName(generated, 'indexed paths are in the git file list').ok, true);
    assert.equal(byName(generated, 'indexed set equals the audited source set').ok, false);
    assert.match(byName(generated, 'indexed set equals the audited source set').detail, /gen\.ts/);
  });
});

describe('the command line', () => {
  it('failing check: exits 1 and names the check when the store holds a path git does not list', async () => {
    const repo = await makeCorpusRepo();
    const tmp = makeTempDir();
    const out: string[] = [];
    try {
      const code = await runCli(['--corpus', 'demo'], (text) => out.push(text), {
        fetch: fetchFrom(repo),
        tmpRoot: tmp.path,
        readStore: async (file): Promise<StoreSummary> => {
          const real = await readStoreSummary(file);
          return { ...real, indexedPaths: [...real.indexedPaths, 'not/in/git.ts'] };
        },
      });
      assert.equal(code, 1);
      const text = out.join('');
      assert.match(text, /FAIL indexed paths are in the git file list/);
      assert.match(text, /not\/in\/git\.ts/);
      assert.equal(fs.readdirSync(tmp.path).length, 0, 'the work directory is removed after a failing run too');
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  it('exits 0 and prints the figures for a passing run', async () => {
    const repo = await makeCorpusRepo();
    const tmp = makeTempDir();
    const out: string[] = [];
    try {
      const code = await runCli(['--corpus', 'demo'], (text) => out.push(text), { fetch: fetchFrom(repo), tmpRoot: tmp.path });
      assert.equal(code, 0, out.join(''));
      const text = out.join('');
      assert.match(text, /first build: .*files 3/);
      assert.match(text, /second build: .*parsed 0/);
      assert.match(text, /database bytes \d+/);
      assert.match(text, /corpus-gates: OK/);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  it('a failed fetch removes the work directory and rejects', async () => {
    const tmp = makeTempDir();
    try {
      await assert.rejects(
        runCorpusGates({ corpus: 'demo', tmpRoot: tmp.path, fetch: () => Promise.reject(new Error('network is down')) }),
        /network is down/,
      );
      assert.equal(fs.readdirSync(tmp.path).length, 0);
    } finally {
      tmp.cleanup();
    }
  });

  it('refuses a work area inside the repository and creates nothing there', async () => {
    const inside = path.join(import.meta.dirname, '..', 'corpus-gates-should-not-exist');
    await assert.rejects(
      runCorpusGates({ corpus: 'demo', tmpRoot: inside, fetch: () => Promise.reject(new Error('unreachable')) }),
      /inside the repository/,
    );
    assert.equal(fs.existsSync(inside), false);
  });

  it('a work area beside the repository whose name shares the repository name as a prefix is not inside it (shared isInside)', async () => {
    const sibling = `${path.resolve(import.meta.dirname, '..')}-sibling-work`;
    try {
      await assert.rejects(
        runCorpusGates({ corpus: 'demo', tmpRoot: sibling, fetch: () => Promise.reject(new Error('stop after the containment check')) }),
        (error: unknown) => error instanceof Error && /stop after the containment check/.test(error.message) && !/inside the repository/.test(error.message),
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});
