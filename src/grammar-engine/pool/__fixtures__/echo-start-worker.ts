import { parentPort, workerData } from 'node:worker_threads';

import type { WorkerReply, WorkerRequest } from '../protocol.ts';

/**
 * Test-only worker that shows what the pool handed to a worker at start: it answers a load with `name`
 * set to the JSON of its `workerData`, so a test can read the engine cut-off the pool configured. Runs
 * answer with an empty result. The file is excluded from the build, so it never reaches dist.
 */
const port = parentPort;
if (port === null) {
  throw new Error('echo-start-worker.ts must run as a worker thread');
}

port.on('message', (request: WorkerRequest) => {
  let reply: WorkerReply;
  switch (request.type) {
    case 'load':
      reply = { type: 'loaded', id: request.id, name: JSON.stringify(workerData), abi: 0 };
      break;
    case 'dispose':
      reply = { type: 'disposed', id: request.id };
      break;
    case 'run':
      reply = {
        type: 'result',
        id: request.id,
        result: { hadBom: false, captures: [], errorBytes: 0, totalBytes: request.source.length, missingNodes: 0 },
      };
      break;
  }
  port.postMessage(reply);
});
