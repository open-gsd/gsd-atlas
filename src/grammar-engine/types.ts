import type { Span } from '../facts/index.ts';

/** The three query files a language module may provide (D-04): definitions, references, imports. */
export type QueryKind = 'tags' | 'refs' | 'imports';

export const QUERY_KINDS: readonly QueryKind[] = ['tags', 'refs', 'imports'];

/**
 * Everything the engine needs to load a grammar. The caller (the confined module reader) has
 * already read the bytes and the query text; the engine never touches the file system.
 */
export interface GrammarInput {
  /** The grammar name recorded in grammar.lock, for messages. */
  readonly name: string;
  readonly wasm: Uint8Array;
  /** Lower-case hex sha256 of `wasm`, taken from grammar.lock. Checked before the wasm is instantiated. */
  readonly expectedSha256: string;
  readonly queries: { readonly tags?: string; readonly refs?: string; readonly imports?: string };
}

/** One query capture. `span` follows the documented convention (0-based line, 0-based UTF-16 column, end exclusive). */
export interface Capture {
  readonly query: QueryKind;
  /** The capture name without the leading `@`, for example `definition.function` or `name`. */
  readonly name: string;
  /**
   * Zero-based index of the query match this capture came from, within its query kind, in the
   * order `Query.matches` returned the matches. Captures of one match share it, so a consumer pairs
   * a `name` with its definition node by match instead of by span nesting (nested definitions make
   * span nesting ambiguous).
   */
  readonly match: number;
  readonly span: Span;
  /**
   * The captured source text, or an empty string when the node is longer than
   * `GRAMMAR_LIMITS.captureTextChars` UTF-16 code units, so a whole function body never crosses a
   * worker boundary as text. The span is always exact.
   */
  readonly text: string;
}

export interface GrammarRunResult {
  /** True when the source started with U+FEFF; the BOM is stripped before parsing. */
  readonly hadBom: boolean;
  readonly captures: readonly Capture[];
  /** UTF-8 bytes inside outermost ERROR nodes. */
  readonly errorBytes: number;
  /** UTF-8 bytes of the parsed (BOM-stripped) source. */
  readonly totalBytes: number;
  /** Zero-width MISSING nodes, counted separately from errorBytes. */
  readonly missingNodes: number;
}

export interface LoadedGrammar {
  readonly name: string;
  readonly abi: number;
  run(source: string): Promise<GrammarRunResult>;
  /** Release every WASM object. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface GrammarEngine {
  load(input: GrammarInput): Promise<LoadedGrammar>;
  /** Dispose every grammar still loaded. Safe to call twice. */
  dispose(): Promise<void>;
}
