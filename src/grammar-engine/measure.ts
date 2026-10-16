import { utf8Length } from './check.ts';

/** The slice of a web-tree-sitter Node that measurement reads. */
export interface MeasureNode {
  readonly isError: boolean;
  readonly isMissing: boolean;
  readonly hasError: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
}

/** The slice of a web-tree-sitter TreeCursor that measurement uses. */
export interface MeasureCursor {
  readonly currentNode: MeasureNode;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
  delete(): void;
}

export interface ErrorMeasurement {
  /** UTF-8 bytes inside outermost ERROR nodes (LNG-06, D-06). */
  readonly errorBytes: number;
  /** UTF-8 bytes of the text that was parsed. */
  readonly totalBytes: number;
  /** Zero-width MISSING nodes, reported separately from errorBytes. */
  readonly missingNodes: number;
}

/**
 * Parse quality as bytes, not file counts (PITFALLS B2): sum the UTF-8 length of the text under
 * every OUTERMOST ERROR node. Traversal never descends into an ERROR node (nested errors would
 * double count) and prunes subtrees without errors. MISSING nodes are zero-width, so they are
 * counted on their own. `text` must be the exact string that was parsed (BOM already stripped):
 * web-tree-sitter indexes it in UTF-16 units, while the totals here are in UTF-8 bytes.
 *
 * The cursor is deleted in `finally` on every path (PITFALLS B1).
 */
export function measureErrors(root: { walk(): MeasureCursor }, text: string): ErrorMeasurement {
  let errorBytes = 0;
  let missingNodes = 0;
  const cursor = root.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      let descend = false;
      if (node.isError) {
        errorBytes += utf8Length(text.slice(node.startIndex, node.endIndex));
      } else if (node.isMissing) {
        missingNodes += 1;
      } else {
        descend = node.hasError;
      }
      if (descend && cursor.gotoFirstChild()) {
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          return { errorBytes, totalBytes: utf8Length(text), missingNodes };
        }
      }
    }
  } finally {
    cursor.delete();
  }
}
