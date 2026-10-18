import { fileURLToPath } from 'node:url';

/**
 * The compiler worker's file URL, resolved from this module's own location so one helper serves both layouts:
 * `worker.ts` when this module is a `.ts` file (tests and development run source with Node's type stripping) and
 * `worker.js` when it is compiled (the published package has no loader). The same rule as the grammar pool's helper,
 * kept here so no deep import is needed. `moduleUrl` exists so a test can exercise the compiled layout.
 */
export function resolveWorkerUrl(moduleUrl: string = import.meta.url): URL {
  const url = new URL(moduleUrl);
  return new URL(url.pathname.endsWith('.ts') ? './worker.ts' : './worker.js', url);
}

/** The absolute path of the worker file: the one the composition root puts into the runner's built-in shape. */
export function resolveWorkerPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(resolveWorkerUrl(moduleUrl));
}
