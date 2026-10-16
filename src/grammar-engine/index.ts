/**
 * The Grammar Engine seam (FND-05, D-10): load a hash-pinned grammar WASM, run its tags, refs and
 * imports queries over a source text, and return captures as spans (0-based line, 0-based UTF-16
 * column, end exclusive). Test code (the shared contract) is not exported from here.
 */
export { createGrammarEngine } from './engine.ts';
export { GrammarLoadError, GrammarRunError } from './errors.ts';
export type { GrammarLoadErrorCode, GrammarRunErrorCode } from './errors.ts';
export { GRAMMAR_LIMITS } from './limits.ts';
export { stripBom } from './normalize.ts';
export type {
  Capture,
  GrammarEngine,
  GrammarInput,
  GrammarRunResult,
  LoadedGrammar,
  QueryKind,
} from './types.ts';
