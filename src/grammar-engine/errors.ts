/** Why a grammar could not be loaded. Load problems are typed values, never crashes. */
export type GrammarLoadErrorCode =
  | 'wasm_hash_mismatch'
  | 'wasm_invalid'
  | 'wasm_too_large'
  | 'query_error'
  | 'query_too_large'
  | 'engine_init_failed';

/**
 * Why a loaded grammar could not run over a source text. `parse_timeout`: the parse passed the
 * engine's `parseTimeoutMs` deadline and was cancelled. `match_limit_exceeded`: a query had more
 * matches in flight than the engine's `matchLimit`, so its result would have been silently truncated.
 */
export type GrammarRunErrorCode = 'source_too_large' | 'parse_failed' | 'parse_timeout' | 'match_limit_exceeded';

export class GrammarLoadError extends Error {
  readonly code: GrammarLoadErrorCode;

  constructor(code: GrammarLoadErrorCode, message: string) {
    super(message);
    this.name = 'GrammarLoadError';
    this.code = code;
  }
}

export class GrammarRunError extends Error {
  readonly code: GrammarRunErrorCode;

  constructor(code: GrammarRunErrorCode, message: string) {
    super(message);
    this.name = 'GrammarRunError';
    this.code = code;
  }
}
