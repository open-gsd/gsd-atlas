// Aggregation for measurement A: bytes and estimated tokens per reference and per page, original
// against compact, over a set of recorded atlas results.
import { bytesOf, estimateTokens, renderCompact } from './compact.ts';
import { positionsOfCompact, positionsOfEnvelope } from './citation.ts';
import type { Call } from './stream.ts';

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export interface PageSize {
  readonly tool: string;
  readonly references: number;
  readonly original: number;
  readonly compact: number;
  readonly lean: number;
  /** Bytes of the ` more=<cursor>` header token, which paging needs and no format can drop. */
  readonly cursor: number;
  /** The (path, line) multiset of the original equals that read back out of the compact page. */
  readonly positionsKept: boolean;
}

/** Sizes one recorded atlas result; null when the result is not an atlas envelope. */
export function sizePage(call: Call | undefined, raw: string): PageSize | null {
  const full = renderCompact(raw, call, true);
  const lean = renderCompact(raw, call, false);
  if (full === null || lean === null) return null;
  const keyOf = (list: readonly { path: string; line: number }[]): string[] => list.map((p) => `${p.path}:${String(p.line)}`).sort();
  const before = keyOf(positionsOfEnvelope(raw));
  const after = keyOf(positionsOfCompact(full.text));
  let cursor = 0;
  try {
    const more = (JSON.parse(raw) as { more?: unknown }).more;
    if (typeof more === 'string' && more !== '') cursor = bytesOf(` more=${more}`);
  } catch {
    cursor = 0;
  }
  return {
    tool: full.tool ?? 'unknown',
    references: full.references,
    original: bytesOf(raw),
    compact: bytesOf(full.text),
    lean: bytesOf(lean.text),
    cursor,
    positionsKept: before.length === after.length && before.every((value, index) => value === after[index]),
  };
}

export interface CompactSummary {
  readonly pages: number;
  readonly pagesWithReferences: number;
  readonly references: number;
  readonly originalBytes: number;
  readonly compactBytes: number;
  readonly leanBytes: number;
  /** Aggregate bytes per reference (all bytes of pages with references / their references). */
  readonly perRef: { original: number; compact: number; lean: number; leanNoCursor: number };
  /** Median over pages of bytes per reference. */
  readonly medianPerRef: { original: number; compact: number; lean: number; leanNoCursor: number };
  /** Mean bytes per page, over all pages. */
  readonly perPage: { original: number; compact: number; lean: number };
  readonly cutCompact: number;
  readonly cutLean: number;
  readonly positionsKeptPages: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);

export function summarisePages(pages: readonly PageSize[]): CompactSummary {
  const withRefs = pages.filter((page) => page.references > 0);
  const sum = (list: readonly PageSize[], pick: (page: PageSize) => number): number => list.reduce((total, page) => total + pick(page), 0);
  const refs = sum(withRefs, (p) => p.references);
  const o = sum(withRefs, (p) => p.original);
  const c = sum(withRefs, (p) => p.compact);
  const l = sum(withRefs, (p) => p.lean);
  const lc = l - sum(withRefs, (p) => p.cursor);
  const perPageMedian = (pick: (page: PageSize) => number): number => median(withRefs.map((page) => pick(page) / page.references));
  return {
    pages: pages.length,
    pagesWithReferences: withRefs.length,
    references: refs,
    originalBytes: o,
    compactBytes: c,
    leanBytes: l,
    perRef: { original: ratio(o, refs), compact: ratio(c, refs), lean: ratio(l, refs), leanNoCursor: ratio(lc, refs) },
    medianPerRef: {
      original: perPageMedian((p) => p.original),
      compact: perPageMedian((p) => p.compact),
      lean: perPageMedian((p) => p.lean),
      leanNoCursor: perPageMedian((p) => p.lean - p.cursor),
    },
    perPage: {
      original: ratio(sum(pages, (p) => p.original), pages.length),
      compact: ratio(sum(pages, (p) => p.compact), pages.length),
      lean: ratio(sum(pages, (p) => p.lean), pages.length),
    },
    cutCompact: o === 0 ? 0 : 1 - c / o,
    cutLean: o === 0 ? 0 : 1 - l / o,
    positionsKeptPages: pages.filter((page) => page.positionsKept).length,
  };
}

/** bytes/4 for a byte count, as the design note and `gsd-atlas status` estimate. */
export const tokens = (bytes: number): number => estimateTokens(bytes);
