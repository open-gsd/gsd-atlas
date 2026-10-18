/**
 * Precise refs end to end (D-07, plan 03-23): the real `gsd-atlas` and `gsd-atlas-mcp` bins, started through the
 * CommandRunner in an isolated environment, over a temporary git repository with a `.cts` library, a user with an alias
 * import and a namespace member call, and an unrelated function of the same name. The precise tier is the one the
 * TypeScript module's manifest names; nothing here wires a test hook.
 *
 * It lives under scripts because the adapter lint forbids src/cli tests from importing any module but host-client.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';

import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';
import { CLI_BIN, maskNonce } from './test-helpers/fixture-repo.ts';
import { startMcp } from './test-helpers/mcp-client.ts';
import type { McpClient } from './test-helpers/mcp-client.ts';

const decoder = new TextDecoder();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);

const FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/lib.cts': 'export function compute(n: number): number {\n  return n + 1;\n}\n',
  'src/user.cts': [
    "import { compute } from './lib.cjs';",
    "import { compute as calc } from './lib.cjs';",
    "import * as lib from './lib.cjs';",
    "import * as other from './other.cjs';",
    '',
    'export function run(): number {',
    '  return compute(1) + calc(2) + other.compute(3);',
    '}',
    '',
    'export const keep = lib;',
    '',
  ].join('\n'),
  'src/other.cts': 'export function compute(n: number): number {\n  return n * 2;\n}\n',
};

interface Row {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly tier: string;
  readonly confidence: string;
  readonly [key: string]: unknown;
}

interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly degraded?: readonly string[];
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly [key: string]: unknown;
}

const rowsOf = (envelope: Envelope): Row[] => (envelope.data as { results: Row[] }).results;
const inUser = (envelope: Envelope): Row[] => rowsOf(envelope).filter((row) => row.path === 'src/user.cts');

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Envelope;
}

interface Fixture {
  readonly dir: string;
  readonly tmp: TempDir;
  readonly repo: TempGitRepo;
  cli(args: readonly string[]): Promise<Run>;
  mcp(): McpClient;
  cleanup(): Promise<void>;
}

/** A compiler wrapper for a project `typescript` package that records the worker's pid when it is loaded. */
function pidRecordingCompiler(pidFile: string): Record<string, string> {
  const bundled = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'lib', 'typescript.js');
  return {
    'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '6.0.2', main: './lib/typescript.js' }),
    'node_modules/typescript/lib/typescript.js': `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nmodule.exports = require(${JSON.stringify(bundled)});\n`,
  };
}

async function makeFixture(files: Readonly<Record<string, string>> = FILES, extra: { working?: Record<string, string>; ignored?: string[] } = {}): Promise<Fixture> {
  const setup = createRealRunner({ decide: allowAll });
  const tmp = makeTempDir();
  const started: McpClient[] = [];
  const repo = await createTempGitRepo({
    runner: setup,
    world: { committed: files, ...(extra.working === undefined ? {} : { working: extra.working }), ...(extra.ignored === undefined ? {} : { ignored: extra.ignored }) },
  });
  const outside = path.join(realPath(tmp.path), 'outside');
  fs.mkdirSync(outside);
  const env: Record<string, string> = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: path.join(tmp.path, 'user') };
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

async function withFixture(fixture: Fixture, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  try {
    await body(fixture);
  } finally {
    await fixture.cleanup();
  }
}

/** `code_refs` through the MCP client, up to `reads` times, until an answer has no `resolver_timeout`. */
async function refsOverMcp(server: McpClient, fixture: Fixture, reads = 4): Promise<{ readonly call: Awaited<ReturnType<McpClient['callTool']>>; readonly reads: number }> {
  for (let read = 1; ; read += 1) {
    const call = await server.callTool('code_refs', { name: 'compute', path: 'src/lib.cts', repo: fixture.dir });
    const timedOut = (call.envelope.degraded ?? []).includes('resolver_timeout');
    if (!timedOut || read >= reads) return { call, reads: read };
    await sleep(500);
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < until, `timed out waiting for ${what}`);
    await sleep(50);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const GATE = path.resolve(import.meta.dirname, 'precise-gate.ts');

/** The shape of the single JSON object `precise-gate.ts --trace` prints. */
interface Trace {
  readonly corpus: string;
  readonly config: string;
  readonly ownerConfig: string | null;
  readonly compiler: { readonly source: string; readonly version: string };
  readonly firstPreciseMs: number | null;
  readonly reads: number;
  readonly refs: { readonly total: number; readonly EXTRACTED: number; readonly INFERRED: number };
  readonly rssMb: number | null;
  readonly stats: {
    readonly sites: { readonly asked: number; readonly answered: number };
    readonly byKind: Record<string, { readonly asked: number; readonly edges: number; readonly dropped: number }>;
  };
  readonly identity: { readonly asked: number; readonly edges: number; readonly ratio: number | null; readonly byKind: Record<string, number | null> };
  readonly limits: { readonly firstPreciseMs: number; readonly rssMb: number };
  readonly withinLimits: boolean;
  readonly ok: boolean;
}

/** The part of gsd-core the trace asks about: `compareSemverCore` in `src/semver-compare.cts`, called from another file. */
const SEMVER_FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/semver-compare.cts': 'export function compareSemverCore(a: string, b: string): number {\n  return a < b ? -1 : a > b ? 1 : 0;\n}\n',
  'src/caller.cts': "import { compareSemverCore } from './semver-compare.cjs';\nexport function newest(a: string, b: string): string {\n  return compareSemverCore(a, b) >= 0 ? a : b;\n}\n",
};

