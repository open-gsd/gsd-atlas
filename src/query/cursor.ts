/**
 * The `more` cursor (D-09, T-02-53). An opaque keyset position: base64url of the JSON `{k, q, w}` with the last
 * sort key, a hash of the query it was issued for and the watermark seq at that time. The server holds no state
 * for it: a follow-up call re-queries and resumes strictly after the key, never with a held read transaction.
 * Cursors from outside are untrusted input: strict base64url, a size cap checked first, a zod shape check and a
 * query-hash binding.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SortKey } from './ranking.ts';

export interface CursorPayload {
  readonly key: SortKey;
  /** The hash of the query the cursor was issued for. */
  readonly query: string;
  /** The watermark seq when the cursor was issued. */
  readonly seq: number;
}

export type CursorProblem = 'malformed' | 'oversized' | 'other_query';

export type DecodedCursor =
  | { readonly ok: true; readonly payload: CursorPayload }
  | { readonly ok: false; readonly problem: CursorProblem };

/** The ranking-relevant parts of a request: what must stay the same from one page to the next. */
export interface QueryParts {
  readonly worktree: string;
  readonly name: string;
  readonly kind?: string | undefined;
  readonly mode: string;
  readonly path?: string | undefined;
  readonly cwd?: string | undefined;
}

const wireSchema = z.strictObject({
  k: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.string(), z.number(), z.number(), z.string()]),
  q: z.string(),
  w: z.int().nonnegative(),
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** 32 hex characters of sha256 over the canonical JSON of the tool name and the ranking-relevant arguments. */
export function queryHash(tool: string, parts: QueryParts): string {
  const canonical = JSON.stringify([tool, parts.worktree, parts.name, parts.kind ?? null, parts.mode, parts.path ?? null, parts.cwd ?? null]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** The cursor text, or `null` when it would be longer than `maxChars` (a path so long the position can not be carried). */
export function encodeCursor(payload: CursorPayload, maxChars: number): string | null {
  const wire = { k: payload.key, q: payload.query, w: payload.seq };
  const text = Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
  return text.length > maxChars ? null : text;
}

export function decodeCursor(text: string, expectedQuery: string, maxChars: number): DecodedCursor {
  if (text.length > maxChars) return { ok: false, problem: 'oversized' };
  if (!BASE64URL.test(text)) return { ok: false, problem: 'malformed' };
  const bytes = Buffer.from(text, 'base64url');
  // Only the canonical encoding is accepted, so one position has one spelling.
  if (bytes.toString('base64url') !== text) return { ok: false, problem: 'malformed' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, problem: 'malformed' };
  }
  const checked = wireSchema.safeParse(parsed);
  if (!checked.success) return { ok: false, problem: 'malformed' };
  if (checked.data.q !== expectedQuery) return { ok: false, problem: 'other_query' };
  return { ok: true, payload: { key: checked.data.k, query: checked.data.q, seq: checked.data.w } };
}
