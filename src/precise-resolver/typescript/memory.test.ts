/**
 * Bounded compiler memory (plan 03-27, D-21, D-22, TSM-05): the worker's own RSS sampler ends a process past its limit even
 * when its main thread is blocked, the parent maps every way a worker can die to `memory_budget` or `resolver_failed`, and a
 * project that was stopped for memory is not retried on every query. Real workers and the real compiler throughout; the
 * only scripted parts are the fixture that spins and a project compiler that kills itself.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, compilerWorkerShape, createRealRunner } from '../../command-runner/index.ts';
import type { CommandRunner, CommandSpec } from '../../command-runner/index.ts';
import { PROTOCOL_VERSION, ResolverFailure } from '../../facts/index.ts';
import type { Envelope, OverlaySnapshot, PreciseFacts, RefSiteKey, ResolutionContext, ResolvedEdge, ResolverNotice, SymbolLookup } from '../../facts/index.ts';
import { createGrammarEngine } from '../../grammar-engine/index.ts';
import { createHost } from '../../host/index.ts';
import { createManualEventSource } from '../../indexer/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../../test-kit/index.ts';
import { bundledCompilerDir, createTypeScriptResolver, resolveWorkerPath } from './index.ts';
import type { PreciseTier, TypeScriptResolver, TypeScriptResolverDeps, TypeScriptTierTuning } from './index.ts';

const WORKER = resolveWorkerPath();
const SPIN_FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'spin-alloc-worker.ts');
const MODULES = path.resolve(import.meta.dirname, '..', '..', '..', 'modules');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The exact worker shape, and a record of every worker the runner was asked to start. */
interface CountingRunner extends CommandRunner {
  readonly workers: CommandSpec[];
}

function countingRunner(): CountingRunner {
  const inner = createRealRunner({ builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER })] });
  const workers: CommandSpec[] = [];
  const note = (spec: CommandSpec): void => {
    if (spec.builtinId === 'typescript-resolver') workers.push(spec);
  };
  return {
    workers,
    run: (spec, ctx) => {
      note(spec);
      return inner.run(spec, ctx);
    },
    stream: (spec, ctx) => {
      note(spec);
      return inner.stream(spec, ctx);
    },
  };
}

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);
const LIB = 'export function compute(n: number): number {\n  return n + 1;\n}\n';
const USER = "import { compute } from './lib.cjs';\n\nexport function run(): number {\n  return compute(1);\n}\n";
const FIXTURE: Readonly<Record<string, string>> = { 'tsconfig.json': TSCONFIG, 'src/lib.cts': LIB, 'src/user.cts': USER };

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ startLine, startColumn, endLine, endColumn });
const NO_OVERLAY: OverlaySnapshot = { id: 'overlay-1', pathToHash: new Map() };
const contextOf = (id: string): ResolutionContext => ({ id, configHashes: [] });
const everything: SymbolLookup = {
  find: async () => [],
  findIn: async (p, name) => [{ repo: 'r', path: p, qualifiedName: name, kind: 'function', span: span(0, 0, 1000, 0) }],
};
/** `compute(1)` in `src/user.cts`: row 3 (0-based), column 9. */
const SITE: RefSiteKey = { path: 'src/user.cts', span: span(3, 9, 3, 16), name: 'compute' };

function factsFor(compiler: PreciseFacts['compiler'] = { source: 'bundled', version: '6.0.3', reason: 'no project compiler', case: 'none' }): PreciseFacts {
  return {
    ownerOf: (p) => (/\.[cm]?[jt]sx?$/.test(p) ? 'tsconfig.json' : undefined),
    requiresOwner: (p) => /\.(?:[cm]?ts|tsx)$/.test(p),
    compiler,
    configs: ['tsconfig.json'],
  };
}

function writeProject(files: Readonly<Record<string, string>>): { readonly dir: string; cleanup(): void } {
  const tmp = makeTempDir();
  const dir = realPath(tmp.path);
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return { dir, cleanup: () => tmp.cleanup() };
}

const cleanups: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function resolverFor(dir: string, runner: CommandRunner, deps: Partial<TypeScriptResolverDeps> = {}, facts: PreciseFacts = factsFor()): TypeScriptResolver {
  const resolver = createTypeScriptResolver({ runner, worktree: dir, project: () => facts, ...deps });
  cleanups.push(() => resolver.close());
  return resolver;
}

