// RED stub (plan 02-16, task 2): replaced by the real cursor in the GREEN commit.
import type { SortKey } from './ranking.ts';

export interface CursorPayload {
  readonly key: SortKey;
  readonly query: string;
  readonly seq: number;
}

export type CursorProblem = 'malformed' | 'oversized' | 'other_query';

export type DecodedCursor =
  | { readonly ok: true; readonly payload: CursorPayload }
  | { readonly ok: false; readonly problem: CursorProblem };

export interface QueryParts {
  readonly worktree: string;
  readonly name: string;
  readonly kind?: string | undefined;
  readonly mode: string;
  readonly path?: string | undefined;
  readonly cwd?: string | undefined;
}

const notYet = (): never => {
  throw new Error('cursors are not implemented yet');
};

export function queryHash(_tool: string, _parts: QueryParts): string {
  return notYet();
}

export function encodeCursor(_payload: CursorPayload, _maxChars: number): string | null {
  return notYet();
}

export function decodeCursor(_text: string, _expectedQuery: string, _maxChars: number): DecodedCursor {
  return notYet();
}
