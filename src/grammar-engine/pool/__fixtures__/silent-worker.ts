import { parentPort } from 'node:worker_threads';

import type { WorkerRequest } from '../protocol.ts';

/**
 * Test-only worker for the pool's load-deadline tests. It accepts every request and answers none, like a
 * language module whose WASM instantiation or query compilation never finishes. Only the pool's deadline
 * can free the slot. The file is excluded from the build, so it never reaches dist.
 */
const port = parentPort;
if (port === null) {
  throw new Error('silent-worker.ts must run as a worker thread');
}

port.on('message', (_request: WorkerRequest) => {
  // Deliberately no reply.
});