/** One read through the scoped call: the edges, or the typed failure it ended with. */
async function readOnce(
  resolver: TypeScriptResolver,
  contextId = 'ctx-1',
  facts: PreciseFacts = factsFor(),
): Promise<{ readonly edges: ResolvedEdge[]; readonly notices: ResolverNotice[]; readonly failure: ResolverFailure | undefined }> {
  const edges: ResolvedEdge[] = [];
  const notices: ResolverNotice[] = [];
  try {
    for await (const item of resolver.resolveScoped(facts, NO_OVERLAY, contextOf(contextId), [SITE], everything)) {
      if ('kind' in item && item.kind === 'notice') notices.push(item);
      else edges.push(item as ResolvedEdge);
    }
  } catch (error) {
    if (error instanceof ResolverFailure) return { edges, notices, failure: error };
    throw error;
  }
  return { edges, notices, failure: undefined };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitGone(pid: number, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (alive(pid)) {
    assert.ok(Date.now() < until, `process ${String(pid)} is still alive`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The sampler thread, alone.

describe('the RSS sampler thread (OQ2, research Pitfall 4)', () => {
  it('sampler ends a spinning worker: the main thread never yields, the process is gone quickly, the marker line is on stderr', async () => {
    const child = spawn(process.execPath, ['--max-old-space-size=512', SPIN_FIXTURE, '80', '50'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let spinningAt = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (spinningAt === 0 && chunk.includes('spinning')) spinningAt = Date.now();
    });
    const pid = child.pid;
    assert.ok(pid !== undefined);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
      const guard = setTimeout(() => {
        child.kill('SIGKILL');
      }, 20_000);
      child.on('close', (code, signal) => {
        clearTimeout(guard);
        resolve({ code, signal, at: Date.now() });
      });
    });
    assert.match(stderr, /^GSD_ATLAS_MEMORY_LIMIT rss=[0-9]+ limit=83886080$/m, stderr);
    if (process.platform === 'win32') assert.notEqual(exit.code, 0);
    else assert.equal(exit.signal, 'SIGKILL', `signal ${String(exit.signal)} code ${String(exit.code)}`);
    assert.ok(spinningAt > 0, 'the fixture reported that it was spinning');
    assert.ok(exit.at - spinningAt < 1000, `the process lived ${String(exit.at - spinningAt)} ms after it started spinning`);
    assert.equal(alive(pid), false, 'no orphan after a kill');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The client's mapping of every way a worker can end.

describe('the client maps how a worker ended (TSM-05)', () => {
  it('sampler limit below the compiler itself is memory_budget, with the sampler running and the process reaped', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner, { rssLimitMb: 60, sampleMs: 50 });
    const { edges, failure } = await readOnce(resolver);
    assert.equal(edges.length, 0);
    assert.equal(failure?.degradedCode, 'memory_budget', String(failure?.message));
    assert.equal(runner.workers.length, 1);
    assert.equal(resolver.info(), undefined, 'the worker that ended is not reported as running');
  });

  it('heap flag abort is memory_budget: V8 ends the process by itself, with no sampler', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner, { heapMb: 16, rssLimitMb: null });
    const { failure } = await readOnce(resolver);
    assert.equal(failure?.degradedCode, 'memory_budget', String(failure?.message));
    const [spec] = runner.workers;
    assert.deepStrictEqual(spec?.args.slice(0, 1), ['--max-old-space-size=16']);
  });

  it('external kill is resolver_failed: a SIGKILL that left no marker is a crash, not a memory stop', async () => {
    const code = [
      `const ts = require(${JSON.stringify(path.join(bundledCompilerDir(), 'lib', 'typescript.js'))});`,
      "const patched = () => { process.kill(process.pid, 'SIGKILL'); };",
      "module.exports = new Proxy(ts, { get: (target, name) => (name === 'createProgram' ? patched : target[name]) });",
      '',
    ].join('\n');
    const project = writeProject({
      ...FIXTURE,
      'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '6.0.2', main: './lib/typescript.js' }),
      'node_modules/typescript/lib/typescript.js': code,
    });
    cleanups.push(() => project.cleanup());
    const facts = factsFor({ source: 'project', version: '6.0.2', dir: 'node_modules/typescript', case: 'project-6' });
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner, {}, facts);
    const { failure } = await readOnce(resolver, 'ctx-1', facts);
    assert.equal(failure?.degradedCode, 'resolver_failed', String(failure?.message));
    // A crash is retried by the next read: it is not a memory stop and must not latch.
    const again = await readOnce(resolver, 'ctx-1', facts);
    assert.equal(again.failure?.degradedCode, 'resolver_failed');
    assert.equal(runner.workers.length, 2);
  });

  it('no orphan after a kill: a worker killed from outside is gone, and so is the one a read replaces', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner);
    const warm = await readOnce(resolver);
    assert.equal(warm.failure, undefined, String(warm.failure?.message));
    assert.equal(warm.edges.length, 1);
    const pid = resolver.info()?.pid;
    assert.ok(pid !== undefined);
    process.kill(pid, 'SIGKILL');
    await waitGone(pid);
    // The next read starts a fresh worker (a crash is not a latch), answers, and that worker is reaped on close.
    const next = await readOnce(resolver);
    assert.equal(next.failure, undefined, String(next.failure?.message));
    const second = resolver.info()?.pid;
    assert.ok(second !== undefined && second !== pid);
    await resolver.close();
    await waitGone(second);
    assert.equal(runner.workers.length, 2);
  });

  it('the production default always runs the sampler: the worker reports it, and a null limit is the only way to switch it off', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const resolver = resolverFor(project.dir, countingRunner());
    assert.equal((await readOnce(resolver)).failure, undefined);
    assert.equal(resolver.info()?.sampler, true);
    const bare = resolverFor(project.dir, countingRunner(), { rssLimitMb: null });
    assert.equal((await readOnce(bare)).failure, undefined);
    assert.equal(bare.info()?.sampler, false);
  });
});