describe('the gsd-core trace (scripts/precise-gate.ts --trace)', () => {
  async function trace(fixture: Fixture, extra: readonly string[] = []): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly trace: Trace }> {
    const runner = createRealRunner({ decide: allowAll });
    const result = await runner.run(
      { executable: process.execPath, args: [GATE, '--trace', '--corpus', 'gsd-core', '--dir', fixture.dir, ...extra], cwd: fixture.dir, env: { ...fixture.repo.envOverlay, GSD_ATLAS_USER_DIR: path.join(fixture.tmp.path, 'user') } },
      {},
    );
    assert.equal(result.spawnError, undefined);
    const stdout = decoder.decode(result.stdout);
    return { code: result.exitCode, stdout, stderr: decoder.decode(result.stderr), trace: (stdout === '' ? {} : JSON.parse(stdout)) as Trace };
  }

  it('prints one JSON object with the owner config, compiler, first precise time, refs, rss and per-kind statistics, and exits 0 on a precise record', async () => {
    await withFixture(await makeFixture(SEMVER_FILES), async (fixture) => {
      const run = await trace(fixture);
      assert.ok(run.stdout.endsWith('\n') && run.stdout.indexOf('\n') === run.stdout.length - 1, `one JSON line, got ${run.stdout}`);
      assert.equal(run.code, 0, run.stderr);
      const { trace: out } = run;
      assert.equal(out.corpus, 'gsd-core');
      assert.equal(out.config, 'tsconfig.json');
      assert.equal(out.ownerConfig, 'tsconfig.json');
      assert.deepStrictEqual(out.compiler, { source: 'bundled', version: '6.0.3' });
      assert.equal(typeof out.firstPreciseMs, 'number');
      assert.ok(out.reads >= 1);
      assert.ok(out.refs.EXTRACTED >= 1, JSON.stringify(out.refs));
      assert.equal(out.refs.total, out.refs.EXTRACTED + out.refs.INFERRED);
      assert.equal(typeof out.rssMb, 'number');
      assert.ok(out.stats.sites.asked >= 1);
      assert.equal(out.stats.byKind['FunctionDeclaration']?.edges, 1);
      assert.equal(out.identity.byKind['FunctionDeclaration'], 1);
      assert.equal(out.identity.ratio, 1);
      assert.deepStrictEqual(out.limits, { firstPreciseMs: 30000, rssMb: 1024 });
      assert.equal(out.withinLimits, true);
      assert.equal(out.ok, true);
    });
  });

  it('exits 1 when no precise record exists for compareSemverCore (a checkout with no tsconfig)', async () => {
    const { 'tsconfig.json': _config, ...withoutConfig } = SEMVER_FILES;
    await withFixture(await makeFixture(withoutConfig), async (fixture) => {
      const run = await trace(fixture);
      assert.equal(run.code, 1, run.stderr);
      assert.equal(run.trace.ok, false);
      assert.equal(run.trace.ownerConfig, null);
      assert.equal(run.trace.refs.EXTRACTED, 0);
    });
  });

  it('refuses an unknown corpus, a missing mode and a directory that is not a checkout with usage exit 2', async () => {
    const runner = createRealRunner({ decide: allowAll });
    for (const args of [['--trace', '--corpus', 'nosuch', '--dir', '/nonexistent'], ['--corpus', 'gsd-core'], ['--trace', '--corpus', 'gsd-core', '--dir', '/nonexistent']]) {
      const result = await runner.run({ executable: process.execPath, args: [GATE, ...args] });
      assert.equal(result.exitCode, 2, decoder.decode(result.stderr));
      assert.equal(decoder.decode(result.stdout), '');
    }
  });
});

