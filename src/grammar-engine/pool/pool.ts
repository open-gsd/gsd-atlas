import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { GrammarLoadError, GrammarRunError } from '../errors.ts';
import type { GrammarLoadErrorCode, GrammarRunErrorCode } from '../errors.ts';
import { GRAMMAR_LIMITS } from '../limits.ts';
import type {
  GrammarEngine,
  GrammarEngineOptions,
  GrammarInput,
  GrammarRunResult,
  LoadedGrammar,
} from '../types.ts';
import type { WorkerReply, WorkerRequest, WorkerStartData } from './protocol.ts';
import { resolveWorkerUrl } from './worker-url.ts';

/**
 * Every default of the pool. The numbers come from
 * .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved 2026-10-16);
 * change them there first.
 */
export const POOL_DEFAULTS = {
  /** pool.size is min(4, available CPUs minus 1), at least 1; this is the 4. */
  maxWorkers: 4,
  /** pool.recycleAfterFiles: a worker is replaced after this many completed runs (LNG-07). */
  recycleAfterRuns: 2000,
  /**
   * indexer.parseTimeoutMs: the hard per-run deadline of the pool, and the parse cut-off handed to every
   * engine. At equal values the pool deadline normally fires first (the worker is then terminated and the
   * grammar reloaded lazily); both end in `parse_timeout`.
   */
  runTimeoutMs: 5000,
  /**
   * pool.loadTimeoutMs: the deadline of one grammar load (WASM instantiate plus query compile) in a worker.
   * 02-CONSTANTS.md, "Addendum 2026-10-17 (gap closure)", Addendum status: Approved (2026-10-17). A load
   * that passes it ends its worker; the load then fails with `engine_init_failed` (WR-09).
   */
  loadTimeoutMs: 30000,
  /**
   * The one match limit of every engine in a worker: web-tree-sitter reuses capture lists it allocated
   * earlier in the process, so engines must agree. It is the largest value the library documents, as in
   * the recall script of plan 02-13.
   */
  matchLimit: GRAMMAR_LIMITS.matchLimitMax,
} as const;

export interface PoolOptions {
  /** Number of worker threads, an integer of at least 1. Defaults to min(4, available CPUs minus 1), at least 1. */
  readonly size?: number;
  /** Replace a worker after this many completed runs, an integer of at least 1. */
  readonly recycleAfterRuns?: number;
  /** Hard per-run deadline in milliseconds, finite and above 0. The worker is terminated when it passes. */
  readonly runTimeoutMs?: number;
  /** Hard deadline of one grammar load in milliseconds, finite and above 0. The worker is terminated when it passes. */
  readonly loadTimeoutMs?: number;
  /** Limits of the engine inside each worker. Defaults: the shared match limit and the run deadline. */
  readonly engineOptions?: GrammarEngineOptions;
  /** Test-only: a different worker entry file, or a function of the 1-based spawn count that names one. */
  readonly workerUrl?: URL | ((spawnCount: number) => URL);
  /** Test-only: stands in for os.availableParallelism. */
  readonly availableParallelism?: () => number;
}

export interface PoolStatus {
  /** Live worker threads. */
  readonly workers: number;
  /** Workers occupied by a load or run right now. */
  readonly busy: number;
  /** Jobs waiting for a worker. */
  readonly queued: number;
  /** Workers replaced after reaching the recycle interval. */
  readonly recycled: number;
  /** Runs rejected with parse_timeout (each ended its worker). */
  readonly timedOut: number;
  /** Workers that died while a job was in flight or while idle. */
  readonly crashed: number;
}

const LOAD_CODES: ReadonlySet<string> = new Set<GrammarLoadErrorCode>([
  'wasm_hash_mismatch',
  'wasm_invalid',
  'wasm_too_large',
  'query_error',
  'query_too_large',
  'engine_init_failed',
]);
const RUN_CODES: ReadonlySet<string> = new Set<GrammarRunErrorCode>([
  'source_too_large',
  'parse_failed',
  'parse_timeout',
  'match_limit_exceeded',
]);

