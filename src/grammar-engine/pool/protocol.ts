import type { GrammarEngineOptions, GrammarInput, GrammarRunResult } from '../types.ts';

/**
 * Messages between the pool (main thread) and one worker thread. Every payload is plain
 * structured-clone data: no class instances, no functions, no WASM handles.
 *
 * `grammarKey` is chosen by the pool and names one loaded grammar in every worker. `id` pairs a reply
 * with its request; a worker answers each request exactly once.
 */

/** What `workerData` carries into a worker. */
export interface WorkerStartData {
  readonly engineOptions: GrammarEngineOptions;
}

export type WorkerRequest =
  | { readonly type: 'load'; readonly id: number; readonly grammarKey: number; readonly input: GrammarInput }
  | { readonly type: 'run'; readonly id: number; readonly grammarKey: number; readonly source: string }
  | { readonly type: 'dispose'; readonly id: number; readonly grammarKey: number };

/** Which family of errors a worker error belongs to, so the pool rebuilds the same class. */
export type WorkerErrorKind = 'load' | 'run';

export type WorkerReply =
  | { readonly type: 'loaded'; readonly id: number; readonly name: string; readonly abi: number }
  | { readonly type: 'result'; readonly id: number; readonly result: GrammarRunResult }
  | { readonly type: 'disposed'; readonly id: number }
  | {
      readonly type: 'error';
      readonly id: number;
      readonly kind: WorkerErrorKind;
      /** A `GrammarLoadErrorCode` or `GrammarRunErrorCode`; the pool maps anything else to a default code. */
      readonly code: string;
      readonly message: string;
    };
