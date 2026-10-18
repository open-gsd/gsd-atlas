/**
 * Emit mapping end to end (TSM-03, plan 03-22): the real `gsd-atlas` and `gsd-atlas-mcp` bins, started through the
 * CommandRunner in an isolated environment, over temporary git repositories that hold a `.cts` source, the `.cjs`
 * file that requires what it compiles to, and (Task 3) a tracked build output.
 *
 * It lives under scripts because the adapter lint forbids src/cli tests from importing any module but host-client.
 *
 * The control variants run the same repository against a copy of the TypeScript module that declares no project model
 * (a user-level module wins over the built-in one), which is how Phase 2 behaved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';
import { CLI_BIN, maskNonce } from './test-helpers/fixture-repo.ts';
import { startMcp } from './test-helpers/mcp-client.ts';
import type { McpClient } from './test-helpers/mcp-client.ts';

const BUILTIN_TYPESCRIPT = path.resolve(import.meta.dirname, '..', 'modules', 'typescript');
const decoder = new TextDecoder();

interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly [key: string]: unknown;
}

interface Row {
  readonly name: string;
  readonly path: string;
  readonly [key: string]: unknown;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Envelope;
}

const rows = (envelope: Envelope): Row[] => (envelope.data as { results: Row[] }).results;

/**
 * True when an answer says the compiler was late (`resolver_timeout`): a cold compiler worker under the load of a full test run
 * can need more than the approved 1.5 seconds. Two answers that are compared across the CLI and MCP are asked again when either
 * is late, never compared loosely: a late answer is a grammar-tier one and is legitimately different from a precise one.
 */
const isLate = (envelope: Envelope): boolean => (envelope['degraded'] as readonly string[] | undefined)?.includes('resolver_timeout') === true;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Emitted {
  readonly dir: string;
  readonly tmp: TempDir;
  readonly repo: TempGitRepo;
  cli(args: readonly string[]): Promise<Run>;
  mcp(): McpClient;
  cleanup(): Promise<void>;
}

interface FixtureOptions {
  readonly ignored?: readonly string[];
  /** Files written to the working tree after the commit (untracked; ignored when listed in `ignored`). */
  readonly working?: Readonly<Record<string, string | null>>;
  /** Run against a copy of the TypeScript module that declares no project model: the Phase 2 control. */
  readonly withoutProjectBlock?: boolean;
}

