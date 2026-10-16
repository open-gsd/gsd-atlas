import { Worker } from 'node:worker_threads';

import { GrammarLoadError, GrammarRunError } from '../errors.ts';
import type { GrammarLoadErrorCode, GrammarRunErrorCode } from '../errors.ts';
import type {
  GrammarEngine,
  GrammarEngineOptions,
  GrammarInput,
  GrammarRunResult,
  LoadedGrammar,
} from '../types.ts';
import type { WorkerReply, WorkerRequest, WorkerStartData } from './protocol.ts';
import { resolveWorkerUrl } from './worker-url.ts';

export interface PoolOptions {
  /** Number of worker threads. Defaults to the approved pool.size rule. */
  readonly size?: number;
  /** Recycle a worker after this many completed runs. */
  readonly recycleAfterRuns?: number;
  /** Hard per-run deadline in milliseconds. */
  readonly runTimeoutMs?: number;
  readonly engineOptions?: GrammarEngineOptions;
  /** Test-only: a different worker entry file. */
  readonly workerUrl?: URL;
  /** Test-only: stands in for os.availableParallelism. */
  readonly availableParallelism?: () => number;
}

export interface PoolStatus {
  readonly workers: number;
  readonly busy: number;
  readonly queued: number;
  readonly recycled: number;
  readonly timedOut: number;
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

interface Pending {
  readonly resolve: (reply: WorkerReply) => void;
  readonly reject: (error: Error) => void;
}

export function createPooledGrammarEngine(options: PoolOptions = {}): GrammarEngine & { poolStatus(): PoolStatus } {
  const workerUrl = options.workerUrl ?? resolveWorkerUrl();
  const start: WorkerStartData = { engineOptions: options.engineOptions ?? {} };
  const pending = new Map<number, Pending>();
  let worker: Worker | undefined;
  let nextId = 1;
  let nextKey = 1;
  let disposed = false;

  function failAll(error: Error): void {
    for (const entry of [...pending.values()]) {
      entry.reject(error);
    }
    pending.clear();
  }

  function spawn(): Worker {
    const created = new Worker(workerUrl, { workerData: start });
    created.on('message', (reply: WorkerReply) => {
      const entry = pending.get(reply.id);
      if (entry !== undefined) {
        pending.delete(reply.id);
        entry.resolve(reply);
      }
    });
    created.on('error', (error) => {
      failAll(new GrammarRunError('parse_failed', `the parser worker failed: ${error.message}`));
    });
    created.on('exit', () => {
      failAll(new GrammarRunError('parse_failed', 'the parser worker exited'));
      if (worker === created) {
        worker = undefined;
      }
    });
    return created;
  }

  function request(message: (id: number) => WorkerRequest): Promise<WorkerReply> {
    if (disposed) {
      return Promise.reject(new GrammarRunError('parse_failed', 'pool disposed'));
    }
    worker ??= spawn();
    const target = worker;
    const id = nextId;
    nextId += 1;
    return new Promise<WorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.postMessage(message(id));
    });
  }

  return {
    async load(input: GrammarInput): Promise<LoadedGrammar> {
      if (disposed) {
        throw new GrammarLoadError('engine_init_failed', 'pool disposed');
      }
      const grammarKey = nextKey;
      nextKey += 1;
      const reply = await request((id) => ({ type: 'load', id, grammarKey, input }));
      if (reply.type === 'error') {
        throw rebuildError(reply);
      }
      if (reply.type !== 'loaded') {
        throw new GrammarLoadError('engine_init_failed', `unexpected worker reply: ${reply.type}`);
      }
      let grammarDisposed = false;
      return {
        name: reply.name,
        abi: reply.abi,
        async run(source: string): Promise<GrammarRunResult> {
          if (grammarDisposed) {
            throw new GrammarRunError('parse_failed', `${input.name}: grammar is disposed`);
          }
          const result = await request((id) => ({ type: 'run', id, grammarKey, source }));
          if (result.type === 'error') {
            throw rebuildError(result);
          }
          if (result.type !== 'result') {
            throw new GrammarRunError('parse_failed', `unexpected worker reply: ${result.type}`);
          }
          return result.result;
        },
        async dispose(): Promise<void> {
          if (grammarDisposed) {
            return;
          }
          grammarDisposed = true;
          if (!disposed && worker !== undefined) {
            await request((id) => ({ type: 'dispose', id, grammarKey })).catch(() => undefined);
          }
        },
      };
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      failAll(new GrammarRunError('parse_failed', 'pool disposed'));
      const live = worker;
      worker = undefined;
      await live?.terminate();
    },
    poolStatus(): PoolStatus {
      return { workers: worker === undefined ? 0 : 1, busy: pending.size > 0 ? 1 : 0, queued: 0, recycled: 0, timedOut: 0, crashed: 0 };
    },
  };
}
