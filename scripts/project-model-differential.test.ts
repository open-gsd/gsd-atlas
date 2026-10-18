import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { compareCheckout, directoryProjectFs, formatReport, runCli, trackedPaths } from './project-model-differential.ts';

// The script's own tests use a small temporary git repository and the compiler. No network.

function git(dir: string, args: readonly string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && name !== 'GIT_CONFIG_GLOBAL' && name !== 'GIT_CONFIG_NOSYSTEM') delete env[name];
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

/** Writes `tree` into a new temporary git repository (committed), runs `body`, removes it. */
async function withRepo<T>(tree: Readonly<Record<string, string>>, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pmd-')));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'fixture']);
    return await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TREE: Readonly<Record<string, string>> = {
  'tsconfig.json': '{ "extends": "./tsconfig.build.json" }\n',
  'tsconfig.build.json': '{\n  // build config\n  "compilerOptions": { "rootDir": "src", "outDir": "out" },\n  "include": ["src/**/*.ts"],\n  "exclude": ["src/**/*.test.ts"],\n}\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/sub/b.ts': 'export const b = 2;\n',
  'src/a.test.ts': 'export {};\n',
  'docs/readme.md': '# docs\n',
  'packages/x/tsconfig.json': '{ "extends": "@missing/base/tsconfig.json", "include": ["src"] }\n',
  'packages/x/src/x.ts': 'export {};\n',
};

function capture(): { io: { stdout: { write(t: string): void }; stderr: { write(t: string): void } }; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: { stdout: { write: (t) => void (out += t) }, stderr: { write: (t) => void (err += t) } },
    out: () => out,
    err: () => err,
  };
}

test('differential script: a repository the model reads like the compiler exits 0', async () => {
  await withRepo(TREE, async (dir) => {
    const c = capture();
    const code = await runCli(['--corpus', 'gsd-core', '--dir', dir], c.io);
    assert.equal(code, 0, c.out() + c.err());
    assert.match(c.out(), /^tsconfig\.build\.json: compared=\d+ disagreements=0 /m);
    assert.match(c.out(), /^tsconfig\.json: compared=\d+ disagreements=0 /m);
    assert.match(c.out(), /gsd-core: configs=3 understood=2 tracked=\d+ disagreements=0 crashes=0/);
    // The config whose extends package is missing is printed as information only.
    assert.match(c.out(), /packages\/x\/tsconfig\.json: .*not understood, information only: extends_unresolved/);
  });
});

test('differential script: a model that reads a different include exits 1 and names the paths', async () => {
  await withRepo(TREE, async (dir) => {
    const c = capture();
    const code = await runCli(['--corpus', 'gsd-core', '--dir', dir], c.io, {
      // A deliberately broken copy: the model is handed a build config whose include names the wrong directory.
      wrapFs: (real) => ({
        exists: real.exists,
        async readText(p) {
          const result = await real.readText(p);
          return p === 'tsconfig.build.json' && result.kind === 'ok' ? { kind: 'ok', text: result.text.replace('src/**/*.ts', 'nowhere/**/*.ts') } : result;
        },
      }),
    });
    assert.equal(code, 1, c.out());
    assert.match(c.out(), /tsconfig\.json: compared=\d+ disagreements=[1-9]/);
    assert.match(c.out(), /src\/a\.ts \(model no\)/);
    assert.match(c.out(), /disagreements=[1-9]\d* crashes=0/);
  });
});

test('differential script: the report counts what was compared', async () => {
  await withRepo(TREE, async (dir) => {
    const report = await compareCheckout(dir);
    assert.equal(report.disagreements, 0);
    assert.deepEqual(report.crashes, []);
    assert.equal(report.tracked, trackedPaths(dir).length);
    const root = report.configs.find((c) => c.path === 'tsconfig.json');
    assert.equal(root?.modelFiles, 2, 'src/a.ts and src/sub/b.ts');
    assert.equal(root?.compilerFiles, 2);
    assert.equal(root?.compared, report.tracked);
    assert.match(formatReport('x', report), /^x: configs=3 /m);
  });
});

