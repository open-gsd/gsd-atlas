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
  /**
   * The same bound for a capture named `comment` (the tags query's ADR mention filter, plan 03-24): a comment that
   * mentions an ADR is prose, longer than a name, so 256 would blank it. An internal size bound like the others in
   * this file, not a timeout, queue bound or gate threshold; a longer comment yields an empty string and the
   * extractor counts it as `citation_comment_too_long`.
   *
   * Measured, not guessed: on the pinned gsd-core the 2,847 comments that mention an ADR have a median of 81 and a
   * 99th percentile of 4,615 characters, and the longest is 17,881 (file header blocks that cite many ADRs). The
   * first bound of 4,096 dropped 38 of them and with them 69 of the 1,173 citations of a 20-number sample (5.9
   * percent against the oracle, over the 2 percent limit of scripts/adr-citations-check.ts); 65,536 keeps them all
   * with a margin of 3.6 times. The text copied is still bounded: the captures of one file together hold no more
   * than the source (2 MiB), and the scan is linear.
   */
  commentTextChars: 65536,
  /** The largest `matchLimit` web-tree-sitter 0.27.1 documents for a query (QueryOptions.matchLimit: > 0 and <= 65536). */
  matchLimitMax: 65536,
} as const;

/** The longest text, in UTF-16 code units, the engine keeps for a capture of this name: 65,536 for `comment`, else 256. */
export function captureTextLimit(captureName: string): number {
  return captureName === 'comment' ? GRAMMAR_LIMITS.commentTextChars : GRAMMAR_LIMITS.captureTextChars;
}
