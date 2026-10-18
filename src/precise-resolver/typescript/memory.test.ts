/**
 * Bounded compiler memory (plan 03-27, D-21, D-22, TSM-05): the worker's own RSS sampler ends a process past its limit even
 * when its main thread is blocked, the parent maps every way a worker can die to `memory_budget` or `resolver_failed`, and a
 * project that was stopped for memory is not retried on every query. Real workers and the real compiler throughout; the
 * only scripted parts are the fixture that spins and a project compiler that kills itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { COMPILER_WORKER_ID, allowAll, compilerWorkerShape, createAsyncQueue, createRealRunner } from '../../command-runner/index.ts';
import type { CommandRunner, CommandSpec } from '../../command-runner/index.ts';
import { PROTOCOL_VERSION, ResolverFailure } from '../../facts/index.ts';
import type { Envelope, OverlaySnapshot, PreciseFacts, RefSiteKey, ResolutionContext, ResolvedEdge, ResolverNotice, SymbolLookup } from '../../facts/index.ts';
import { createGrammarEngine } from '../../grammar-engine/index.ts';
import { createHost } from '../../host/index.ts';
import { createManualEventSource } from '../../indexer/index.ts';
import { FakeClock, createTempGitRepo, makeTempDir, realPath } from '../../test-kit/index.ts';
import { PROGRAM_EVICT_FRACTION, createMemoryBudget } from './budget.ts';
import { bundledCompilerDir, createResolverMemory, createTypeScriptResolver, resolveWorkerPath } from './index.ts';
import { createWorkerPool } from './pool.ts';
import type { PoolWorker } from './pool.ts';
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
    // The fixture is started as the exact worker shape, through the runner, like every other process.
    const runner = createRealRunner({ builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: SPIN_FIXTURE })] });
    const input = createAsyncQueue<string>();
    const stream = runner.stream(
      {
        executable: process.execPath,
        args: ['--max-old-space-size=512', SPIN_FIXTURE],
        builtinId: COMPILER_WORKER_ID,
        env: { GSD_ATLAS_WORKER: '1' },
        cwd: import.meta.dirname,
        stdin: input,
        maxStdoutBytes: 1_000_000,
      },
      { repo: import.meta.dirname },
    );
    let spinningAt = 0;
    let pid: number | undefined;
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream.stdout) {
        const match = /spinning ([0-9]+)/.exec(decoder.decode(chunk));
        if (match !== null && spinningAt === 0) {
          spinningAt = Date.now();
          pid = Number(match[1]);
        }
      }
    })();
    input.push('80 50\n');
    // A guard so a sampler that failed cannot leave a runaway allocator behind.
    const guard = setTimeout(() => {
      stream.kill();
    }, 20_000);
    const result = await stream.result;
    const endedAt = Date.now();
    clearTimeout(guard);
    await reading;
    const stderr = new TextDecoder().decode(result.stderr);
    assert.match(stderr, /^GSD_ATLAS_MEMORY_LIMIT rss=[0-9]+ limit=83886080$/m, stderr);
    if (process.platform === 'win32') assert.notEqual(result.exitCode, 0);
    else assert.equal(result.signal, 'SIGKILL', `signal ${String(result.signal)} code ${String(result.exitCode)}`);
    assert.ok(spinningAt > 0 && pid !== undefined, 'the fixture reported that it was spinning');
    assert.ok(endedAt - spinningAt < 1000, `the process lived ${String(endedAt - spinningAt)} ms after it started spinning`);
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

    // A config change (here a changed `include`) is a changed context: the project gets one more attempt.
    world.write('tsconfig.json', TSCONFIG.replace('"src"', '"src", "extra"'));
    // A config is not an indexed file, so a source edit moves the snapshot and the context is read afresh.
    world.write('src/lib.cts', `// edited\n${LIB}`);
    expectOk(await world.ask('maintain', { task: 'reconcile' }));
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

// ---------------------------------------------------------------------------------------------------------------------
// Task 2: the machine-wide pool, with a fake worker factory (no process).

interface FakeWorker extends PoolWorker {
  readonly tenant: string;
  alive: boolean;
}

const MB = 1024 * 1024;

function makePool(options: { readonly totalMb?: number; readonly workerMb?: number; readonly idleExitMs?: number } = {}) {
  const clock = new FakeClock(0);
  // 25 percent of the RAM is the budget: 4000 MB of RAM is a 1000 MB budget.
  const budget = createMemoryBudget({ totalMemBytes: (options.totalMb ?? 4000) * MB });
  const started: string[] = [];
  const stopped: string[] = [];
  let alive = 0;
  let mostAlive = 0;
  const pool = createWorkerPool<FakeWorker>({
    budget,
    clock,
    workerMb: options.workerMb ?? 400,
    ...(options.idleExitMs === undefined ? {} : { idleExitMs: options.idleExitMs }),
    start: async (tenant) => {
      started.push(tenant);
      alive += 1;
      mostAlive = Math.max(mostAlive, alive);
      const worker: FakeWorker = {
        tenant,
        alive: true,
        async stop() {
          if (!worker.alive) return;
          worker.alive = false;
          alive -= 1;
          stopped.push(tenant);
        },
      };
      return worker;
    },
  });
  return { pool, budget, clock, started, stopped, mostAlive: () => mostAlive };
}

const isMemoryBudget = (error: unknown): boolean => error instanceof ResolverFailure && error.degradedCode === 'memory_budget';

describe('the machine-wide worker pool (D-21, TSM-05)', () => {
  it('evicts least recently used idle worker: no more than two exist, and an evicted tenant restarts on demand', async () => {
    const { pool, started, stopped, mostAlive } = makePool();
    for (const tenant of ['A', 'B']) {
      await pool.acquire(tenant);
      pool.release(tenant);
    }
    await pool.acquire('C');
    pool.release('C');
    assert.deepStrictEqual(stopped, ['A'], 'A was used earliest');
    // A comes back: B is now the least recently used.
    const again = await pool.acquire('A');
    pool.release('A');
    assert.equal(again.alive, true);
    assert.deepStrictEqual(stopped, ['A', 'B']);
    assert.deepStrictEqual(started, ['A', 'B', 'C', 'A'], 'the eviction cost A one cold start');
    assert.equal(mostAlive(), 2);
    assert.deepStrictEqual(pool.status().workers.map((entry) => entry.tenant).sort(), ['A', 'C']);
  });

  it('a worker that is acquired again is the most recently used, even when it was started first', async () => {
    const { pool, stopped } = makePool();
    await pool.acquire('A');
    pool.release('A');
    await pool.acquire('B');
    pool.release('B');
    await pool.acquire('A');
    pool.release('A');
    await pool.acquire('C');
    pool.release('C');
    assert.deepStrictEqual(stopped, ['B']);
  });

  it('in-flight worker is not evicted: the newcomer is answered memory_budget and nothing is stopped', async () => {
    const { pool, started, stopped } = makePool();
    await pool.acquire('A');
    await pool.acquire('B');
    await assert.rejects(pool.acquire('C'), isMemoryBudget);
    assert.deepStrictEqual(stopped, []);
    assert.deepStrictEqual(started, ['A', 'B']);
    pool.release('B');
    await pool.acquire('C');
    assert.deepStrictEqual(stopped, ['B'], 'once B is idle it can go');
    assert.deepStrictEqual(pool.status().workers.map((entry) => entry.tenant).sort(), ['A', 'C']);
  });

  it('budget too small starts nothing: every tenant is answered memory_budget and no worker starts', async () => {
    const { pool, started } = makePool({ totalMb: 1024 });
    for (const tenant of ['A', 'B', 'C']) await assert.rejects(pool.acquire(tenant), isMemoryBudget);
    assert.deepStrictEqual(started, []);
    assert.equal(pool.status().usable, false);
  });

  it('a request larger than the whole budget is memory_budget even for an empty pool', async () => {
    const { pool, started } = makePool({ workerMb: 1001 });
    await assert.rejects(pool.acquire('A'), isMemoryBudget);
    assert.deepStrictEqual(started, []);
  });

  it('a failed start gives its reservation back and the error reaches the caller', async () => {
    const clock = new FakeClock(0);
    const budget = createMemoryBudget({ totalMemBytes: 4000 * MB });
    const pool = createWorkerPool<FakeWorker>({
      budget,
      clock,
      workerMb: 400,
      start: async () => {
        throw new Error('no start');
      },
    });
    await assert.rejects(pool.acquire('A'), /no start/);
    assert.equal(budget.status().reservedMb, 0);
  });

  it('idle release and restart: a worker idle for precise.idleExitMs is stopped, a request just before the deadline resets the timer', async () => {
    const { pool, clock, started, stopped, budget } = makePool({ idleExitMs: 300_000 });
    await pool.acquire('A');
    pool.release('A');
    await clock.advance(299_999);
    assert.deepStrictEqual(stopped, [], 'not yet');
    await pool.acquire('A');
    pool.release('A');
    await clock.advance(299_999);
    assert.deepStrictEqual(stopped, [], 'the request at the deadline started the wait again');
    assert.deepStrictEqual(started, ['A'], 'and it reused the worker');
    await clock.advance(1);
    await sleep(0);
    assert.deepStrictEqual(stopped, ['A']);
    assert.equal(budget.status().reservedMb, 0, 'its share of the budget is free again');
    assert.deepStrictEqual(pool.status().workers, []);
    await pool.acquire('A');
    assert.deepStrictEqual(started, ['A', 'A'], 'the next request restarts it');
  });

  it('a busy worker has no idle timer, and close stops everything and leaves no timer armed', async () => {
    const { pool, clock, stopped } = makePool({ idleExitMs: 1000 });
    await pool.acquire('A');
    await clock.advance(5000);
    await sleep(0);
    assert.deepStrictEqual(stopped, [], 'a request is in flight');
    pool.release('A');
    await pool.acquire('B');
    pool.release('B');
    assert.ok(clock.pending() > 0);
    await pool.close();
    assert.deepStrictEqual(stopped.sort(), ['A', 'B']);
    assert.equal(clock.pending(), 0, 'every timer was cancelled');
    await pool.close();
    await assert.rejects(pool.acquire('A'), isMemoryBudget);
  });

  it('a worker that ended by itself is dropped at release and does not hold the budget', async () => {
    const { pool, budget } = makePool();
    const worker = await pool.acquire('A');
    worker.alive = false;
    pool.release('A');
    assert.equal(budget.status().reservedMb, 0);
    assert.deepStrictEqual(pool.status().workers, []);
  });

  it('a request the running worker was not started for replaces it', async () => {
    const { pool, started, stopped } = makePool();
    const first = await pool.acquire('A', { matches: () => true });
    pool.release('A');
    const second = await pool.acquire('A', { matches: () => false });
    pool.release('A');
    assert.notEqual(first, second);
    assert.deepStrictEqual(stopped, ['A']);
    assert.deepStrictEqual(started, ['A', 'A']);
    assert.equal(pool.status().reservedMb, 400, 'one reservation for the one worker');
  });

  it('the memory-stop latch is per tenant and per context key', async () => {
    const { pool } = makePool();
    assert.equal(pool.memoryStopped('A', 'k1'), false);
    pool.markMemoryStop('A', 'k1');
    assert.equal(pool.memoryStopped('A', 'k1'), true);
    assert.equal(pool.memoryStopped('B', 'k1'), false, 'another tenant is not affected');
    assert.equal(pool.memoryStopped('A', 'k2'), false, 'a changed context is a new question');
    assert.equal(pool.memoryStopped('A', 'k1'), false, 'and it cleared the latch');
    pool.markMemoryStop('A', 'k1');
    pool.markMemoryStop('B', 'k1');
    pool.clearMemoryStop('A');
    assert.equal(pool.memoryStopped('A', 'k1'), false);
    assert.equal(pool.memoryStopped('B', 'k1'), true);
    pool.clearMemoryStop();
    assert.equal(pool.memoryStopped('B', 'k1'), false);
  });

  it('drop ends a tenant: its worker is stopped, its share freed and its latch forgotten', async () => {
    const { pool, stopped, budget } = makePool();
    await pool.acquire('A');
    pool.release('A');
    pool.markMemoryStop('A', 'k');
    await pool.drop('A');
    assert.deepStrictEqual(stopped, ['A']);
    assert.equal(budget.status().reservedMb, 0);
    assert.equal(pool.memoryStopped('A', 'k'), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 2: real workers on the pool.

const MULTI = ['a', 'b', 'c'] as const;
const MULTI_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  MULTI.flatMap((dir) => [
    [`${dir}/tsconfig.json`, TSCONFIG],
    [`${dir}/src/lib.cts`, LIB],
    [`${dir}/src/user.cts`, USER],
  ]),
);
const MULTI_FACTS: PreciseFacts = {
  ownerOf: (p) => (MULTI.some((dir) => p.startsWith(`${dir}/`)) ? `${p.split('/')[0] ?? ''}/tsconfig.json` : undefined),
  requiresOwner: (p) => /\.(?:[cm]?ts|tsx)$/.test(p),
  compiler: { source: 'bundled', version: '6.0.3', reason: 'no project compiler', case: 'none' },
  configs: MULTI.map((dir) => `${dir}/tsconfig.json`),
};
const multiSite = (dir: string): RefSiteKey => ({ path: `${dir}/src/user.cts`, span: span(3, 9, 3, 16), name: 'compute' });

async function readDir(resolver: TypeScriptResolver, dir: string): Promise<number> {
  const edges: unknown[] = [];
  for await (const item of resolver.resolveScoped(MULTI_FACTS, NO_OVERLAY, contextOf('multi'), [multiSite(dir)], everything)) {
    if (!('kind' in item && item.kind === 'notice')) edges.push(item);
  }
  return edges.length;
}

describe('programs inside one worker (Pitfall 8, plan 03-27)', () => {
  it('programs dropped least recently used: past 70 percent of the limit the oldest go, the one in use stays, every answer is right', async () => {
    const project = writeProject(MULTI_FILES);
    cleanups.push(() => project.cleanup());
    // The sampler is switched off by its period (an hour) so that only the program rule is under test.
    const quiet = { sampleMs: 3_600_000 };

    // Calibrate on this machine: the worker's RSS after one, two and three programs, with a limit nothing reaches.
    const calibrate = resolverFor(project.dir, countingRunner(), { ...quiet, rssLimitMb: 16_384 }, MULTI_FACTS);
    const rss: number[] = [];
    for (const dir of MULTI) {
      assert.equal(await readDir(calibrate, dir), 1);
      rss.push(calibrate.info()?.lastRssMb ?? 0);
    }
    assert.equal(calibrate.info()?.programs, 3, 'with room, every program stays');
    await calibrate.close();
    const [, two, three] = rss;
    assert.ok(two !== undefined && three !== undefined && three > two, JSON.stringify(rss));
    // Two programs are under 70 percent of the limit, the third is over it.
    const limitMb = Math.ceil((two + three) / 2 / PROGRAM_EVICT_FRACTION);

    const bounded = resolverFor(project.dir, countingRunner(), { ...quiet, rssLimitMb: limitMb }, MULTI_FACTS);
    const seen: number[] = [];
    for (const dir of ['a', 'b', 'c', 'a']) {
      assert.equal(await readDir(bounded, dir), 1, `config ${dir} answered`);
      seen.push(bounded.info()?.programs ?? -1);
    }
    const detail = JSON.stringify({ seen, rss, limitMb });
    assert.ok(seen.every((count) => count >= 1 && count <= 2), detail);
    assert.ok(seen.some((count, index) => index > 0 && count <= (seen[index - 1] ?? 0)), `a program was dropped: ${detail}`);
  });

  it('a worker started without a limit never drops a program', async () => {
    const project = writeProject(MULTI_FILES);
    cleanups.push(() => project.cleanup());
    const resolver = resolverFor(project.dir, countingRunner(), { rssLimitMb: null }, MULTI_FACTS);
    for (const dir of MULTI) assert.equal(await readDir(resolver, dir), 1);
    assert.equal(resolver.info()?.programs, 3);
  });
});

describe('many tenants on one Host memory (TSM-05, D-21)', () => {
  it('one pool per host: two tenants share the budget, the second evicts the first, and the first restarts cold with right answers', async () => {
    const one = writeProject(FIXTURE);
    const two = writeProject(FIXTURE);
    cleanups.push(() => one.cleanup(), () => two.cleanup());
    // 4 GiB of RAM: a 1024 MB budget, and a worker is given the whole of it, so only one worker lives at a time.
    const memory = createResolverMemory({ totalMemBytes: 4 * 1024 * MB });
    cleanups.push(() => memory.pool.close());
    const runner = countingRunner();
    const first = resolverFor(one.dir, runner, { memory });
    const second = resolverFor(two.dir, runner, { memory });

    assert.equal((await readOnce(first)).edges.length, 1);
    const firstPid = first.info()?.pid;
    assert.ok(firstPid !== undefined);
    assert.equal((await readOnce(second)).edges.length, 1);
    await waitGone(firstPid);
    assert.equal(first.info(), undefined, 'the first tenant has no worker now');
    assert.equal(memory.pool.status().workers.length, 1);

    const again = await readOnce(first);
    assert.equal(again.failure, undefined);
    assert.equal(again.edges.length, 1, 'the cold start cost time, not correctness');
    assert.equal(runner.workers.length, 3);
    assert.equal(memory.pool.status().workers.length, 1);
    assert.equal(memory.pool.status().reservedMb <= memory.budget.derived.budgetMb, true);

    // Closing one tenant frees its share without touching the shared pool.
    await first.close();
    assert.deepStrictEqual(memory.pool.status().workers, []);
    assert.equal((await readOnce(second)).edges.length, 1, 'the other tenant is unaffected');
  });

  it('budget too small starts nothing: a machine below the floor answers memory_budget and never spawns a worker', async () => {
    const project = writeProject(FIXTURE);
    cleanups.push(() => project.cleanup());
    const runner = countingRunner();
    const resolver = resolverFor(project.dir, runner, { totalMemBytes: 1024 * MB });
    const { failure, edges } = await readOnce(resolver);
    assert.equal(edges.length, 0);
    assert.equal(failure?.degradedCode, 'memory_budget');
    assert.equal(runner.workers.length, 0);
  });
});
