/**
 * A source range. Every fact carries one: a fact without a valid span cannot exist
 * (fact-model ADR decision 3, fact-store-interface ADR decision 5).
 *
 * Convention (research A7):
 * - `startLine` and `endLine` are 0-based line numbers.
 * - `startColumn` and `endColumn` are 0-based and count UTF-16 code units, matching
 *   web-tree-sitter and the TypeScript compiler. They are not byte offsets.
 * - The end is exclusive: a span covering the single character at line 0, column 0 is
 *   `{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 }`.
 * - Convert to 1-based lines only at the citation edge (Phase 2), never inside the kernel.
 *
 * Text policy (research A8 and Open Question 4), applied before parsing by the Grammar Engine:
 * - A leading BOM (U+FEFF) is stripped before parsing and reported as `hadBom`, so columns on
 *   line 0 match what editors show.
 * - CRLF is left in place. Rows count `\n` only, so a `\r` never shifts a column on the next
 *   line, and a span that ends at a line break ends before the `\r`.
 */
export interface Span {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * True when `value` is a Span: four non-negative integers whose end is not before the start
 * (compared by line, then by column). Zero-width spans are valid.
 */
export function isValidSpan(value: unknown): value is Span {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  const { startLine, startColumn, endLine, endColumn } = s;
  if (
    !isNonNegativeInteger(startLine) ||
    !isNonNegativeInteger(startColumn) ||
    !isNonNegativeInteger(endLine) ||
    !isNonNegativeInteger(endColumn)
  ) {
    return false;
  }
  if (endLine < startLine) {
    return false;
  }
  if (endLine === startLine && endColumn < startColumn) {
    return false;
  }
  return true;
}
