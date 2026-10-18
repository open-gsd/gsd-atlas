/**
 * The TypeScript PreciseResolver (plan 03-23, D-07): a killable compiler worker started through the CommandRunner, a
 * request/response protocol over its stdin and stdout, and the identity mapping from compiler declarations to the grammar
 * tier's symbols.
 *
 * - One worker per worktree, started lazily with the exact built-in shape of plan 03-19 (the heap flag, the worker path
 *   and `GSD_ATLAS_WORKER=1` are all it may carry; the compiler's location travels in the first stdin message).
 * - Requests are sent one at a time, grouped by owner config, at most `precise.sitesPerRequest` sites each. Every
 *   response line is validated and size-capped; a protocol violation kills the worker.
 * - Edges are yielded in request order after the worker answered, so the order is deterministic. A target is kept only
 *   when `symbols.findIn` maps it to exactly one grammar symbol (identity.ts).
 * - A worker that exits without answering is a typed failure: `memory_budget` for an out-of-memory abort, otherwise
 *   `resolver_failed` (the store maps a thrown `ResolverFailure` to its code). The next call starts a fresh worker.
 * - The worker's stderr is read only to classify an abort and is never forwarded (T-03-234).
 */
import os from 'node:os';
import type { CommandRunner, CommandSpec, CommandStream } from '../../command-runner/index.ts';
import { COMPILER_WORKER_ID, createAsyncQueue } from '../../command-runner/index.ts';
import { ResolverFailure, isResolverNotice, symbolKey } from '../../facts/index.ts';
import type {
  Clock,
  DegradedCode,
  OverlaySnapshot,
  PreciseFacts,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  ResolvedRelation,
  ResolverNotice,
  SymbolIdentity,
  SymbolLookup,
} from '../../facts/index.ts';
import type { PreciseResolver } from '../index.ts';
import { MEMORY_DEFAULTS, createMemoryBudget, deriveBudget } from './budget.ts';
import type { MemoryBudget, MemoryBudgetConfig } from './budget.ts';
import { bundledCompilerDir, compilerForRequest } from './compiler.ts';
import type { CompilerRequest } from './compiler.ts';
import { countDeclaration, createStats, mapTarget } from './identity.ts';
import type { Stats } from './identity.ts';
import { PRECISE_LIMITS, PROTOCOL_VERSION, encodeRequest, parseResponse } from './protocol.ts';
import type { Request, Response, Target } from './protocol.ts';
import { createWorkerPool } from './pool.ts';
import type { PoolWorker, WorkerPool } from './pool.ts';
import { MARKER_PATTERN } from './sampler.ts';
import { resolveWorkerPath } from './worker-url.ts';

/** The resolver id stamped on every edge. */
export const TYPESCRIPT_RESOLVER_ID = 'typescript';

/** Approved constants of 03-CONSTANTS.md (`precise.*`); a test may shorten them through `deps.limits`. */
export const PRECISE_DEFAULTS = Object.freeze({
  /** `precise.startTimeoutMs`: spawn plus init. */
  startTimeoutMs: 20_000,
  /** `precise.requestTimeoutMs`: below the 30 s build budget so a hang fails before the gate. */
  requestTimeoutMs: 25_000,
  /** `precise.killGraceMs`: wait after ending stdin before killing the worker. */
  killGraceMs: 2000,
  /** `precise.maxStdoutBytes`: the runner cap is cumulative over the child's life (Pitfall 1). */
  maxStdoutBytes: 9_007_199_254_740_991,
  maxLineBytes: PRECISE_LIMITS.maxLineBytes,
  sitesPerRequest: PRECISE_LIMITS.sitesPerRequest,
  /** `precise.memoryBudgetPercent`, `precise.heapShareOfBudget`, `precise.rssSampleMs`, `precise.minBudgetMb` (plan 03-27, budget.ts owns the values). */
  memoryBudgetPercent: MEMORY_DEFAULTS.percent,
  heapShareOfBudget: MEMORY_DEFAULTS.heapShare,
  rssSampleMs: MEMORY_DEFAULTS.sampleMs,
  minBudgetMb: MEMORY_DEFAULTS.minMb,
  /** `precise.idleExitMs`: an idle worker is released after this long. */
  idleExitMs: MEMORY_DEFAULTS.idleExitMs,
});

export type PreciseLimits = { -readonly [K in keyof typeof PRECISE_DEFAULTS]: number };

