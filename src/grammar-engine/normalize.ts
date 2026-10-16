import type { Capture, QueryKind } from './types.ts';

const BOM = '﻿';

/**
 * Text policy (D-02): a leading BOM is stripped before parsing so columns on line 0 match what
 * an editor shows, and the fact is reported as `hadBom`. CRLF is left alone.
 */
export function stripBom(text: string): { readonly text: string; readonly hadBom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(BOM.length), hadBom: true } : { text, hadBom: false };
}

/** The slice of a web-tree-sitter Node that normalisation reads. */
export interface PositionedNode {
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly startIndex: number;
  readonly endIndex: number;
}

/**
 * Convert one captured node to a Capture. web-tree-sitter 0.27.1 parses a JavaScript string as
 * UTF-16, so `startIndex`/`endIndex` and the row/column positions are already in UTF-16 code
 * units (verified for emoji and accented letters; no conversion is needed). `text` is cut from
 * the same BOM-stripped string that was parsed.
 */
export function toCapture(query: QueryKind, name: string, node: PositionedNode, source: string): Capture {
  return {
    query,
    name,
    span: {
      startLine: node.startPosition.row,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row,
      endColumn: node.endPosition.column,
    },
    text: source.slice(node.startIndex, node.endIndex),
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order: start line, start column, end line, end column, query, name. */
export function compareCaptures(a: Capture, b: Capture): number {
  return (
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    a.span.endLine - b.span.endLine ||
    a.span.endColumn - b.span.endColumn ||
    compareStrings(a.query, b.query) ||
    compareStrings(a.name, b.name)
  );
}

export function sortCaptures(captures: readonly Capture[]): Capture[] {
  return [...captures].sort(compareCaptures);
}
