/**
 * The Grammar Engine seam (FND-05, D-10): load a hash-pinned grammar WASM, run its tags, refs and
 * imports queries over a source text, and return captures as spans (0-based line, 0-based UTF-16
 * column, end exclusive). Test code (the shared contract) is not exported from here.
 */
export { createGrammarEngine } from './engine.ts';
export { GrammarLoadError, GrammarRunError } from './errors.ts';
export type { GrammarLoadErrorCode, GrammarRunErrorCode } from './errors.ts';
export { GRAMMAR_LIMITS } from './limits.ts';
export { measureErrors } from './measure.ts';
export { createPooledGrammarEngine } from './pool/pool.ts';
export type { PoolOptions, PoolStatus } from './pool/pool.ts';
export type { ErrorMeasurement } from './measure.ts';
export { createFakeGrammarEngine } from './fake.ts';
export type { FakeGrammarScript, ScriptedCapture, ScriptedRunResult } from './fake.ts';
export { extractFileFacts } from './extract.ts';
export type { ExtractInput, ExtractResult } from './extract.ts';
export { stripBom } from './normalize.ts';
export type {
  Capture,
  GrammarEngine,
  GrammarEngineOptions,
  GrammarInput,
  GrammarRunResult,
  LoadedGrammar,
  QueryKind,
} from './types.ts';