/** What this machine allows a worker (plan 03-27): the heap flag, the RSS limit and whether the budget reaches the floor at all. */
export function budgetFor(totalMemoryBytes: number = os.totalmem(), limits: Pick<PreciseLimits, 'memoryBudgetPercent' | 'heapShareOfBudget' | 'minBudgetMb'> = PRECISE_DEFAULTS) {
  return deriveBudget({ totalMemBytes: totalMemoryBytes, percent: limits.memoryBudgetPercent, heapShare: limits.heapShareOfBudget, minMb: limits.minBudgetMb });
}

/** The V8 heap flag of a worker: the heap share of the memory budget of this machine. */
export function defaultHeapMb(totalMemoryBytes: number = os.totalmem(), limits: Pick<PreciseLimits, 'memoryBudgetPercent' | 'heapShareOfBudget' | 'minBudgetMb'> = PRECISE_DEFAULTS): number {
  return budgetFor(totalMemoryBytes, limits).heapMb;
}

export interface TypeScriptResolverDeps {
  readonly runner: CommandRunner;
  /** The worktree root (absolute): the worker's working directory and the base of every repository-relative path. */
  readonly worktree: string;
  /** What the project facts are for a call made through the plain `resolve`; the scoped call passes its own. */
  readonly project?: () => PreciseFacts | undefined;
  /** The Node binary and worker file the runner's built-in shape names. Default: this process's Node and the package's worker. */
  readonly execPath?: string;
  readonly workerPath?: string;
  /** The directory of the bundled compiler. Default: the installed `typescript` package of this package. */
  readonly bundledDir?: string;
  /** The V8 heap limit passed to the worker, in megabytes. Default: derived from this machine's RAM ({@link budgetFor}). */
  readonly heapMb?: number;
  /**
   * The RSS limit of the worker's own sampler thread, in megabytes. Default: derived from this machine's RAM. `null` runs
   * the worker with the V8 heap flag alone (a test of that backstop); production never passes it.
   */
  readonly rssLimitMb?: number | null;
  /** The sampler's period in milliseconds. Default: `precise.rssSampleMs`. */
  readonly sampleMs?: number;
  /** The machine's RAM in bytes. Default: `os.totalmem()`; a test injects it. */
  readonly totalMemBytes?: number;
  /**
   * The memory budget and worker pool this resolver's worker lives in. The Host builds ONE for all its tenants
   * ({@link createResolverMemory}); without it the resolver builds a private one from this machine's RAM.
   */
  readonly memory?: ResolverMemory;
  readonly limits?: Partial<PreciseLimits>;
  /** TEST HOOK. Called once each time a resolve iteration ends, whether it finished, was abandoned or threw. */
  readonly onCleanup?: () => void;
}

/** What the worker said about itself in `ready`. */
export interface WorkerInfo {
  readonly pid: number | undefined;
  readonly compiler: { readonly version: string; readonly source: 'project' | 'bundled' };
  readonly rssMb: number;
  /** True when the worker's RSS sampler thread is running. */
  readonly sampler: boolean;
  /** Programs the worker held after its last request (one per owner config in use), and its resident memory then. */
  readonly programs: number;
  readonly lastRssMb: number;
  /** The largest resident memory the worker reported (at ready or after a request). */
  readonly peakRssMb: number;
}

/** What the relations path counted (plan 03-25). */
export interface RelationStats {
  /** Files sent to the worker, and files for which it returned at least one relation. */
  files: { asked: number; answered: number };
  /** Relations whose two ends mapped to exactly one grammar symbol each. */
  kept: number;
  /** Relations dropped because an end did not. */
  dropped: number;
}

export interface TypeScriptResolver extends PreciseResolver {
  /**
   * Resolve under the facts the store computed for this snapshot. Yields edges in request order, preceded by notices
   * (`compiler_fallback`, `precise_unavailable`) that the store adds to the answer without failing it.
   */
  resolveScoped(
    project: PreciseFacts | undefined,
    overlay: OverlaySnapshot,
    context: ResolutionContext,
    sites: readonly RefSiteKey[],
    symbols?: SymbolLookup,
  ): AsyncIterable<ResolvedEdge | ResolverNotice>;
  /**
   * Resolve the relations of the classes and interfaces declared in `files` under the facts the store computed for this
   * snapshot (plan 03-25). Yields relations in request order, preceded by the same notices as `resolveScoped`.
   */
  relationsScoped(
    project: PreciseFacts | undefined,
    overlay: OverlaySnapshot,
    context: ResolutionContext,
    files: readonly string[],
    symbols?: SymbolLookup,
  ): AsyncIterable<ResolvedRelation | ResolverNotice>;
  /** Files asked and answered, relations kept and relations dropped because an end mapped to no single grammar symbol. */
  relationStats(): RelationStats;
  /** Sites asked, edges produced and declarations dropped, per compiler declaration kind. */
  stats(): Stats;
  /** The running worker's own report, or undefined when none runs. */
  info(): WorkerInfo | undefined;
  /**
   * Forget a memory stop: the next read starts a worker again even when the project context did not change (an explicit
   * `maintain resolve`; the Host restart does the same by building a new resolver).
   */
  clearMemoryStop(): void;
  /** End the worker: close its stdin, wait `killGraceMs`, then kill. Safe to call twice. */
  close(): Promise<void>;
}

