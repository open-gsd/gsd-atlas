import { parentPort } from 'node:worker_threads';

import type { WorkerReply, WorkerRequest } from '../protocol.ts';

/**
 * Test-only worker for the pool's supervision tests. It speaks the real worker protocol but needs no
 * grammar, and a run misbehaves on request: the source `spin` never answers, `crash` ends the worker
 * thread with a nonzero exit code and `throw` raises an uncaught error inside it. Any other source
 * answers with an empty result. The file is excluded from the build, so it never reaches dist.
 */
const port = parentPort;
if (port === null) {
  throw new Error('spin-worker.ts must run as a worker thread');
}

port.on('message', (request: WorkerRequest) => {
  let reply: WorkerReply;
  switch (request.type) {
    case 'load':
      reply = { type: 'loaded', id: request.id, name: 'spin', abi: 0 };
      break;
    case 'dispose':
      reply = { type: 'disposed', id: request.id };
      break;
    case 'run':
      if (request.source === 'spin') {
        for (;;) {
          // Never returns: the pool's deadline has to end this worker.
        }
      }
      if (request.source === 'crash') {
        process.exit(7);
      }
      if (request.source === 'throw') {
        throw new Error('the fixture worker threw on request');
      }
      reply = {
        type: 'result',
        id: request.id,
        result: { hadBom: false, captures: [], errorBytes: 0, totalBytes: request.source.length, missingNodes: 0 },
      };
      break;
  }
  port.postMessage(reply);
});
