/**
 * The token budget (D-09, research Pattern 9). The estimate is the serialized envelope's length in UTF-16 code
 * units divided by four, rounded up; items are cut whole, never inside a citation. The hard ceiling applies
 * whatever budget was asked for, and the one case where a response may exceed the budget is a first item that
 * alone does not fit (it is still held under the ceiling).
 */

export interface Cut<T> {
  /** The longest prefix of the items that fits. */
  readonly kept: readonly T[];
  /** True when anything was left out, or when more lies beyond the items given. */
  readonly truncated: boolean;
  /** Index of the last kept item; -1 when none were kept. */
  readonly lastIndex: number;
  /** True when even the first item exceeds the hard ceiling: nothing can be returned. */
  readonly tooLarge: boolean;
}

/** `ceil(characters / 4)` over the whole serialized envelope. An estimate, labelled as one wherever it is shown. */
export function estimateTokens(envelope: unknown): number {
  return Math.ceil(JSON.stringify(envelope).length / 4);
}

/**
 * Keep the longest prefix of `items` whose response fits. `measure(kept, truncated)` returns the estimated size
 * of the response that would carry exactly those items, with the cut markers (`truncated`, the cursor) when
 * `truncated` is true; the cut is therefore judged on the response that will really be sent. `moreBeyond` says
 * that further items exist past the ones given (a limit cut), so a response that keeps them all still carries
 * a cursor.
 */
export async function cutToBudget<T>(
  items: readonly T[],
  measure: (kept: readonly T[], truncated: boolean) => number | Promise<number>,
  limits: { readonly budget: number; readonly ceiling: number },
  moreBeyond: boolean,
): Promise<Cut<T>> {
  const effective = Math.min(limits.budget, limits.ceiling);
  const count = items.length;
  let keptCount = 0;
  for (let i = 0; i < count; i += 1) {
    const size = await measure(items.slice(0, i + 1), i < count - 1 || moreBeyond);
    if (size <= effective) {
      keptCount = i + 1;
      continue;
    }
    if (i === 0) {
      if (size > limits.ceiling) return { kept: [], truncated: false, lastIndex: -1, tooLarge: true };
      keptCount = 1; // the first item alone does not fit the budget: return it anyway, under the ceiling
    }
    break;
  }
  return {
    kept: items.slice(0, keptCount),
    truncated: keptCount < count || moreBeyond,
    lastIndex: keptCount - 1,
    tooLarge: false,
  };
}
