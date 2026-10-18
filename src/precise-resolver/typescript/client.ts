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
  DegradedCode,
  OverlaySnapshot,
  PreciseFacts,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  ResolverNotice,
  SymbolIdentity,
  SymbolLookup,
} from '../../facts/index.ts';
import type { PreciseResolver } from '../index.ts';
import { bundledCompilerDir, compilerForRequest } from './compiler.ts';
import type { CompilerRequest } from './compiler.ts';
import { countDeclaration, createStats, mapTarget } from './identity.ts';
import type { Stats } from './identity.ts';
import { PRECISE_LIMITS, PROTOCOL_VERSION, encodeRequest, parseResponse } from './protocol.ts';
import type { Request, Response, Target } from './protocol.ts';
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
  /** `precise.memoryBudgetPercent` and `precise.heapShareOfBudget`: the plan 03-27 budget, used here only to size the heap flag. */
  memoryBudgetPercent: 25,
  heapShareOfBudget: 0.8,
  minHeapMb: 256,
});

export type PreciseLimits = { -readonly [K in keyof typeof PRECISE_DEFAULTS]: number };

/** The V8 heap flag of a worker: the heap share of the memory budget of this machine, never below `minHeapMb`. */
export function defaultHeapMb(totalMemoryBytes: number = os.totalmem(), limits: Pick<PreciseLimits, 'memoryBudgetPercent' | 'heapShareOfBudget' | 'minHeapMb'> = PRECISE_DEFAULTS): number {
  const budgetMb = (totalMemoryBytes / 1_048_576) * (limits.memoryBudgetPercent / 100);
  return Math.max(limits.minHeapMb, Math.floor(budgetMb * limits.heapShareOfBudget));
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
  /** The V8 heap limit passed to the worker, in megabytes. Default: {@link defaultHeapMb}. */
  readonly heapMb?: number;
  readonly limits?: Partial<PreciseLimits>;
  /** TEST HOOK. Called once each time a resolve iteration ends, whether it finished, was abandoned or threw. */
  readonly onCleanup?: () => void;
}

/** What the worker said about itself in `ready`. */
export interface WorkerInfo {
  readonly pid: number | undefined;
  readonly compiler: { readonly version: string; readonly source: 'project' | 'bundled' };
  readonly rssMb: number;
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
  /** Sites asked, edges produced and declarations dropped, per compiler declaration kind. */
  stats(): Stats;
  /** The running worker's own report, or undefined when none runs. */
  info(): WorkerInfo | undefined;
  /** End the worker: close its stdin, wait `killGraceMs`, then kill. Safe to call twice. */
  close(): Promise<void>;
}

/** How a worker ended. */
interface ExitInfo {
  readonly memory: boolean;
  readonly how: string;
}

interface Live {
  readonly stream: CommandStream;
  readonly input: ReturnType<typeof createAsyncQueue<string>>;
  readonly configs: ReadonlySet<string>;
  readonly compilerDir: string | null;
  readonly expectedSource: 'project' | 'bundled';
  readonly listeners: Map<number, (message: Response) => void>;
  readonly exitWaiters: Set<(info: ExitInfo) => void>;
  readonly ready: Promise<void>;
  readonly signal: { resolve(): void; reject(error: Error): void };
  exit: ExitInfo | undefined;
  info: WorkerInfo | undefined;
}

/** Source files the compiler resolves: TypeScript and JavaScript. Other extensions are skipped without a word. */
const COMPILER_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;
/** A path that can only be resolved under a config (used when the store has no project facts at all). */
const TYPESCRIPT_FILE = /\.(?:[cm]?ts|tsx)$/i;

const MEMORY_ABORT = /heap out of memory|allocation failed|reached heap limit/i;
const WINDOWS_ABORT_CODES = new Set([3, 134, 3221226505]);

const decoder = new TextDecoder('utf-8');

const siteKey = (path: string, row: number, col: number, name: string): string => `${path}\u0000${String(row)}\u0000${String(col)}\u0000${name}`;

