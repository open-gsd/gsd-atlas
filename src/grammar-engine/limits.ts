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
  /** Longest captured node whose text is kept, in UTF-16 code units; a longer node yields an empty string (T-02-21). */
  captureTextChars: 256,
  /** The largest `matchLimit` web-tree-sitter 0.27.1 documents for a query (QueryOptions.matchLimit: > 0 and <= 65536). */
  matchLimitMax: 65536,
} as const;
