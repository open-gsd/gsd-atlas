import { parentPort, workerData } from 'node:worker_threads';

import { createGrammarEngine } from '../engine.ts';
import { GrammarLoadError, GrammarRunError } from '../errors.ts';
import type { GrammarEngine, LoadedGrammar } from '../types.ts';
import type { WorkerErrorKind, WorkerReply, WorkerRequest, WorkerStartData } from './protocol.ts';

/**
 * The worker thread entry. It hosts one real Grammar Engine (the only `createGrammarEngine` call in the
 * pool directory), so the hash check, the size caps, `withTree` and every WASM delete behave exactly as
 * they do in-process. Requests are answered exactly once; errors keep their class family and code.
 */
const port = parentPort;
if (port === null) {
  throw new Error('pool/worker.ts must run as a worker thread');
}

const { engineOptions } = workerData as WorkerStartData;

// An invalid engine option would make the engine throw at construction. Keep the error and answer every
// request with it, so the pool sees a coded failure instead of a dead worker.
let engine: GrammarEngine | undefined;
let startupError: Error | undefined;
try {
  engine = createGrammarEngine(engineOptions);
} catch (error) {
  startupError = error instanceof Error ? error : new Error(String(error));
}

const grammars = new Map<number, LoadedGrammar>();

function errorReply(id: number, kind: WorkerErrorKind, error: unknown): WorkerReply {
  if (error instanceof GrammarLoadError || error instanceof GrammarRunError) {
    return { type: 'error', id, kind: error instanceof GrammarLoadError ? 'load' : 'run', code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', id, kind, code: kind === 'load' ? 'engine_init_failed' : 'parse_failed', message };
}

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  const kind: WorkerErrorKind = request.type === 'load' ? 'load' : 'run';
  try {
    if (startupError !== undefined || engine === undefined) {
      throw startupError ?? new Error('the grammar engine did not start');
    }
    switch (request.type) {
      case 'load': {
        const grammar = await engine.load(request.input);
        // A key is loaded at most once per worker; replace a stale entry rather than leak it.
        await grammars.get(request.grammarKey)?.dispose();
        grammars.set(request.grammarKey, grammar);
        return { type: 'loaded', id: request.id, name: grammar.name, abi: grammar.abi };
      }
      case 'run': {
        const grammar = grammars.get(request.grammarKey);
        if (grammar === undefined) {
          throw new GrammarRunError('parse_failed', `grammar ${String(request.grammarKey)} is not loaded in this worker`);
        }
        return { type: 'result', id: request.id, result: await grammar.run(request.source) };
      }
      case 'dispose': {
        const grammar = grammars.get(request.grammarKey);
        grammars.delete(request.grammarKey);
        await grammar?.dispose();
        return { type: 'disposed', id: request.id };
      }
    }
  } catch (error) {
    return errorReply(request.id, kind, error);
  }
}

port.on('message', (request: WorkerRequest) => {
  void handle(request).then((reply) => {
    port.postMessage(reply);
  });
});