function classifyExit(code: number | null, signal: string | null, stderr: Uint8Array, denied: boolean, spawnError: boolean): ExitInfo {
  if (denied) return { memory: false, how: 'the runner refused to start the worker' };
  if (spawnError) return { memory: false, how: 'the worker could not be started' };
  const text = decoder.decode(stderr);
  const memory = MEMORY_ABORT.test(text) || signal === 'SIGABRT' || (code !== null && code >= 128 && WINDOWS_ABORT_CODES.has(code));
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
  const heapMb = deps.heapMb ?? defaultHeapMb(os.totalmem(), limits);
  const stats = createStats();

  let live: Live | undefined;
  let closed = false;
  let nextId = 1;
  let lock: Promise<unknown> = Promise.resolve();

  /** Run `work` after every earlier request finished: the worker handles one request at a time. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = lock.then(work, work);
    lock = run.catch(() => undefined);
    return run;
  }

  function handleLine(candidate: Live, line: string): void {
    const parsed = parseResponse(line, limits.maxLineBytes);
    if (!parsed.ok) {
      violation(candidate, parsed.message);
      return;
    }
    const message = parsed.value;
    if (message.t === 'ready') {
      candidate.info = { pid: message.pid, compiler: message.compiler, rssMb: message.rssMb };
      candidate.signal.resolve();
      return;
    }
    if (message.id === null) {
      // A worker error that belongs to no request: before `ready` it is the failure to start, afterwards a violation.
      if (candidate.info === undefined) candidate.signal.reject(new ResolverFailure('resolver_failed', 'the compiler worker could not load a compiler'));
      else violation(candidate, 'the worker reported an error that belongs to no request');
      return;
    }
    candidate.listeners.get(message.id)?.(message);
  }

  function violation(candidate: Live, _why: string): void {
    // The reason is not kept: it may name the worker's own words. The worker is stopped and the call fails.
    candidate.stream.kill();
    candidate.signal.reject(new ResolverFailure('resolver_failed', 'the compiler worker broke the protocol'));
  }

  async function pump(candidate: Live): Promise<void> {
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
    candidate.signal.reject(exitFailure(info));
    for (const waiter of [...candidate.exitWaiters]) waiter(info);
    candidate.exitWaiters.clear();
    candidate.listeners.clear();
    if (live === candidate) live = undefined;
  }

  function start(request: CompilerRequest, expectedSource: 'project' | 'bundled', configs: readonly string[]): Live {
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
    const started: Live = {
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
    };
    input.push(encodeRequest(init));
    return started;
  }

  /** The worker for `project`, started (and waited for) when none runs or the one running was started for other inputs. */
  async function ensure(project: PreciseFacts): Promise<Live> {
    const request = compilerForRequest(project.compiler, deps.worktree, bundledDir);
    const expectedSource = request.compilerDir === null ? 'bundled' : 'project';
    if (live !== undefined && live.exit === undefined) {
      const sameCompiler = live.compilerDir === request.compilerDir;
      const knowsConfigs = project.configs.every((config) => live?.configs.has(config) === true);
      if (sameCompiler && knowsConfigs) return live;
      await stop(live);
    }
    const started = start(request, expectedSource, project.configs);
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

  /** One request and its edges, until `done`. Rejects when the worker exits, breaks the protocol or is too slow. */
  function ask(candidate: Live, build: (id: number) => Request, onEdge: (message: Extract<Response, { t: 'edge' }>) => void): Promise<{ asked: number; answered: number }> {
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
      candidate.listeners.set(id, (message) => {
        if (message.t === 'edge') {
          onEdge(message);
        } else if (message.t === 'done') {
          finish();
          resolve({ asked: message.asked, answered: message.answered });
        } else if (message.t === 'error') {
          finish();
          reject(new ResolverFailure('resolver_failed', 'the compiler worker refused a request'));
        }
      });
      candidate.input.push(encodeRequest(build(id)));
    });
  }

  async function stop(candidate: Live): Promise<void> {
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
    sites: readonly RefSiteKey[],
    symbols: SymbolLookup | undefined,
  ): AsyncGenerator<ResolvedEdge | ResolverNotice, void, undefined> {
    try {
      if (closed || sites.length === 0) return;
      const { groups, notices } = plan(project, sites);
      for (const code of notices) yield { kind: 'notice', degraded: code };
      if (project === undefined || groups.size === 0 || symbols === undefined) return;

      const answers = new Map<string, Target[]>();
      const fallback = await serial(async () => {
        const candidate = await ensure(project);
        for (const [config, members] of groups) {
          for (let at = 0; at < members.length; at += limits.sitesPerRequest) {
            const chunk = members.slice(at, at + limits.sitesPerRequest);
            const counts = await ask(
              candidate,
              (id) => ({ t: 'resolve', id, config, sites: chunk.map((member) => member.wire) }),
              (message) => {
                answers.set(siteKey(message.site.path, message.site.row, message.site.col, message.site.name), message.targets);
              },
            );
            stats.sites.asked += counts.asked;
            stats.sites.answered += counts.answered;
          }
        }
        return candidate.info?.compiler.source !== candidate.expectedSource || project.compiler.source === 'bundled';
      });
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

  return {
    id: TYPESCRIPT_RESOLVER_ID,
    resolve(_overlay, _context, sites, symbols) {
      const scoped = run(deps.project?.(), sites, symbols);
      return (async function* () {
        for await (const item of scoped) if (!isResolverNotice(item)) yield item;
      })();
    },
    resolveScoped(project, _overlay, _context, sites, symbols) {
      return run(project, sites, symbols);
    },
    stats: () => structuredClone(stats),
    info: () => live?.info,
    async close() {
      closed = true;
      const candidate = live;
      if (candidate !== undefined) await stop(candidate);
    },
  };
}
