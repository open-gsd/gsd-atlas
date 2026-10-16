import type { Node, Query } from 'web-tree-sitter';

import { GrammarRunError } from './errors.ts';
import { sortCaptures, toCapture } from './normalize.ts';
import { QUERY_KINDS } from './types.ts';
import type { Capture, QueryKind } from './types.ts';

export interface QueryLimits {
  /** Most matches in flight per query; absent means the library default (no limit). */
  readonly matchLimit?: number;
}

/**
 * Run every compiled query over `root` and return the captures in the documented order. The
 * caller owns the tree; nothing taken from it escapes this function (Captures are plain data).
 *
 * When a query goes over `matchLimit`, web-tree-sitter drops the oldest in-flight matches and sets
 * `didExceedMatchLimit()`; the result would be silently incomplete, so the run fails instead.
 */
export function collectCaptures(
  queries: Readonly<Partial<Record<QueryKind, Query>>>,
  root: Node,
  source: string,
  limits: QueryLimits = {},
): Capture[] {
  const captures: Capture[] = [];
  for (const kind of QUERY_KINDS) {
    const query = queries[kind];
    if (query === undefined) {
      continue;
    }
    // `matches` keeps the captures of one pattern match together; the match index is the position in the order returned.
    const matches = query.matches(root, limits.matchLimit === undefined ? undefined : { matchLimit: limits.matchLimit });
    if (query.didExceedMatchLimit()) {
      throw new GrammarRunError(
        'match_limit_exceeded',
        `the ${kind} query had more than ${String(limits.matchLimit)} matches in flight; its result would be incomplete`,
      );
    }
    matches.forEach((match, index) => {
      for (const capture of match.captures) {
        captures.push(toCapture(kind, capture.name, capture.node, source, index));
      }
    });
  }
  return sortCaptures(captures);
}
