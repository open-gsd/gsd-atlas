import { GrammarLoadError } from '../errors.ts';
import type { GrammarEngine, GrammarEngineOptions } from '../types.ts';

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

export function createPooledGrammarEngine(_options: PoolOptions = {}): GrammarEngine & { poolStatus(): PoolStatus } {
  return {
    load: () => Promise.reject(new GrammarLoadError('engine_init_failed', 'the pooled engine is not implemented yet')),
    dispose: () => Promise.resolve(),
    poolStatus: () => ({ workers: 0, busy: 0, queued: 0, recycled: 0, timedOut: 0, crashed: 0 }),
  };
}
