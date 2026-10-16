import { GrammarRunError } from './errors.ts';

/** What a parse progress callback is told. */
interface ProgressState {
  readonly currentOffset: number;
  readonly hasError: boolean;
}

/** The slice of web-tree-sitter's ParseOptions that the deadline uses. Returning true cancels the parse. */
interface DeadlineOptions {
  progressCallback?: (state: ProgressState) => boolean;
}

export interface ParseLimits {
  /** Cancel the parse once this many milliseconds have passed. No deadline when absent. */
  readonly timeoutMs?: number;
}

/**
 * The only place in src/grammar-engine allowed to call a parser's parse method (a lint rule
 * enforces it). A web-tree-sitter Tree lives in WASM memory until it is deleted, so every parse
 * goes through here and the tree is deleted in `finally`, on the return path and the throw path
 * alike (PITFALLS B1). Do not let the tree, or any node taken from it, escape `fn`.
 *
 * Deadline: web-tree-sitter 0.27.1 cancels a parse when the progress callback returns true, and
 * `parse` then returns null (checked against the installed typings and at run time). A cancelled
 * parse keeps its state and would resume on the next call, even for a different source, so the
 * parser is reset before the error is raised.
 */
export function withTree<TTree extends { delete(): void }, T>(
  parser: { parse(source: string, oldTree?: null, options?: DeadlineOptions): TTree | null; reset?(): void },
  source: string,
  fn: (tree: TTree) => T,
  limits: ParseLimits = {},
): T {
  let timedOut = false;
  let options: DeadlineOptions | undefined;
  if (limits.timeoutMs !== undefined) {
    const deadline = performance.now() + limits.timeoutMs;
    options = {
      progressCallback: () => {
        if (performance.now() >= deadline) {
          timedOut = true;
          return true;
        }
        return false;
      },
    };
  }
  const tree = parser.parse(source, null, options);
  if (tree === null) {
    parser.reset?.();
    if (timedOut) {
      throw new GrammarRunError('parse_timeout', 'the parse passed its deadline and was cancelled');
    }
    throw new GrammarRunError('parse_failed', 'the parser returned no tree (no language set, or parsing was cancelled)');
  }
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}
