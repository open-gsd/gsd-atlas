/**
 * The TypeScript adapter of the PreciseResolver seam (plan 03-23). The worker file itself (`worker.ts`) is the only
 * file that loads a compiler and is not exported: it runs as a child process, started through the CommandRunner.
 */
export { PRECISE_DEFAULTS, TYPESCRIPT_RESOLVER_ID, createTypeScriptResolver, defaultHeapMb } from './client.ts';
export type { PreciseLimits, TypeScriptResolver, TypeScriptResolverDeps, WorkerInfo } from './client.ts';
export { BUNDLED_TYPESCRIPT_VERSION, bundledCompilerDir, compilerFallbackText, compilerForRequest } from './compiler.ts';
export type { CompilerRequest } from './compiler.ts';
export { createStats, mapTarget } from './identity.ts';
export type { KindStats, Stats } from './identity.ts';
export { PRECISE_LIMITS } from './protocol.ts';
export { PROVIDER_OFF_TEXT, createTypeScriptTier } from './tier.ts';
export type { PreciseTier, TypeScriptTierDeps, TypeScriptTierTuning } from './tier.ts';
export { resolveWorkerPath, resolveWorkerUrl } from './worker-url.ts';
