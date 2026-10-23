// Measurement B: replay the recorded atlas calls of a session against a hypothetical merged tool
// (`atlas_explore`) and count the calls the merge could remove. An UPPER BOUND on what the recorded
// behaviour allows; never a prediction of what a model would do with a merged tool.
import { atlasTool, isAtlasCall } from './stream.ts';
import type { Call, Session } from './stream.ts';

/** The tools a single explore call could plausibly stand in for. */
export const MERGEABLE = new Set(['code_find', 'code_refs', 'code_context', 'code_impact']);

export interface MergeResult {
  /** Mergeable atlas calls of the session. */
  readonly calls: number;
  /** Calls after the strict rule: contiguous runs on one symbol name become one call. */
  readonly strictGroups: number;
  readonly strictSaved: number;
  /** Loose bound: every mergeable call of the session becomes one call. */
  readonly looseSaved: number;
  /** Calls saved that were `more` page continuations (a subset of the strict saving). */
  readonly continuationsSaved: number;
}

/** The symbol a call is about: the `name` input, lower-cased; null when the call has none. */
export function symbolOf(call: Call): string | null {
  const name = call.input.name;
  return typeof name === 'string' && name !== '' ? name.toLowerCase() : null;
}

export function mergeReplay(session: Session): MergeResult {
  const mergeable = session.calls.filter((call) => isAtlasCall(call) && MERGEABLE.has(atlasTool(call)));
  let groups = 0;
  let previous: string | null | undefined;
  let continuations = 0;
  for (const call of mergeable) {
    const symbol = symbolOf(call);
    const joins = previous !== undefined && symbol !== null && symbol === previous;
    if (joins) {
      if (typeof call.input.more === 'string') continuations += 1;
    } else {
      groups += 1;
    }
    previous = symbol;
  }
  const calls = mergeable.length;
  return {
    calls,
    strictGroups: groups,
    strictSaved: calls - groups,
    looseSaved: calls === 0 ? 0 : calls - 1,
    continuationsSaved: continuations,
  };
}

export interface MergeSummary {
  readonly sessions: number;
  readonly calledSessions: number;
  readonly calls: number;
  readonly strictSaved: number;
  readonly looseSaved: number;
  readonly continuationsSaved: number;
  /** Sessions with a call where the strict rule saves nothing. */
  readonly calledNothingToMerge: number;
  /** Calls per called session: value -> sessions. */
  readonly callsHistogram: ReadonlyMap<number, number>;
  /** Calls saved (strict) per called session: value -> sessions. */
  readonly savedHistogram: ReadonlyMap<number, number>;
  readonly meanCallsPerCalled: number;
  readonly sessionsWithStrictSaving: number;
}

export function summariseMerge(sessions: readonly Session[]): MergeSummary {
  const callsHistogram = new Map<number, number>();
  const savedHistogram = new Map<number, number>();
  let calledSessions = 0;
  let calls = 0;
  let strictSaved = 0;
  let looseSaved = 0;
  let continuationsSaved = 0;
  let nothing = 0;
  let withSaving = 0;
  for (const session of sessions) {
    const result = mergeReplay(session);
    if (result.calls === 0) continue;
    calledSessions += 1;
    calls += result.calls;
    strictSaved += result.strictSaved;
    looseSaved += result.looseSaved;
    continuationsSaved += result.continuationsSaved;
    if (result.strictSaved === 0) nothing += 1;
    else withSaving += 1;
    callsHistogram.set(result.calls, (callsHistogram.get(result.calls) ?? 0) + 1);
    savedHistogram.set(result.strictSaved, (savedHistogram.get(result.strictSaved) ?? 0) + 1);
  }
  return {
    sessions: sessions.length,
    calledSessions,
    calls,
    strictSaved,
    looseSaved,
    continuationsSaved,
    calledNothingToMerge: nothing,
    callsHistogram,
    savedHistogram,
    meanCallsPerCalled: calledSessions === 0 ? 0 : calls / calledSessions,
    sessionsWithStrictSaving: withSaving,
  };
}
