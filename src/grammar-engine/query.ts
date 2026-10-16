import type { Node, Query } from 'web-tree-sitter';

import { sortCaptures, toCapture } from './normalize.ts';
import { QUERY_KINDS } from './types.ts';
import type { Capture, QueryKind } from './types.ts';

/**
 * Run every compiled query over `root` and return the captures in the documented order. The
 * caller owns the tree; nothing taken from it escapes this function (Captures are plain data).
 */
export function collectCaptures(
  queries: Readonly<Partial<Record<QueryKind, Query>>>,
  root: Node,
  source: string,
): Capture[] {
  const captures: Capture[] = [];
  for (const kind of QUERY_KINDS) {
    const query = queries[kind];
    if (query === undefined) {
      continue;
    }
    for (const capture of query.captures(root)) {
      captures.push(toCapture(kind, capture.name, capture.node, source));
    }
  }
  return sortCaptures(captures);
}