/** Rebuild the error a worker described. An unknown code becomes the family's generic failure. */
function rebuildError(reply: Extract<WorkerReply, { type: 'error' }>): Error {
  if (reply.kind === 'load') {
    const code = LOAD_CODES.has(reply.code) ? (reply.code as GrammarLoadErrorCode) : 'engine_init_failed';
    return new GrammarLoadError(code, reply.message);
  }
  const code = RUN_CODES.has(reply.code) ? (reply.code as GrammarRunErrorCode) : 'parse_failed';
  return new GrammarRunError(code, reply.message);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSize(cpus: number): number {
  return Math.max(1, Math.min(POOL_DEFAULTS.maxWorkers, Math.floor(cpus) - 1));
}

function checkPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer of at least 1, got ${String(value)}`);
  }
}

interface Settle<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

/** One grammar the caller loaded. The input is kept so any worker can load it lazily. */
interface GrammarRecord {
  readonly key: number;
  readonly name: string;
  readonly input: GrammarInput;
  disposed: boolean;
}

interface LoadedInfo {
  readonly name: string;
  readonly abi: number;
}

type Job =
  | { readonly kind: 'load'; readonly grammar: GrammarRecord; readonly settle: Settle<LoadedInfo> }
  | {
      readonly kind: 'run';
      readonly grammar: GrammarRecord;
      readonly source: string;
      readonly settle: Settle<GrammarRunResult>;
    };

/** A request waiting for its reply. A request that survives its worker's death resolves instead of rejecting. */
interface InFlight {
  readonly resolve: (reply: WorkerReply) => void;
  readonly reject: (error: Error) => void;
  readonly survivesDeath: boolean;
}

interface Slot {
  worker: Worker | undefined;
  busy: boolean;
  /** Completed runs of the current worker. */
  runs: number;
  /** Keys of the grammars the current worker has loaded. */
  readonly loaded: Set<number>;
  readonly inflight: Map<number, InFlight>;
}

function poolDisposed(kind: Job['kind']): Error {
  return kind === 'load'
    ? new GrammarLoadError('engine_init_failed', 'pool disposed')
    : new GrammarRunError('parse_failed', 'pool disposed');
}

/**
 * A GrammarEngine whose parsing happens in a bounded set of worker threads (LNG-07). Each worker hosts
 * one real engine and runs one job at a time; further jobs wait in a first-in first-out queue. Workers
 * are created lazily, load a grammar the first time they receive a run for it, are replaced after
 * `recycleAfterRuns` runs, and are terminated (and replaced on demand) when a run passes its deadline
 * or the thread dies. One stuck or crashed parse therefore costs one run and one worker, never the pool.
 */
export function createPooledGrammarEngine(options: PoolOptions = {}): GrammarEngine & { poolStatus(): PoolStatus } {
  const cpus = (options.availableParallelism ?? (() => os.availableParallelism()))();
  const size = options.size ?? defaultSize(cpus);
  const recycleAfterRuns = options.recycleAfterRuns ?? POOL_DEFAULTS.recycleAfterRuns;
  const runTimeoutMs = options.runTimeoutMs ?? POOL_DEFAULTS.runTimeoutMs;
  checkPositiveInteger('size', size);
  checkPositiveInteger('recycleAfterRuns', recycleAfterRuns);
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0) {
    throw new RangeError(`runTimeoutMs must be a finite number above 0, got ${String(runTimeoutMs)}`);
  }
  const loadTimeoutMs = options.loadTimeoutMs ?? POOL_DEFAULTS.loadTimeoutMs;
  if (!Number.isFinite(loadTimeoutMs) || loadTimeoutMs <= 0) {
    throw new RangeError(`loadTimeoutMs must be a finite number above 0, got ${String(loadTimeoutMs)}`);
  }
  const workerUrl = options.workerUrl ?? resolveWorkerUrl();
  let spawnCount = 0;
  const start: WorkerStartData = {
    engineOptions: {
      matchLimit: options.engineOptions?.matchLimit ?? POOL_DEFAULTS.matchLimit,
      parseTimeoutMs: options.engineOptions?.parseTimeoutMs ?? runTimeoutMs,
    },
  };

  const slots: Slot[] = Array.from({ length: size }, () => ({
    worker: undefined,
    busy: false,
    runs: 0,
    loaded: new Set<number>(),
    inflight: new Map<number, InFlight>(),
  }));
  const queue: Job[] = [];
  const grammars = new Set<GrammarRecord>();
  const terminating = new Set<Promise<void>>();
  let nextId = 1;
  let nextKey = 1;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let recycled = 0;
  let timedOut = 0;
  let crashed = 0;

  /** Forget the slot's worker, fail what it was doing with `error`, and terminate it in the background. */
  function detach(slot: Slot, error: Error): void {
    const worker = slot.worker;
    if (worker === undefined) {
      return;
    }
    slot.worker = undefined;
    slot.runs = 0;
    slot.loaded.clear();
    const entries = [...slot.inflight];
    slot.inflight.clear();
    for (const [id, entry] of entries) {
      if (entry.survivesDeath) {
        entry.resolve({ type: 'disposed', id });
      } else {
        entry.reject(error);
      }
    }
    const ended = worker.terminate().then(
      () => undefined,
      () => undefined,
    );
    terminating.add(ended);
    void ended.then(() => {
      terminating.delete(ended);
    });
  }

  /** A worker died on its own (an uncaught error, or its thread ended). Stale events are ignored. */
  function crash(slot: Slot, worker: Worker, message: string): void {
    if (slot.worker !== worker) {
      return;
    }
    crashed += 1;
    detach(slot, new GrammarRunError('parse_failed', message));
  }

  function spawn(slot: Slot): Worker {
    spawnCount += 1;
    const url = typeof workerUrl === 'function' ? workerUrl(spawnCount) : workerUrl;
    const worker = new Worker(url, { workerData: start });
    slot.worker = worker;
    worker.on('message', (reply: WorkerReply) => {
      if (slot.worker !== worker) {
        return;
      }
      const entry = slot.inflight.get(reply.id);
      if (entry !== undefined) {
        slot.inflight.delete(reply.id);
        entry.resolve(reply);
      }
    });
    worker.on('error', (error: Error) => {
      crash(slot, worker, `the parser worker failed: ${error.message}`);
    });
    worker.on('exit', (code: number) => {
      crash(slot, worker, `the parser worker exited with code ${String(code)}`);
    });
    return worker;
  }

  function request(slot: Slot, build: (id: number) => WorkerRequest, survivesDeath = false): Promise<WorkerReply> {
    const worker = slot.worker;
    if (worker === undefined) {
      return Promise.reject(new GrammarRunError('parse_failed', 'the parser worker is not running'));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<WorkerReply>((resolve, reject) => {
      slot.inflight.set(id, { resolve, reject, survivesDeath });
      try {
        worker.postMessage(build(id));
      } catch (error) {
        slot.inflight.delete(id);
        reject(new GrammarRunError('parse_failed', `the request could not be sent to the parser worker: ${reason(error)}`));
      }
    });
  }

  async function loadInto(slot: Slot, grammar: GrammarRecord): Promise<LoadedInfo> {
    const worker = slot.worker;
    const answer = request(slot, (id) => ({ type: 'load', id, grammarKey: grammar.key, input: grammar.input }));
    // A language module can come from the repository: a load that never finishes must not hold the worker for ever.
    const timer = setTimeout(() => {
      if (slot.worker !== worker) {
        return;
      }
      detach(
        slot,
        new GrammarLoadError(
          'engine_init_failed',
          `${grammar.name}: the grammar load timed out after ${String(loadTimeoutMs)} ms; the parser worker was terminated`,
        ),
      );
    }, loadTimeoutMs);
    timer.unref();
    let reply: WorkerReply;
    try {
      reply = await answer;
    } finally {
      clearTimeout(timer);
    }
    if (reply.type === 'error') {
      throw rebuildError(reply);
    }
    if (reply.type !== 'loaded') {
      throw new GrammarLoadError('engine_init_failed', `unexpected worker reply: ${reply.type}`);
    }
    slot.loaded.add(grammar.key);
    return { name: reply.name, abi: reply.abi };
  }

  /** Post one run and hold it to the pool deadline. A run that passes it ends its worker. */
  async function runOn(slot: Slot, grammar: GrammarRecord, source: string): Promise<GrammarRunResult> {
    const worker = slot.worker;
    const answer = request(slot, (id) => ({ type: 'run', id, grammarKey: grammar.key, source }));
    const timer = setTimeout(() => {
      if (slot.worker !== worker) {
        return;
      }
      timedOut += 1;
      detach(
        slot,
        new GrammarRunError(
          'parse_timeout',
          `${grammar.name}: no answer within ${String(runTimeoutMs)} ms; the parser worker was terminated`,
        ),
      );
    }, runTimeoutMs);
    // The worker keeps the process alive while a run is in flight; the timer must never be the reason it stays.
    timer.unref();
    let reply: WorkerReply;
    try {
      reply = await answer;
    } finally {
      clearTimeout(timer);
    }
    if (slot.worker === worker) {
      slot.runs += 1;
    }
    if (reply.type === 'error') {
      throw rebuildError(reply);
    }
    if (reply.type !== 'result') {
      throw new GrammarRunError('parse_failed', `unexpected worker reply: ${reply.type}`);
    }
    return reply.result;
  }

  async function execute(slot: Slot, job: Job): Promise<void> {
    slot.busy = true;
    try {
      if (job.grammar.disposed) {
        throw job.kind === 'load'
          ? new GrammarLoadError('engine_init_failed', `${job.grammar.name}: grammar is disposed`)
          : new GrammarRunError('parse_failed', `${job.grammar.name}: grammar is disposed`);
      }
      if (slot.worker === undefined) {
        spawn(slot);
      }
      if (job.kind === 'load') {
        job.settle.resolve(await loadInto(slot, job.grammar));
      } else {
        if (!slot.loaded.has(job.grammar.key)) {
          try {
            await loadInto(slot, job.grammar);
          } catch (error) {
            throw new GrammarRunError(
              'parse_failed',
              `${job.grammar.name}: the grammar could not be loaded into a parser worker: ${reason(error)}`,
            );
          }
        }
        job.settle.resolve(await runOn(slot, job.grammar, job.source));
      }
    } catch (error) {
      if (job.kind === 'load') {
        job.settle.reject(error instanceof GrammarLoadError ? error : new GrammarLoadError('engine_init_failed', reason(error)));
      } else {
        job.settle.reject(error instanceof Error ? error : new GrammarRunError('parse_failed', reason(error)));
      }
    } finally {
      slot.busy = false;
      if (slot.worker !== undefined && slot.runs >= recycleAfterRuns) {
        recycled += 1;
        detach(slot, new GrammarRunError('parse_failed', 'the parser worker was recycled'));
      }
      pump();
    }
  }

  /** The idle slot for `job`: one that already has its grammar, else a live one, else an unspawned one. */
  function pickSlot(job: Job): Slot | undefined {
    let live: Slot | undefined;
    let empty: Slot | undefined;
    for (const slot of slots) {
      if (slot.busy) {
        continue;
      }
      if (slot.worker === undefined) {
        empty ??= slot;
      } else if (slot.loaded.has(job.grammar.key)) {
        return slot;
      } else {
        live ??= slot;
      }
    }
    return live ?? empty;
  }

  function pump(): void {
    while (!disposed && queue.length > 0) {
      const head = queue[0];
      const slot = head === undefined ? undefined : pickSlot(head);
      if (head === undefined || slot === undefined) {
        return;
      }
      queue.shift();
      void execute(slot, head);
    }
  }

  function enqueueLoad(grammar: GrammarRecord): Promise<LoadedInfo> {
    return new Promise<LoadedInfo>((resolve, reject) => {
      if (disposed) {
        reject(poolDisposed('load'));
        return;
      }
      queue.push({ kind: 'load', grammar, settle: { resolve, reject } });
      pump();
    });
  }

  function enqueueRun(grammar: GrammarRecord, source: string): Promise<GrammarRunResult> {
    return new Promise<GrammarRunResult>((resolve, reject) => {
      if (disposed) {
        reject(poolDisposed('run'));
        return;
      }
      queue.push({ kind: 'run', grammar, source, settle: { resolve, reject } });
      pump();
    });
  }

  async function disposeGrammar(record: GrammarRecord): Promise<void> {
    if (record.disposed) {
      return;
    }
    record.disposed = true;
    grammars.delete(record);
    const releases: Array<Promise<unknown>> = [];
    for (const slot of slots) {
      if (slot.worker !== undefined && slot.loaded.has(record.key)) {
        slot.loaded.delete(record.key);
        releases.push(
          request(slot, (id) => ({ type: 'dispose', id, grammarKey: record.key }), true).catch(() => undefined),
        );
      }
    }
    await Promise.all(releases);
  }

  function disposeEngine(): Promise<void> {
    disposing ??= (async () => {
      disposed = true;
      for (const job of queue.splice(0)) {
        job.settle.reject(poolDisposed(job.kind));
      }
      for (const record of grammars) {
        record.disposed = true;
      }
      grammars.clear();
      for (const slot of slots) {
        detach(slot, new GrammarRunError('parse_failed', 'pool disposed'));
      }
      await Promise.all([...terminating]);
    })();
    return disposing;
  }

  return {
    async load(input: GrammarInput): Promise<LoadedGrammar> {
      if (disposed) {
        throw poolDisposed('load');
      }
      const record: GrammarRecord = { key: nextKey, name: input.name, input, disposed: false };
      nextKey += 1;
      grammars.add(record);
      let info: LoadedInfo;
      try {
        info = await enqueueLoad(record);
      } catch (error) {
        grammars.delete(record);
        record.disposed = true;
        throw error;
      }
      return {
        name: info.name,
        abi: info.abi,
        run(source: string): Promise<GrammarRunResult> {
          if (record.disposed) {
            return Promise.reject(new GrammarRunError('parse_failed', `${record.name}: grammar is disposed`));
          }
          return enqueueRun(record, source);
        },
        dispose: () => disposeGrammar(record),
      };
    },
    dispose: disposeEngine,
    poolStatus(): PoolStatus {
      return {
        workers: slots.filter((slot) => slot.worker !== undefined).length,
        busy: slots.filter((slot) => slot.busy).length,
        queued: queue.length,
        recycled,
        timedOut,
        crashed,
      };
    },
  };
}