describe('precise refs over the real stdio server (D-07)', () => {
  it('precise refs over MCP: the first answer may be degraded, a later one is precise and EXTRACTED', async () => {
    await withFixture(await makeFixture(), async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);
      const server = fixture.mcp();
      await server.initialize();
      const { call, reads } = await refsOverMcp(server, fixture);
      assert.ok(reads <= 4, 'a precise answer within four calls');
      const envelope = call.envelope as unknown as Envelope;
      assert.equal(envelope.ok, true);
      const rows = inUser(envelope);
      assert.equal(rows.length, 2, JSON.stringify(rowsOf(envelope)));
      for (const row of rows) {
        assert.equal(row.tier, 'precise');
        assert.equal(row.confidence, 'EXTRACTED');
      }
      for (const code of envelope.degraded ?? []) assert.equal(code, 'compiler_fallback', `unexpected degraded code ${code}`);
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });

  it('CLI and MCP parity: the same request returns the same JSON, answer_id aside', async () => {
    await withFixture(await makeFixture(), async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      // Warm the cache through one server (the writer), then end it: the resolved edges stay in the store.
      const warm = fixture.mcp();
      await warm.initialize();
      await refsOverMcp(warm, fixture);
      assert.equal((await warm.close()).exitCode, 0, warm.stderrText());
      // Two fresh processes of the same role now answer the same question from the same store.
      const cli = await fixture.cli(['refs', 'compute', '--repo', fixture.dir, '--path', 'src/lib.cts']);
      assert.equal(cli.code, 0, cli.stderr);
      const server = fixture.mcp();
      await server.initialize();
      const call = await server.callTool('code_refs', { name: 'compute', path: 'src/lib.cts', repo: fixture.dir });
      const text = call.result.content[0]?.text ?? '';
      assert.equal(maskNonce(cli.stdout.trimEnd()), maskNonce(text));
      assert.ok(inUser(cli.envelope).every((row) => row.tier === 'precise'));
      assert.equal(inUser(cli.envelope).length, 2);
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });

  it('broken tsconfig degrades: grammar-tier answer with precise_unavailable, no crash and no worker start', async () => {
    const tmpPid = makeTempDir();
    const marker = path.join(tmpPid.path, 'worker.pid');
    const fixture = await makeFixture({ ...FILES, 'tsconfig.json': '{ "compilerOptions": ', '.gitignore': 'node_modules/\n' }, { working: pidRecordingCompiler(marker), ignored: ['node_modules/'] });
    try {
      await withFixture(fixture, async (f) => {
        assert.equal((await f.cli(['build', '--repo', f.dir])).code, 0);
        const server = f.mcp();
        await server.initialize();
        const { call } = await refsOverMcp(server, f);
        const envelope = call.envelope as unknown as Envelope;
        assert.equal(envelope.ok, true);
        assert.ok((envelope.degraded ?? []).includes('precise_unavailable'), JSON.stringify(envelope.degraded));
        assert.ok(inUser(envelope).length > 0);
        assert.ok(inUser(envelope).every((row) => row.tier === 'grammar'));
        assert.equal(fs.existsSync(marker), false, 'no worker was started');
        const exit = await server.close();
        assert.equal(exit.exitCode, 0, server.stderrText());
      });
    } finally {
      tmpPid.cleanup();
    }
  });

  it('parent killed leaves no worker: the worker exits by itself when its host dies', async () => {
    const tmpPid = makeTempDir();
    const marker = path.join(tmpPid.path, 'worker.pid');
    const fixture = await makeFixture({ ...FILES, '.gitignore': 'node_modules/\n' }, { working: pidRecordingCompiler(marker), ignored: ['node_modules/'] });
    try {
      await withFixture(fixture, async (f) => {
        assert.equal((await f.cli(['build', '--repo', f.dir])).code, 0);
        const server = f.mcp();
        await server.initialize();
        await refsOverMcp(server, f);
        await waitFor(() => fs.existsSync(marker), 'the worker to record its pid');
        const pid = Number(fs.readFileSync(marker, 'utf8'));
        assert.ok(Number.isInteger(pid) && pid > 0);
        assert.equal(alive(pid), true, 'the worker runs while its host runs');
        server.kill();
        await server.exit();
        // The grace period is 2 s; the worker leaves on its own as soon as its stdin closes.
        await waitFor(() => !alive(pid), 'the worker to exit after its host was killed', 12000);
      });
    } finally {
      tmpPid.cleanup();
    }
  });
});
