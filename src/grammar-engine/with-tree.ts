import { GrammarRunError } from './errors.ts';

/**
 * The only place in src/grammar-engine allowed to call a parser's parse method (a lint rule
 * enforces it). A web-tree-sitter Tree lives in WASM memory until it is deleted, so every parse
 * goes through here and the tree is deleted in `finally`, on the return path and the throw path
 * alike (PITFALLS B1). Do not let the tree, or any node taken from it, escape `fn`.
 */
export function withTree<TTree extends { delete(): void }, T>(
  parser: { parse(source: string): TTree | null },
  source: string,
  fn: (tree: TTree) => T,
): T {
  const tree = parser.parse(source);
  if (tree === null) {
    throw new GrammarRunError('parse_failed', 'the parser returned no tree (no language set, or parsing was cancelled)');
  }
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}
