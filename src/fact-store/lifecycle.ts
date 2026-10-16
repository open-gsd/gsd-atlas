/**
 * The store's upkeep (STO-05, STO-10, D-16): collect retired versions, compact the file, check it.
 *
 * Unimplemented in this commit: the tests that drive it are written first (plan 02-18).
 */

/** Test-only hooks, in the way of `recoveryCounters` in recovery.ts. Never set outside a test. */
export const lifecycleTestHooks: {
  /** Called after `collect` chose the hashes of a chunk and before it deletes them (the revival race). */
  onSelected?: (hashes: readonly string[]) => void | Promise<void>;
  /** Called after every incremental-vacuum slice with the pages asked for and the real time it took. */
  onSlice?: (slice: { readonly pages: number; readonly ms: number }) => void;
} = {};
