/**
 * The grammar tier's position model, as functions (plan 03-23, research Pitfall 3).
 *
 * A position is a 0-based row and a 0-based column counted in UTF-16 code units. Rows are counted on `\n` only: a `\r`
 * never starts a row, and neither does U+2028, U+2029 or U+0085, so a CRLF file and a file with a line separator inside
 * a string keep the rows the grammar tier stored. A leading byte-order mark is not part of the text positions refer to.
 * The compiler's own line map counts `\r`, U+2028 and U+2029 as line breaks, so it is never used to convert.
 */

const BOM = 0xfeff;

/** `text` without a leading byte-order mark (U+FEFF). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}

/** The offset of the first character of each row of `text` (after the BOM is dropped); row 0 starts at 0. */
export function lineStarts(text: string): number[] {
  const body = stripBom(text);
  const starts = [0];
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

/**
 * The offset (into the text without its BOM) of `row` and `col`, or undefined when the row does not exist or the
 * column runs past the end of its row. A column may point at the row's line break (the end of the row), no further.
 */
export function offsetOf(starts: readonly number[], row: number, col: number): number | undefined {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return undefined;
  const start = starts[row];
  if (start === undefined) return undefined;
  const offset = start + col;
  const next = starts[row + 1];
  if (next !== undefined && offset >= next) return undefined;
  return offset;
}

/** The row and column of `offset`: the inverse of {@link offsetOf} for every offset inside the text. */
export function positionOf(starts: readonly number[], offset: number): { readonly row: number; readonly col: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { row: low, col: offset - (starts[low] as number) };
}