test('differential script: usage errors exit 2 and a failed preparation exits 1', async () => {
  for (const argv of [[], ['--corpus', 'nope'], ['--corpus', 'gsd-core', '--bogus'], ['--dir', '/tmp']]) {
    const c = capture();
    assert.equal(await runCli(argv, c.io), 2, JSON.stringify(argv));
    assert.match(c.err(), /usage:/);
  }
  const failing = capture();
  const code = await runCli(['--corpus', 'gsd-pi'], failing.io, {
    prepare: () => {
      throw new Error('offline');
    },
  });
  assert.equal(code, 1);
  assert.match(failing.err(), /offline/);

  await withRepo(TREE, async (dir) => {
    const c = capture();
    assert.equal(await runCli(['--corpus', 'gsd-pi'], c.io, { prepare: () => dir }), 0, c.out() + c.err());
    assert.match(c.out(), /gsd-pi: configs=/);
  });
});

// The --emit mode (TSM-03, plan 03-22): where the model says each source is written, against ts.getOutputFileNames.

const EMIT_TREE: Readonly<Record<string, string>> = {
  'tsconfig.json': '{ "compilerOptions": { "rootDir": "src", "outDir": "out", "module": "nodenext" }, "include": ["src"] }\n',
  'src/a.cts': 'export {};\n',
  'src/b.mts': 'export {};\n',
  'src/c.ts': 'export {};\n',
  'src/types.d.ts': 'export {};\n',
  'out/vendor.cjs': 'module.exports = 1;\n',
  'out/NOTICE.txt': 'hand written\n',
  'docs/readme.md': '# docs\n',
};

test('differential script --emit: the model maps every source like the compiler and names the tracked files under outDir that are not outputs', async () => {
  await withRepo(EMIT_TREE, async (dir) => {
    const c = capture();
    const code = await runCli(['--corpus', 'gsd-core', '--dir', dir, '--emit'], c.io);
    assert.equal(code, 0, c.out() + c.err());
    assert.match(c.out(), /^emit: sources=4 with output=3 disagreements=0 crashes=0$/m, 'a.cts, b.mts, c.ts and types.d.ts are compared; the declaration file has no output');
    assert.match(c.out(), /^outDir out: tracked=2 outputs=0 not an output=2$/m);
    assert.match(c.out(), /^gsd-core: emit sources=4 with output=3 disagreements=0 crashes=0$/m);
  });
});

test('differential script --emit: a model that places outputs elsewhere exits 1 and names the source', async () => {
  await withRepo(EMIT_TREE, async (dir) => {
    const c = capture();
    const code = await runCli(['--corpus', 'gsd-core', '--dir', dir, '--emit'], c.io, {
      wrapFs: (real) => ({
        exists: real.exists,
        async readText(p) {
          const result = await real.readText(p);
          return p === 'tsconfig.json' && result.kind === 'ok' ? { kind: 'ok', text: result.text.replace('"outDir": "out"', '"outDir": "elsewhere"') } : result;
        },
      }),
    });
    assert.equal(code, 1, c.out());
    assert.match(c.out(), / disagreements=3 /);
    assert.match(c.out(), /src\/a\.cts: model \["elsewhere\/a\.cjs"\] vs compiler \["out\/a\.cjs"\]/);
  });
});

test('differential script --emit: usage errors still exit 2', async () => {
  const c = capture();
  assert.equal(await runCli(['--emit'], c.io), 2);
  assert.match(c.err(), /usage:.*--emit/);
});

test('differential script: the directory reader is confined to the checkout', async () => {
  await withRepo(TREE, async (dir) => {
    const fsOver = directoryProjectFs(dir);
    assert.equal((await fsOver.readText('src/a.ts')).kind, 'ok');
    assert.equal((await fsOver.readText('../escape.json')).kind, 'escape');
    assert.equal((await fsOver.readText('src/missing.ts')).kind, 'missing');
    assert.deepEqual([...(await fsOver.exists(['src/a.ts', 'src/nope.ts', 'src']))], ['src/a.ts']);
  });
});