describe('the memory-stop latch (TSM-05, T-03-272)', () => {
  it('latched until context changes: a stopped project answers memory_budget without starting a worker', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner, { rssLimitMb: 60, sampleMs: 50 });
    assert.equal((await readOnce(resolver, 'ctx-1')).failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 1);

    // The same context: answered at once, nothing started.
    for (let i = 0; i < 3; i += 1) assert.equal((await readOnce(resolver, 'ctx-1')).failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 1, 'a project too large for the budget costs one failed start, not one per query');

    // A changed context (a config or compiler change) is a new question.
    assert.equal((await readOnce(resolver, 'ctx-2')).failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 2);
    assert.equal((await readOnce(resolver, 'ctx-2')).failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 2);

    // An explicit ask clears it.
    resolver.clearMemoryStop();
    assert.equal((await readOnce(resolver, 'ctx-2')).failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 3);

    // A new tier (a Host restart) has no memory of it.
    await resolver.close();
    const fresh = resolverFor(project.dir, runner, { rssLimitMb: 60, sampleMs: 50 });
    assert.equal((await readOnce(fresh, 'ctx-2')).failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 4);
  });

  it('a healthy worker is not restarted by a changed context: nothing latches because nothing stopped', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner);
    assert.equal((await readOnce(resolver, 'ctx-1')).failure, undefined);
    assert.equal((await readOnce(resolver, 'ctx-2')).failure, undefined);
    assert.equal(runner.workers.length, 1, 'a changed context alone does not restart a healthy worker');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the Host: the read degrades, it does not fail.

interface World {
  ask(kind: string, args?: unknown): Promise<Envelope>;
  readonly runner: CountingRunner;
  readonly repoDir: string;
  write(rel: string, text: string): void;
  tier(): PreciseTier | undefined;
}

async function makeWorld(t: TestContext, precise: TypeScriptTierTuning): Promise<World> {
  const repo = await createTempGitRepo({ runner: createRealRunner({ decide: allowAll }), world: { committed: FIXTURE } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  const runner = countingRunner();
  let tier: PreciseTier | undefined;
  const host = createHost({
    roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: MODULES, npmRoots: [] },
    engine,
    runner,
    cwd: repo.dir,
    userDir: path.join(tmp.path, 'user'),
    cacheRoot: path.join(tmp.path, 'cache'),
    gitEnv: repo.envOverlay,
    eventSource: () => createManualEventSource().source,
    metrics: false,
    knownAdapters: ['typescript'],
    precise,
    tierHook: (built) => {
      tier = built;
    },
  });
  t.after(async () => {
    await host.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  const ask = (kind: string, args?: unknown): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, ...(args === undefined ? {} : { args }) });
  expectOk(await ask('build'));
  return { ask, runner, repoDir: repo.dir, write: (rel, text) => repo.write(rel, text), tier: () => tier };
}

function expectOk(envelope: Envelope): void {
  assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
}

const rowsOf = (envelope: Envelope): Array<{ path: string; tier: string }> => (envelope.data as { results: Array<{ path: string; tier: string }> }).results;

describe('a read over a project that does not fit (TSM-05, D-21)', () => {
  it('memory_budget degrades the read to grammar edges and says why, once per context', async (t) => {
    const world = await makeWorld(t, { rssLimitMb: 60, sampleMs: 50 });
    const first = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    expectOk(first);
    assert.ok((first.degraded ?? []).includes('memory_budget'), JSON.stringify(first.degraded));
    assert.equal((first.degraded ?? []).includes('resolver_failed'), false);
    const inUser = rowsOf(first).filter((row) => row.path === 'src/user.cts');
    assert.ok(inUser.length > 0 && inUser.every((row) => row.tier === 'grammar'), 'the grammar edges are still there');
    assert.equal(world.runner.workers.length, 1);

    // Every later read in the same context is answered without a second start.
    const second = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.ok((second.degraded ?? []).includes('memory_budget'));
    assert.equal(world.runner.workers.length, 1);

    // A config change is a changed context: the project gets one more attempt.
    world.write('tsconfig.json', TSCONFIG.replace('"strict": true', '"strict": false'));
    const third = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.ok((third.degraded ?? []).includes('memory_budget'));
    assert.equal(world.runner.workers.length, 2);
  });

  it('heap flag abort is memory_budget through the Host too', async (t) => {
    const world = await makeWorld(t, { heapMb: 16, rssLimitMb: null });
    const answer = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    expectOk(answer);
    assert.ok((answer.degraded ?? []).includes('memory_budget'), JSON.stringify(answer.degraded));
    assert.equal((answer.degraded ?? []).includes('resolver_failed'), false);
  });
});
