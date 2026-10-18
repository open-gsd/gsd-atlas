import { createHash } from 'node:crypto';
import { parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

/** A parsed JSON-with-comments document: the value, or a statement that the text is not one. */
export type JsoncResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** The text without a leading byte-order mark (U+FEFF). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parses a tsconfig-style document: line and block comments, trailing commas and a leading BOM are accepted, as
 * the TypeScript compiler accepts them. Any other error (an unclosed comment or string, a missing value, trailing
 * text) makes the whole document invalid: a config that cannot be read exactly is skipped, never guessed at.
 */
export function parseJsonc(text: string): JsoncResult {
  const errors: ParseError[] = [];
  const value: unknown = parse(stripBom(text), errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length > 0 ? { ok: false } : { ok: true, value };
}

/** sha256 of a config's text as the resolution context sees it: BOM stripped, CRLF and lone CR read as LF. */
export function normalizedHash(text: string): string {
  const normalized = stripBom(text).replace(/\r\n?/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
