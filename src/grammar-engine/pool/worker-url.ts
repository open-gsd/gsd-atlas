/**
 * The worker entry file URL, resolved from this module's own location so one helper serves both layouts:
 * `worker.ts` when this module is a `.ts` file (tests and development run source with Node's type
 * stripping) and `worker.js` when it is compiled (the published package has no loader).
 * `moduleUrl` exists so a test can exercise the compiled layout; callers pass nothing.
 */
export function resolveWorkerUrl(moduleUrl: string = import.meta.url): URL {
  return new URL('./worker.js', moduleUrl);
}