/** How a worker ended. */
interface ExitInfo {
  readonly memory: boolean;
  readonly how: string;
}

/** The pool's handle for a running compiler worker. */
export interface CompilerWorker extends PoolWorker {
  readonly stream: CommandStream;
  readonly input: ReturnType<typeof createAsyncQueue<string>>;
  readonly configs: ReadonlySet<string>;
  readonly compilerDir: string | null;
  readonly expectedSource: 'project' | 'bundled';
  /** One listener per request in flight; it is given each message of the request and the size of its line in bytes. */
  readonly listeners: Map<number, (message: Response, bytes: number) => void>;
  readonly exitWaiters: Set<(info: ExitInfo) => void>;
  readonly ready: Promise<void>;
  readonly signal: { resolve(): void; reject(error: Error): void };
  exit: ExitInfo | undefined;
  info: ReadyInfo | undefined;
  programs: number;
  lastRssMb: number;
  peakRssMb: number;
}

/** What the worker said about itself in `ready`. */
type ReadyInfo = Pick<WorkerInfo, 'pid' | 'compiler' | 'rssMb' | 'sampler'>;

/** The budget and pool every worker of a Host lives in: one pair per Host, shared by all tenants (plan 03-27, D-21). */
export interface ResolverMemory {
  readonly budget: MemoryBudget;
  readonly pool: WorkerPool<CompilerWorker>;
}

export interface ResolverMemoryOptions {
  /** The machine's RAM in bytes. Default: `os.totalmem()`. */
  readonly totalMemBytes?: number;
  /** The share, heap share and floor. Default: the approved constants. */
  readonly config?: Partial<MemoryBudgetConfig>;
  readonly clock?: Clock;
  /** `precise.idleExitMs`. */
  readonly idleExitMs?: number;
  /** The share of the budget one worker holds. Default: the budget's derived RSS limit. */
  readonly workerMb?: number;
}

