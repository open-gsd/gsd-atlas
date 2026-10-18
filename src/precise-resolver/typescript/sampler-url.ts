/**
 * The sampler entry file URL, resolved from this module's own location by the same rule as the worker file
 * (`worker-url.ts`): `sampler.ts` when this module is a `.ts` file (tests and development run source with Node's type
 * stripping) and `sampler.js` when it is compiled (the published package has no loader).
 * `moduleUrl` exists so a test can exercise the compiled layout; callers pass nothing.
 */
export function resolveSamplerUrl(moduleUrl: string = import.meta.url): URL {
  const url = new URL(moduleUrl);
  return new URL(url.pathname.endsWith('.ts') ? './sampler.ts' : './sampler.js', url);
}
