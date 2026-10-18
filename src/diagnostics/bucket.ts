/**
 * Fixed buckets (docs/DIAGNOSTICS.md section 3: "sizes and counts are fixed buckets, so exact numbers can't fingerprint a
 * repo"). Every edge list below is the catalog's: it is read off the examples the catalog v1 shows for the field
 * (`2–5`, `6–20`, `51–200`, `10–30 s`, `50–100 MB`, `100K–500K LOC`) and extended in the same style. A bucket is a
 * half-open range [lower edge, next edge), and a label names the range, never the value. A value that is not a
 * non-negative number has no bucket (`null`): nothing is guessed.
 *
 * Changing an edge changes what a published report means, so it is a catalog version change, not an edit.
 */

/** Edges of a count bucket: `0`, `1`, `2–5`, `6–20`, `21+` for [1, 2, 6, 21]. */
export const REPO_COUNT_EDGES: readonly number[] = [1, 2, 6, 21];
export const WORKTREE_COUNT_EDGES: readonly number[] = [1, 2, 6, 21];
export const AGENT_CONCURRENCY_EDGES: readonly number[] = [1, 2, 6, 21, 51, 201];

/** The index of the bucket holding `value`: the number of edges at or below it. */
const slot = (value: number, edges: readonly number[]): number => edges.filter((edge) => value >= edge).length;

/**
 * The label of the range holding the count `value`. Edges ascend from 1; the range below the first edge is `0` when that
 * edge is 1. Returns `null` for a value that is not a whole number of zero or more.
 */
export function bucketCount(value: number, edges: readonly number[]): string | null {
  if (!Number.isInteger(value) || value < 0) return null;
  const at = slot(value, edges);
  const low = at === 0 ? 0 : (edges[at - 1] as number);
  const next = edges[at];
  if (next === undefined) return `${String(low)}+`;
  return next - low === 1 ? String(low) : `${String(low)}–${String(next - 1)}`;
}

const MB = 1_000_000;
const GB = 1_000_000_000;

const BYTE_EDGES: readonly number[] = [MB, 10 * MB, 50 * MB, 100 * MB, 500 * MB, GB, 5 * GB];
const BYTE_LABELS: readonly string[] = ['<1 MB', '1–10 MB', '10–50 MB', '50–100 MB', '100–500 MB', '500 MB–1 GB', '1–5 GB', '5 GB+'];

const MS_EDGES: readonly number[] = [1000, 10_000, 30_000, 60_000, 300_000, 900_000];
const MS_LABELS: readonly string[] = ['<1 s', '1–10 s', '10–30 s', '30–60 s', '1–5 min', '5–15 min', '15 min+'];

const LINE_EDGES: readonly number[] = [1000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000];
const LINE_LABELS: readonly string[] = [
  '<1K LOC',
  '1K–10K LOC',
  '10K–50K LOC',
  '50K–100K LOC',
  '100K–500K LOC',
  '500K–1M LOC',
  '1M–5M LOC',
  '5M+ LOC',
];

function labelled(value: number, edges: readonly number[], labels: readonly string[]): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return labels[slot(value, edges)] ?? null;
}

/** A size in bytes (decimal megabytes and gigabytes), as in `50–100 MB`. */
export const bucketBytes = (bytes: number): string | null => labelled(bytes, BYTE_EDGES, BYTE_LABELS);

/** A duration in milliseconds, as in `10–30 s`. */
export const bucketMs = (ms: number): string | null => labelled(ms, MS_EDGES, MS_LABELS);

/** A size in lines of code, as in `100K–500K LOC`. */
export const bucketLines = (lines: number): string | null => labelled(lines, LINE_EDGES, LINE_LABELS);
