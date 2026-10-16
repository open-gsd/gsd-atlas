/**
 * The one paging mechanism every code tool shares (D-09, research Pattern 9): items arrive already in a total
 * order and carry their sort key; a request resumes strictly after its cursor's key, keeps at most `limit` of
 * them, cuts whole items to the token budget under the hard ceiling and, when it cut anything, issues a keyset
 * cursor at the last item it kept. The mechanism holds nothing between calls: the next page re-queries.
 *
 * It measures the response that will really be sent: `renderEnvelope` builds the envelope for a candidate set of
 * kept items, with the cut markers and the cursor that set would carry.
 */
import type { DegradedCode, Envelope } from '../facts/index.ts';
import { cutToBudget, estimateTokens } from './budget.ts';
import { encodeCursor } from './cursor.ts';
import type { CursorPayload } from './cursor.ts';
import { compareRanked } from './ranking.ts';
import type { SortKey } from './ranking.ts';

/** An item the mechanism can page: it carries the key it is ordered and resumed by. */
export interface Keyed {
  readonly key: SortKey;
}

/** What a response built for a set of kept items must say about the cut. */
export interface PageState {
  /** True when the response leaves something out (a limit, the budget, or more beyond what was given). */
  readonly cut: boolean;
  /** The cursor that continues after the last kept item; null when nothing was cut or the cursor would be too long. */
  readonly more: string | null;
  /** Codes the mechanism adds to the response (`watermark_moved`). */
  readonly degraded: readonly DegradedCode[];
}

export interface PageOptions<T extends Keyed> {
  readonly budgetTokens: number;
  readonly ceilingTokens: number;
  /** The most items one response may carry. */
  readonly limit: number;
  /** The decoded `more` cursor of the request, when it sent one. */
  readonly cursor: CursorPayload | null;
  readonly cursorMaxChars: number;
  /** The hash of the query, carried by every cursor this call issues. */
  readonly queryHash: string;
  /** The watermark seq the response was computed at. */
  readonly watermarkSeq: number;
  /** Build the envelope that carries exactly `kept`. May be asynchronous (line text is read on demand). */
  readonly renderEnvelope: (kept: readonly T[], state: PageState) => Envelope | Promise<Envelope>;
}

export interface Page<T> {
  readonly kept: readonly T[];
  readonly truncated: boolean;
  readonly more: string | null;
  readonly degraded: readonly DegradedCode[];
  /** True when even the first item exceeds the hard ceiling: nothing can be returned. */
  readonly tooLarge: boolean;
  /** The final response; null only when `tooLarge`. */
  readonly envelope: Envelope | null;
}

export async function pageItems<T extends Keyed>(items: readonly T[], options: PageOptions<T>): Promise<Page<T>> {
  // Keyset: resume strictly after the cursor's key.
  const bound = options.cursor?.key;
  const remaining = bound === undefined ? items : items.filter((item) => compareRanked(item.key, bound) > 0);
  const limited = remaining.slice(0, options.limit);
  const limitCut = remaining.length > options.limit;
  const degraded: readonly DegradedCode[] =
    options.cursor !== null && options.cursor.seq !== options.watermarkSeq ? ['watermark_moved'] : [];

  const stateFor = (kept: readonly T[], cut: boolean): PageState => {
    const last = kept[kept.length - 1];
    const more =
      cut && last !== undefined
        ? encodeCursor({ key: last.key, query: options.queryHash, seq: options.watermarkSeq }, options.cursorMaxChars)
        : null;
    return { cut, more, degraded };
  };

  const cut = await cutToBudget(
    limited,
    async (kept, truncated) => estimateTokens(await options.renderEnvelope(kept, stateFor(kept, truncated))),
    { budget: options.budgetTokens, ceiling: options.ceilingTokens },
    limitCut,
  );
  if (cut.tooLarge) return { kept: [], truncated: false, more: null, degraded, tooLarge: true, envelope: null };
  const state = stateFor(cut.kept, cut.truncated);
  return {
    kept: cut.kept,
    truncated: cut.truncated,
    more: state.more,
    degraded,
    tooLarge: false,
    envelope: await options.renderEnvelope(cut.kept, state),
  };
}
