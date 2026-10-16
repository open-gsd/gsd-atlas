/**
 * Size caps for untrusted language-module content and parsed sources (T-01-29). The real
 * engine, the fake and the confined module reader all use these same numbers.
 */
export const GRAMMAR_LIMITS = {
  /** A grammar WASM. */
  wasmBytes: 8 * 1024 * 1024,
  /** Each query file (tags, refs, imports). */
  queryBytes: 256 * 1024,
  /** One source text handed to `run`, in UTF-8 bytes. */
  sourceBytes: 2 * 1024 * 1024,
  /** atlas-lang.json and grammar.lock. */
  manifestBytes: 64 * 1024,
} as const;
