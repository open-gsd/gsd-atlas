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
   * Registered as `adr.maxCommentUnits` in 03-CONSTANTS.md (user approval of 2026-10-18); a test compares the two.
   * The value is 32,768 UTF-16 code units, and a longer comment is skipped whole, never clipped: a prefix could cut a
   * number (`ADR-123` read as `ADR-1`).
   *
   * Measured, not guessed (.planning/research/COMMENT-BOUND.md): on the pinned gsd-core the 2,846 comments that
   * mention an ADR have a median of 81 and a 99th percentile of 4,615 units, and the longest is 17,881 (file header
   * blocks that cite many ADRs); on gsd-pi the longest is 1,429. The first bound of 4,096 dropped 38 of them and with
   * them 69 of the 1,173 citations of a 20-number sample (5.9 percent against the oracle, over the 2 percent limit of
   * scripts/adr-citations-check.ts); 32,768 keeps them all (0 of 1,173 missed) with a margin of 1.8 times, and
   * results are flat above it. The bound is not what limits hostile cost: the 2 MiB source cap, the 200 citations
   * per file (with the scan's early exit) and the linear scan do that.
   */
  commentTextChars: 32768,
  /** The largest `matchLimit` web-tree-sitter 0.27.1 documents for a query (QueryOptions.matchLimit: > 0 and <= 65536). */
  matchLimitMax: 65536,
} as const;

/** The longest text, in UTF-16 code units, the engine keeps for a capture of this name: 32,768 for `comment`, else 256. */
export function captureTextLimit(captureName: string): number {
  return captureName === 'comment' ? GRAMMAR_LIMITS.commentTextChars : GRAMMAR_LIMITS.captureTextChars;
}