/** One budget and one pool. The composition root builds it once per Host from `os.totalmem()` and the approved constants. */
export function createResolverMemory(options: ResolverMemoryOptions = {}): ResolverMemory {
  const budget = createMemoryBudget({
    totalMemBytes: options.totalMemBytes ?? os.totalmem(),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const pool = createWorkerPool<CompilerWorker>({
    budget,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idleExitMs === undefined ? {} : { idleExitMs: options.idleExitMs }),
    ...(options.workerMb === undefined ? {} : { workerMb: options.workerMb }),
  });
  return { budget, pool };
}

/**
 * A private memory for a resolver or tier that was not given the Host's: this machine's RAM and the approved constants. A
 * caller that chose its own limits (a test) gets a budget that can hold them, with no floor.
 */
export function createTuningMemory(tuning: Pick<TypeScriptResolverDeps, 'heapMb' | 'rssLimitMb' | 'totalMemBytes' | 'limits'>): ResolverMemory {
  const limits: PreciseLimits = { ...PRECISE_DEFAULTS, ...tuning.limits };
  const totalMemBytes = tuning.totalMemBytes ?? os.totalmem();
  const explicit = tuning.heapMb !== undefined || tuning.rssLimitMb !== undefined;
  const machine = budgetFor(totalMemBytes, limits);
  const holds = tuning.rssLimitMb === null ? tuning.heapMb : (tuning.rssLimitMb ?? tuning.heapMb);
  return createResolverMemory({
    totalMemBytes: explicit ? Math.max(totalMemBytes, (holds ?? machine.rssLimitMb) * 4 * 1_048_576) : totalMemBytes,
    config: { percent: limits.memoryBudgetPercent, heapShare: limits.heapShareOfBudget, minMb: explicit ? 0 : limits.minBudgetMb },
    idleExitMs: limits.idleExitMs,
  });
}

let tenantCounter = 0;

/** Source files the compiler resolves: TypeScript and JavaScript. Other extensions are skipped without a word. */
const COMPILER_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;
/** A path that can only be resolved under a config (used when the store has no project facts at all). */
const TYPESCRIPT_FILE = /\.(?:[cm]?ts|tsx)$/i;

const MEMORY_ABORT = /heap out of memory|allocation failed|reached heap limit/i;
const WINDOWS_ABORT_CODES = new Set([3, 134, 3221226505]);

const decoder = new TextDecoder('utf-8');

/** What a memory stop is remembered under: the resolution context (its id and the hashes of the configs it derives from). */
const contextKeyOf = (context: ResolutionContext): string => `${context.id}\u0001${context.configHashes.join(',')}`;

const siteKey = (path: string, row: number, col: number, name: string): string => `${path}\u0000${String(row)}\u0000${String(col)}\u0000${name}`;

function classifyExit(code: number | null, signal: string | null, stderr: Uint8Array, denied: boolean, spawnError: boolean): ExitInfo {
  if (denied) return { memory: false, how: 'the runner refused to start the worker' };
  if (spawnError) return { memory: false, how: 'the worker could not be started' };
  const text = decoder.decode(stderr);
  // The sampler's marker line (plan 03-27) or a V8 abort: a memory stop. A SIGKILL without the marker is a crash.
  const memory = MARKER_PATTERN.test(text) || MEMORY_ABORT.test(text) || signal === 'SIGABRT' || (code !== null && code >= 128 && WINDOWS_ABORT_CODES.has(code));
  return { memory, how: signal !== null ? `signal ${signal}` : `exit code ${String(code)}` };
}

function exitFailure(info: ExitInfo): ResolverFailure {
  return info.memory
    ? new ResolverFailure('memory_budget', 'the compiler worker ran out of memory')
    : new ResolverFailure('resolver_failed', `the compiler worker stopped before it answered (${info.how})`);
}

export function createTypeScriptResolver(deps: TypeScriptResolverDeps): TypeScriptResolver {
  const limits: PreciseLimits = { ...PRECISE_DEFAULTS, ...deps.limits };
  const execPath = deps.execPath ?? process.execPath;
  const workerPath = deps.workerPath ?? resolveWorkerPath();
  const bundledDir = deps.bundledDir ?? bundledCompilerDir();
  // What this machine allows (plan 03-27). Production passes none of the overrides: the heap flag AND the sampler limit are
  // both derived from the budget, so no worker runs without both. A budget below the floor starts nothing at all: the pool
  // refuses the reservation and the answer is `memory_budget`.
  const totalMemBytes = deps.totalMemBytes ?? os.totalmem();
  const machine = deps.memory?.budget.derived ?? budgetFor(totalMemBytes, limits);
  const heapMb = deps.heapMb ?? machine.heapMb;
  const rssLimitMb: number | undefined = deps.rssLimitMb === null ? undefined : (deps.rssLimitMb ?? machine.rssLimitMb);
  const sampleMs = deps.sampleMs ?? limits.rssSampleMs;
  // A test that chooses its own limits holds exactly that much of the budget; the pool default (the derived RSS limit) is
  // what every other worker holds.
  const explicit = deps.heapMb !== undefined || deps.rssLimitMb !== undefined;
  const reserveMb: number | undefined = explicit ? (rssLimitMb ?? heapMb) : undefined;
  // Without a Host-wide memory the resolver has a private one.
  const ownsMemory = deps.memory === undefined;
  const memory: ResolverMemory = deps.memory ?? createTuningMemory(deps);
  const tenant = `${deps.worktree}#${String((tenantCounter += 1))}`;
  const stats = createStats();

  let live: CompilerWorker | undefined;
  let closed = false;
  // The memory-stop latch (T-03-272) lives in the pool, per tenant: the context key of the read a worker was stopped for
  // memory under. While it matches, the answer is `memory_budget` without starting a worker. A different key (a config or
  // compiler change), `clearMemoryStop` or a new resolver (a Host restart) is a new question. No timer.
  let currentKey = '';
  let nextId = 1;
  let lock: Promise<unknown> = Promise.resolve();

  /** Run `work` after every earlier request finished: the worker handles one request at a time. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = lock.then(work, work);
    lock = run.catch(() => undefined);
    return run;
  }

  function handleLine(candidate: CompilerWorker, line: string): void {
    const parsed = parseResponse(line, limits.maxLineBytes);
    if (!parsed.ok) {
      violation(candidate, parsed.message);
      return;
    }
    const message = parsed.value;
    if (message.t === 'ready') {
      candidate.info = { pid: message.pid, compiler: message.compiler, rssMb: message.rssMb, sampler: message.sampler === true };
      candidate.lastRssMb = message.rssMb;
      candidate.peakRssMb = Math.max(candidate.peakRssMb, message.rssMb);
      candidate.signal.resolve();
      return;
    }
    if (message.id === null) {
      // A worker error that belongs to no request: before `ready` it is the failure to start, afterwards a violation.
      if (candidate.info === undefined) candidate.signal.reject(new ResolverFailure('resolver_failed', 'the compiler worker could not load a compiler'));
      else violation(candidate, 'the worker reported an error that belongs to no request');
      return;
    }
    candidate.listeners.get(message.id)?.(message, Buffer.byteLength(line, 'utf8'));
  }

  function violation(candidate: CompilerWorker, _why: string): void {
    // The reason is not kept: it may name the worker's own words. The worker is stopped and the call fails.
    candidate.stream.kill();
    candidate.signal.reject(new ResolverFailure('resolver_failed', 'the compiler worker broke the protocol'));
  }

  async function pump(candidate: CompilerWorker): Promise<void> {
    let buffer = '';
    try {
      for await (const chunk of candidate.stream.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (line.trim() !== '') handleLine(candidate, line);
        }
        if (Buffer.byteLength(buffer, 'utf8') > limits.maxLineBytes) {
          violation(candidate, 'a response line was longer than the limit');
          break;
        }
      }
    } catch {
      // the stream ended abnormally; the result below says how
    }
    const result = await candidate.stream.result;
    const info = classifyExit(result.exitCode, result.signal, result.stderr, result.denied !== undefined, result.spawnError !== undefined);
    candidate.exit = info;
    if (info.memory) memory.pool.markMemoryStop(tenant, currentKey);
    candidate.signal.reject(exitFailure(info));
    for (const waiter of [...candidate.exitWaiters]) waiter(info);
    candidate.exitWaiters.clear();
    candidate.listeners.clear();
    if (live === candidate) live = undefined;
    memory.pool.notifyExit(tenant, candidate);
  }

  function start(request: CompilerRequest, expectedSource: 'project' | 'bundled', configs: readonly string[]): CompilerWorker {
    const input = createAsyncQueue<string>();
    const spec: CommandSpec = {
      executable: execPath,
      args: [`--max-old-space-size=${String(heapMb)}`, workerPath],
      builtinId: COMPILER_WORKER_ID,
      env: { GSD_ATLAS_WORKER: '1' },
      cwd: deps.worktree,
      stdin: input,
      maxStdoutBytes: limits.maxStdoutBytes,
    };
    const stream = deps.runner.stream(spec, { repo: deps.worktree });
    let signal: { resolve(): void; reject(error: Error): void } = { resolve: () => {}, reject: () => {} };
    const ready = new Promise<void>((resolve, reject) => {
      signal = { resolve, reject };
    });
    ready.catch(() => undefined);
    const started: CompilerWorker = {
      get alive() {
        return this.exit === undefined;
      },
      stop: () => stop(started),
      stream,
      input,
      configs: new Set(configs),
      compilerDir: request.compilerDir,
      expectedSource,
      listeners: new Map(),
      exitWaiters: new Set(),
      ready,
      signal,
      exit: undefined,
      info: undefined,
      programs: 0,
      lastRssMb: 0,
      peakRssMb: 0,
    };
    void pump(started);
    const init: Request = {
      t: 'init',
      protocol: PROTOCOL_VERSION,
      worktreeRoot: deps.worktree,
      compilerDir: request.compilerDir,
      bundledDir: request.bundledDir,
      configs: [...configs],
      heapMb,
      ...(rssLimitMb === undefined ? {} : { rssLimitMb, sampleMs }),
    };
    input.push(encodeRequest(init));
    return started;
  }

  /** Start a worker and wait until it said `ready` (or failed, or was too slow). The pool calls this once it holds the share. */
  async function startAndWait(request: CompilerRequest, expectedSource: 'project' | 'bundled', configs: readonly string[]): Promise<CompilerWorker> {
    const started = start(request, expectedSource, configs);
    live = started;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        started.stream.kill();
        reject(new ResolverFailure('resolver_failed', 'the compiler worker did not start in time'));
      }, limits.startTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([started.ready, timeout]);
    } catch (error) {
      if (live === started) live = undefined;
      started.stream.kill();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return started;
  }

  /**
   * The worker for `project`, held until `memory.pool.release(tenant)`: the one running when it fits, else a new one, started
   * only when the pool can hold it. A project stopped for memory under this very context is answered `memory_budget` without
   * asking the pool (the latch).
   */
  async function ensure(project: PreciseFacts, contextKey: string): Promise<CompilerWorker> {
    const request = compilerForRequest(project.compiler, deps.worktree, bundledDir);
    const expectedSource = request.compilerDir === null ? 'bundled' : 'project';
    const key = `${contextKey}\u0000${request.compilerDir ?? ''}`;
    currentKey = key;
    if (memory.pool.memoryStopped(tenant, key)) {
      throw new ResolverFailure('memory_budget', 'the compiler worker was stopped for memory under this project context');
    }
    const handle = await memory.pool.acquire(tenant, {
      ...(reserveMb === undefined ? {} : { mb: reserveMb }),
      matches: (running) => running.compilerDir === request.compilerDir && project.configs.every((config) => running.configs.has(config)),
      start: () => startAndWait(request, expectedSource, project.configs),
    });
    live = handle;
    return handle;
  }

  /** Run `work` on the worker for `project`, and give the worker back to the pool when it is done, whatever happens. */
  async function withWorker<T>(project: PreciseFacts, contextKey: string, work: (candidate: CompilerWorker) => Promise<T>): Promise<T> {
    const candidate = await ensure(project, contextKey);
    try {
      return await work(candidate);
    } finally {
      memory.pool.release(tenant);
    }
  }

  /**
   * One request and its items (edges or relations), until `done`. Rejects when the worker exits, breaks the protocol or is
   * too slow. A worker that sends more items than `maxItems`, or more bytes of them than `maxBytes`, or an item of the other
   * kind, is broken or hostile and is stopped (T-03-232, T-03-233, T-03-251).
   */
  function ask<K extends 'edge' | 'relation'>(
    candidate: CompilerWorker,
    build: (id: number) => Request,
    expect: {
      readonly kind: K;
      readonly onItem: (message: Extract<Response, { t: K }>) => void;
      readonly maxItems: number;
      readonly maxBytes: number;
    },
  ): Promise<{ asked: number; answered: number }> {
    return new Promise((resolve, reject) => {
      if (candidate.exit !== undefined) {
        reject(exitFailure(candidate.exit));
        return;
      }
      const id = nextId;
      nextId += 1;
      const finish = (): void => {
        clearTimeout(timer);
        candidate.listeners.delete(id);
        candidate.exitWaiters.delete(onExit);
      };
      const onExit = (info: ExitInfo): void => {
        finish();
        reject(exitFailure(info));
      };
      const timer = setTimeout(() => {
        finish();
        candidate.stream.kill();
        reject(new ResolverFailure('resolver_failed', 'the compiler worker did not answer in time'));
      }, limits.requestTimeoutMs);
      timer.unref();
      candidate.exitWaiters.add(onExit);
      let received = 0;
      let receivedBytes = 0;
      candidate.listeners.set(id, (message, bytes) => {
        if (message.t === expect.kind) {
          // One edge per site at most, and a bounded volume of relations: a worker that sends more is stopped.
          received += 1;
          receivedBytes += bytes;
          if (received > expect.maxItems || receivedBytes > expect.maxBytes) {
            finish();
            candidate.stream.kill();
            reject(new ResolverFailure('resolver_failed', 'the compiler worker answered more than it was asked'));
            return;
          }
          expect.onItem(message as Extract<Response, { t: K }>);
        } else if (message.t === 'edge' || message.t === 'relation') {
          finish();
          candidate.stream.kill();
          reject(new ResolverFailure('resolver_failed', 'the compiler worker answered with the wrong kind of item'));
        } else if (message.t === 'done') {
          finish();
          if (message.programs !== undefined) candidate.programs = message.programs;
          if (message.rssMb !== undefined) {
            candidate.lastRssMb = message.rssMb;
            candidate.peakRssMb = Math.max(candidate.peakRssMb, message.rssMb);
          }
          resolve({ asked: message.asked, answered: message.answered });
        } else if (message.t === 'error') {
          finish();
          reject(new ResolverFailure('resolver_failed', 'the compiler worker refused a request'));
        }
      });
      candidate.input.push(encodeRequest(build(id)));
    });
  }

  async function stop(candidate: CompilerWorker): Promise<void> {
    if (candidate.exit !== undefined) return;
    candidate.input.end();
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((resolve) => {
      candidate.exitWaiters.add(() => resolve());
      timer = setTimeout(() => {
        candidate.stream.kill();
        resolve();
      }, limits.killGraceMs);
      timer.unref();
    });
    await exited;
    if (timer !== undefined) clearTimeout(timer);
    await candidate.stream.result.catch(() => undefined);
    if (live === candidate) live = undefined;
  }

  /** Sites grouped by owner config, the sites the compiler can not be asked about, and the notices that follow. */
  function plan(project: PreciseFacts | undefined, sites: readonly RefSiteKey[]) {
    const groups = new Map<string, Array<{ readonly site: RefSiteKey; readonly wire: { path: string; row: number; col: number; name: string } }>>();
    const notices = new Set<DegradedCode>();
    const seen = new Set<string>();
    for (const site of sites) {
      if (!COMPILER_FILE.test(site.path)) continue;
      const key = siteKey(site.path, site.span.startLine, site.span.startColumn, site.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const owner = project?.ownerOf(site.path);
      if (project === undefined || owner === undefined || !project.configs.includes(owner)) {
        if (project === undefined ? TYPESCRIPT_FILE.test(site.path) : project.requiresOwner(site.path)) notices.add('precise_unavailable');
        continue;
      }
      const group = groups.get(owner) ?? [];
      group.push({ site, wire: { path: site.path, row: site.span.startLine, col: site.span.startColumn, name: site.name } });
      groups.set(owner, group);
    }
    return { groups, notices };
  }

  async function* run(
    project: PreciseFacts | undefined,
    contextId: string,
    sites: readonly RefSiteKey[],
    symbols: SymbolLookup | undefined,
  ): AsyncGenerator<ResolvedEdge | ResolverNotice, void, undefined> {
    try {
      if (closed || sites.length === 0) return;
      const { groups, notices } = plan(project, sites);
      for (const code of notices) yield { kind: 'notice', degraded: code };
      if (project === undefined || groups.size === 0 || symbols === undefined) return;

      const answers = new Map<string, Target[]>();
      const fallback = await serial(() => withWorker(project, contextId, async (candidate) => {
        for (const [config, members] of groups) {
          for (let at = 0; at < members.length; at += limits.sitesPerRequest) {
            const chunk = members.slice(at, at + limits.sitesPerRequest);
            const counts = await ask(candidate, (id) => ({ t: 'resolve', id, config, sites: chunk.map((member) => member.wire) }), {
              kind: 'edge',
              onItem: (message) => {
                answers.set(siteKey(message.site.path, message.site.row, message.site.col, message.site.name), message.targets);
              },
              maxItems: chunk.length,
              maxBytes: Number.POSITIVE_INFINITY,
            });
            stats.sites.asked += counts.asked;
            stats.sites.answered += counts.answered;
          }
        }
        return candidate.info?.compiler.source !== candidate.expectedSource || project.compiler.source === 'bundled';
      }));
      if (fallback) yield { kind: 'notice', degraded: 'compiler_fallback' };

      // Map each declaration to a grammar symbol; the edges of a site are kept together.
      const mapped = new Map<string, Promise<SymbolIdentity | null>>();
      const produced = new Map<string, ResolvedEdge[]>();
      for (const members of groups.values()) {
        for (const { site, wire } of members) {
          const key = siteKey(wire.path, wire.row, wire.col, wire.name);
          const targets = answers.get(key) ?? [];
          const edges: ResolvedEdge[] = [];
          const seenIdentities = new Set<string>();
          for (const target of targets) {
            const targetKey = siteKey(target.path, target.row, target.col, target.name);
            let pending = mapped.get(targetKey);
            if (pending === undefined) {
              pending = mapTarget(target, symbols);
              mapped.set(targetKey, pending);
            }
            const identity = await pending;
            countDeclaration(stats, target.kind, identity !== null);
            if (identity === null) continue;
            const identityKey = symbolKey(identity);
            if (seenIdentities.has(identityKey)) continue;
            seenIdentities.add(identityKey);
            edges.push({ site, target: identity, confidence: 'EXTRACTED', resolver: TYPESCRIPT_RESOLVER_ID });
          }
          produced.set(key, edges);
        }
      }
      // Request order, once the worker answered: the order of the first appearance of each site in `sites`.
      const emitted = new Set<string>();
      for (const site of sites) {
        const key = siteKey(site.path, site.span.startLine, site.span.startColumn, site.name);
        if (emitted.has(key)) continue;
        emitted.add(key);
        for (const edge of produced.get(key) ?? []) yield edge;
      }
    } finally {
      deps.onCleanup?.();
    }
  }

  /** Files grouped by owner config, and the notice for a TypeScript file that no config owns (the relations counterpart of `plan`). */
  function planFiles(project: PreciseFacts | undefined, files: readonly string[]) {
    const groups = new Map<string, string[]>();
    const notices = new Set<DegradedCode>();
    const seen = new Set<string>();
    for (const file of files) {
      if (!COMPILER_FILE.test(file) || seen.has(file)) continue;
      seen.add(file);
      const owner = project?.ownerOf(file);
      if (project === undefined || owner === undefined || !project.configs.includes(owner)) {
        if (project === undefined ? TYPESCRIPT_FILE.test(file) : project.requiresOwner(file)) notices.add('precise_unavailable');
        continue;
      }
      const group = groups.get(owner) ?? [];
      group.push(file);
      groups.set(owner, group);
    }
    return { groups, notices };
  }

  async function* runRelations(
    project: PreciseFacts | undefined,
    contextId: string,
    files: readonly string[],
    symbols: SymbolLookup | undefined,
  ): AsyncGenerator<ResolvedRelation | ResolverNotice, void, undefined> {
    try {
      if (closed || files.length === 0) return;
      const { groups, notices } = planFiles(project, files);
      for (const code of notices) yield { kind: 'notice', degraded: code };
      if (project === undefined || groups.size === 0 || symbols === undefined) return;

      const received: Array<Extract<Response, { t: 'relation' }>> = [];
      const fallback = await serial(() => withWorker(project, contextId, async (candidate) => {
        for (const [config, members] of groups) {
          for (let at = 0; at < members.length; at += limits.sitesPerRequest) {
            const chunk = members.slice(at, at + limits.sitesPerRequest);
            const counts = await ask(candidate, (id) => ({ t: 'relations', id, config, files: chunk }), {
              kind: 'relation',
              onItem: (message) => {
                received.push(message);
              },
              maxItems: Number.POSITIVE_INFINITY,
              maxBytes: limits.maxLineBytes,
            });
            relationStats.files.asked += counts.asked;
            relationStats.files.answered += counts.answered;
          }
        }
        return candidate.info?.compiler.source !== candidate.expectedSource || project.compiler.source === 'bundled';
      }));
      if (fallback) yield { kind: 'notice', degraded: 'compiler_fallback' };

      // Request order, then the worker's own order: the files as they appear in `files`, each file's relations as found.
      const order = new Map<string, number>();
      files.forEach((file, index) => {
        if (!order.has(file)) order.set(file, index);
      });
      const ranked = received
        .map((message, arrival) => ({ message, arrival, rank: order.get(message.from.path) ?? Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.rank - b.rank || a.arrival - b.arrival);

      // Both ends must map to exactly one grammar symbol, or the relation is dropped and counted (never guessed).
      const mapped = new Map<string, Promise<SymbolIdentity | null>>();
      const identityOf = (target: Target): Promise<SymbolIdentity | null> => {
        const key = siteKey(target.path, target.row, target.col, target.name);
        let pending = mapped.get(key);
        if (pending === undefined) {
          pending = mapTarget(target, symbols);
          mapped.set(key, pending);
        }
        return pending;
      };
      const yielded = new Set<string>();
      for (const { message } of ranked) {
        const from = await identityOf(message.from);
        const to = from === null ? null : await identityOf(message.to);
        if (from === null || to === null) {
          relationStats.dropped += 1;
          continue;
        }
        const key = `${message.relation}\u0000${symbolKey(from)}\u0000${symbolKey(to)}`;
        if (yielded.has(key)) continue;
        yielded.add(key);
        relationStats.kept += 1;
        yield { from, to, relation: message.relation, resolver: TYPESCRIPT_RESOLVER_ID };
      }
    } finally {
      deps.onCleanup?.();
    }
  }

  const relationStats: RelationStats = { files: { asked: 0, answered: 0 }, kept: 0, dropped: 0 };

  return {
    id: TYPESCRIPT_RESOLVER_ID,
    resolve(_overlay, context, sites, symbols) {
      const scoped = run(deps.project?.(), contextKeyOf(context), sites, symbols);
      return (async function* () {
        for await (const item of scoped) if (!isResolverNotice(item)) yield item;
      })();
    },
    resolveScoped(project, _overlay, context, sites, symbols) {
      return run(project, contextKeyOf(context), sites, symbols);
    },
    relations(_overlay, context, files, symbols) {
      const scoped = runRelations(deps.project?.(), contextKeyOf(context), files, symbols);
      return (async function* () {
        for await (const item of scoped) if (!isResolverNotice(item)) yield item;
      })();
    },
    relationsScoped(project, _overlay, context, files, symbols) {
      return runRelations(project, contextKeyOf(context), files, symbols);
    },
    relationStats: () => structuredClone(relationStats),
    stats: () => structuredClone(stats),
    info: () =>
      live?.info === undefined ? undefined : { ...live.info, programs: live.programs, lastRssMb: live.lastRssMb, peakRssMb: live.peakRssMb },
    clearMemoryStop() {
      memory.pool.clearMemoryStop(tenant);
    },
    async close() {
      closed = true;
      await memory.pool.drop(tenant);
      const candidate = live;
      if (candidate !== undefined) await stop(candidate);
      // A private pool is this resolver's alone; the Host's pool outlives its tenants and is closed by the Host.
      if (ownsMemory) await memory.pool.close();
    },
  };
}