/** Fixture repository, isolated environment, and the two bins. */
export async function makeEmitFixture(files: Readonly<Record<string, string>>, options: FixtureOptions = {}): Promise<Emitted> {
  const setup = createRealRunner({ decide: allowAll });
  const tmp = makeTempDir();
  const started: McpClient[] = [];
  const repo = await createTempGitRepo({
    runner: setup,
    world: { committed: files, ...(options.ignored === undefined ? {} : { ignored: options.ignored }), ...(options.working === undefined ? {} : { working: options.working }) },
  });
  const userDir = path.join(tmp.path, 'user');
  if (options.withoutProjectBlock === true) {
    const copy = path.join(userDir, 'languages', 'typescript');
    fs.cpSync(BUILTIN_TYPESCRIPT, copy, { recursive: true });
    const manifestPath = path.join(copy, 'atlas-lang.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest['project'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const outside = path.join(realPath(tmp.path), 'outside');
  fs.mkdirSync(outside);
  const env: Record<string, string> = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir };
  const runner = createRealRunner({ decide: allowAll });
  return {
    dir: repo.dir,
    tmp,
    repo,
    async cli(args) {
      const result = await runner.run({ executable: process.execPath, args: [CLI_BIN, ...args], cwd: outside, env });
      assert.equal(result.spawnError, undefined, 'the gsd-atlas bin must start');
      const stdout = decoder.decode(result.stdout);
      const stderr = decoder.decode(result.stderr);
      let envelope = {} as Envelope;
      if (stdout !== '') {
        assert.ok(stdout.endsWith('\n') && stdout.indexOf('\n') === stdout.length - 1, `stdout must be one JSON line, got ${JSON.stringify(stdout)}`);
        envelope = JSON.parse(stdout) as Envelope;
      }
      return { code: result.exitCode, stdout, stderr, envelope };
    },
    mcp() {
      const server = startMcp({ cwd: outside, env });
      started.push(server);
      return server;
    },
    async cleanup() {
      for (const server of started) await server.killAndStderr();
      started.length = 0;
      tmp.cleanup();
      repo.cleanup();
    },
  };
}

/** Run `body` over a fixture and always clean up; a failure carries the stderr of the last runs. */
export async function withEmitFixture(
  files: Readonly<Record<string, string>>,
  options: FixtureOptions,
  body: (fixture: Emitted) => Promise<void>,
): Promise<void> {
  const fixture = await makeEmitFixture(files, options);
  try {
    await body(fixture);
  } finally {
    await fixture.cleanup();
  }
}

// ---------------------------------------------------------------------------------------------
// The repository: src/lib.cts compiles to out/lib.cjs (ignored, untracked); consumer.cjs requires the built file.

export const TSCONFIG = JSON.stringify(
  { compilerOptions: { rootDir: 'src', outDir: 'out', module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' }, include: ['src/**/*.cts'] },
  null,
  2,
);

export const BASE_FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/lib.cts': 'export function compute(n: number): number {\n  return n + 1;\n}\n',
  'src/user.cts': "import { compute } from './lib.cjs';\nexport function twice(): number {\n  return compute(compute(1));\n}\n",
  'consumer.cjs': "const { compute } = require('./out/lib.cjs');\nfunction run() {\n  return compute(1);\n}\nmodule.exports = { run };\n",
};

const BUILT_OUTPUT = '"use strict";\nexports.compute = function compute(n) { return n + 1; };\n';

const BUILT: FixtureOptions = { ignored: ['out/'], working: { 'out/lib.cjs': BUILT_OUTPUT } };

describe('a .cjs requirer of the built output is a user of the .cts source (TSM-03 tracer)', () => {
  it('after build, impact and refs list consumer.cjs; the control without the project model does not', async () => {
    await withEmitFixture(BASE_FILES, BUILT, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);

      const impact = await fixture.cli(['impact', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      assert.equal(impact.code, 0, impact.stderr);
      assert.equal(impact.envelope.schema, 'gsd-atlas.code-impact/1');
      const hops = rows(impact.envelope).map((row) => `${String(row['hop'])}:${String(row['via'])}:${row.path}`);
      assert.ok(hops.includes('1:import:consumer.cjs'), `consumer.cjs is an importer at hop 1, got ${hops.join(', ')}`);
      assert.ok(hops.includes('1:import:src/user.cts'), `src/user.cts stays an importer, got ${hops.join(', ')}`);
      const importRow = rows(impact.envelope).find((row) => row.path === 'consumer.cjs' && row['via'] === 'import');
      assert.equal(importRow?.['confidence'], 'EXTRACTED', 'one candidate, so the edge is not INFERRED');

      const refs = await fixture.cli(['refs', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      assert.equal(refs.code, 0, refs.stderr);
      const refPaths = rows(refs.envelope).map((row) => row.path);
      assert.ok(refPaths.includes('consumer.cjs'), `the call site in consumer.cjs is a reference, got ${refPaths.join(', ')}`);
      assert.ok(refPaths.includes('src/user.cts'));
    });

    await withEmitFixture(BASE_FILES, { ...BUILT, withoutProjectBlock: true }, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);
      const impact = await fixture.cli(['impact', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      assert.equal(impact.code, 0, impact.stderr);
      const paths = rows(impact.envelope).map((row) => row.path);
      assert.ok(paths.includes('src/user.cts'), 'the control still finds the .cts importer');
      assert.ok(!paths.includes('consumer.cjs'), `the control (Phase 2 behaviour) does not link consumer.cjs, got ${paths.join(', ')}`);
    });
  });

  it('with no tsconfig the answers equal Phase 2 and nothing throws', async () => {
    const { 'tsconfig.json': _config, ...withoutConfig } = BASE_FILES;
    await withEmitFixture(withoutConfig, BUILT, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);
      const impact = await fixture.cli(['impact', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      assert.equal(impact.code, 0, impact.stderr);
      const paths = rows(impact.envelope).map((row) => row.path);
      assert.ok(paths.includes('src/user.cts'));
      assert.ok(!paths.includes('consumer.cjs'));
    });
  });

  it('over MCP the same request returns the same JSON as the CLI', async () => {
    await withEmitFixture(BASE_FILES, BUILT, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);
      let cli = await fixture.cli(['impact', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      for (let attempt = 0; attempt < 6 && isLate(cli.envelope); attempt += 1) {
        await pause(500);
        cli = await fixture.cli(['impact', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      }
      const server = fixture.mcp();
      await server.initialize();
      let call = await server.callTool('code_impact', { name: 'compute', path: 'src/lib.cts', repo: fixture.dir });
      for (let attempt = 0; attempt < 6 && isLate(call.envelope); attempt += 1) {
        await pause(500);
        call = await server.callTool('code_impact', { name: 'compute', path: 'src/lib.cts', repo: fixture.dir });
      }
      const text = call.result.content[0]?.text ?? '';
      assert.equal(maskNonce(cli.stdout.trimEnd()), maskNonce(text));
      assert.ok(rows(call.envelope).some((row) => row.path === 'consumer.cjs'));
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Task 3: a tracked build output gets no facts, a hand-written file beside it keeps its facts, emittedAs.

const TRACKED_OUTPUT_FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'lib', module: 'nodenext' }, include: ['src/**/*.cts'] }, null, 2),
  'src/a.cts': 'export function alpha(): number {\n  return 1;\n}\n',
  'lib/a.cjs': '"use strict";\nfunction alpha() {\n  return 1;\n}\nexports.alpha = alpha;\n',
  'lib/vendor.cjs': 'function vendorThing() {\n  return 2;\n}\nmodule.exports = { vendorThing };\n',
};

describe('a tracked build output gets no facts; hand-written files under the output directory keep theirs (OQ3)', () => {
  it('after build, find alpha returns the .cts definition and not the .cjs output, vendorThing is still found, and the file counts agree', async () => {
    await withEmitFixture(TRACKED_OUTPUT_FILES, {}, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);
      assert.equal((built.envelope.data as { files: number }).files, 2, 'src/a.cts and lib/vendor.cjs; lib/a.cjs is an output');

      const alpha = await fixture.cli(['find', 'alpha', '--repo', fixture.dir]);
      assert.equal(alpha.code, 0, alpha.stderr);
      assert.deepEqual(rows(alpha.envelope).map((row) => row.path), ['src/a.cts']);

      const vendor = await fixture.cli(['find', 'vendorThing', '--repo', fixture.dir]);
      assert.deepEqual(rows(vendor.envelope).map((row) => row.path), ['lib/vendor.cjs']);

      const status = await fixture.cli(['status', '--repo', fixture.dir, '--since', '24h']);
      assert.equal(status.code, 0, status.stderr);
      const store = (status.envelope.data as { tenant: { store: { worktrees: Array<{ files: number }> } } }).tenant.store;
      assert.equal(store.worktrees[0]?.files, 2, 'the file count leaves out the output and keeps the hand-written file');
    });

    await withEmitFixture(TRACKED_OUTPUT_FILES, { withoutProjectBlock: true }, async (fixture) => {
      await fixture.cli(['build', '--repo', fixture.dir]);
      const alpha = await fixture.cli(['find', 'alpha', '--repo', fixture.dir]);
      assert.deepEqual(rows(alpha.envelope).map((row) => row.path).sort(), ['lib/a.cjs', 'src/a.cts'], 'the control (Phase 2) indexes the output too');
    });
  });
});

describe('code_context emittedAs over the CLI and MCP (TSM-03)', () => {
  it('names the output of the file that defines the symbol, identically on both surfaces, and is absent for a .cjs symbol', async () => {
    await withEmitFixture(BASE_FILES, BUILT, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);
      let context = await fixture.cli(['context', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      for (let attempt = 0; attempt < 6 && isLate(context.envelope); attempt += 1) {
        await pause(500);
        context = await fixture.cli(['context', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      }
      assert.equal(context.code, 0, context.stderr);
      assert.deepEqual((context.envelope.data as { file?: unknown }).file, { path: 'src/lib.cts', emittedAs: ['out/lib.cjs'] });
      const plain = await fixture.cli(['context', 'run', '--repo', fixture.dir, '--path', 'consumer.cjs']);
      assert.equal(plain.code, 0, plain.stderr);
      assert.ok(!('file' in (plain.envelope.data as object)), 'a JavaScript file with no project model has no emittedAs');
      const find = await fixture.cli(['find', 'compute', '--repo', fixture.dir]);

      const server = fixture.mcp();
      await server.initialize();
      let viaMcp = await server.callTool('code_context', { name: 'compute', path: 'src/lib.cts', repo: fixture.dir });
      for (let attempt = 0; attempt < 6 && isLate(viaMcp.envelope); attempt += 1) {
        await pause(500);
        viaMcp = await server.callTool('code_context', { name: 'compute', path: 'src/lib.cts', repo: fixture.dir });
      }
      assert.equal(maskNonce(context.stdout.trimEnd()), maskNonce(viaMcp.result.content[0]?.text ?? ''), 'code_context: the CLI line equals the MCP text');
      assert.deepEqual((viaMcp.envelope.data as { file?: unknown }).file, { path: 'src/lib.cts', emittedAs: ['out/lib.cjs'] });
      const findViaMcp = await server.callTool('code_find', { name: 'compute', repo: fixture.dir });
      assert.equal(maskNonce(find.stdout.trimEnd()), maskNonce(findViaMcp.result.content[0]?.text ?? ''), 'code_find: the CLI line equals the MCP text');
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });

  it('a repository with no tsconfig has no emittedAs', async () => {
    const { 'tsconfig.json': _config, ...withoutConfig } = BASE_FILES;
    await withEmitFixture(withoutConfig, BUILT, async (fixture) => {
      await fixture.cli(['build', '--repo', fixture.dir]);
      const context = await fixture.cli(['context', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      assert.equal(context.code, 0, context.stderr);
      assert.ok(!('file' in (context.envelope.data as object)));
    });
  });
});
