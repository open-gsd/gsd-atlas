/**
 * Ratings (plan 03-17, SKL-02, D-16): a person rates the newest answer, a feature or the session; the Tenant turns that
 * into one closed `rating` event for Metrics and says whether it was written. The answer id comes from the flight
 * recorder, because the process that answered is usually not the process that rates. Nothing here reads an answer.
 */
import { okEnvelope } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import type { Metrics, RatingEvent, RatingFeature, RatingScope, RatingValue } from '../metrics/index.ts';
import { errorEnvelope } from '../query/index.ts';
import type { FlightRecorder } from './flight.ts';

/** Schema of a `rate` reply. */
export const RATE_SCHEMA = 'gsd-atlas.rate/1';

/** What the Host hands the Tenant after it checked the arguments of a `rate` request. */
export interface RateInput {
  readonly scope: RatingScope;
  readonly value: RatingValue;
  /** `scope: 'feature'` only. */
  readonly feature?: RatingFeature | undefined;
  /** `scope: 'answer'` only; absent means the newest recorded answer. */
  readonly answerId?: string | undefined;
}

export interface RateDeps {
  readonly metrics: Metrics;
  /** Null when the user turned recording off. */
  readonly flight: FlightRecorder | null;
}

const NO_ANSWER = 'There is no recent answer to rate. Ask a question first, or name an answer with its answer id.';
const NO_SESSION = 'There is no recent session to rate. Ask a question first.';

/** The error for a scope with nothing to rate yet. A feature always has a name, so it never lacks a target. */
export function noRecentEnvelope(scope: RatingScope): Envelope {
  return scope === 'session' ? errorEnvelope('no_recent_session', NO_SESSION) : errorEnvelope('no_recent_answer', NO_ANSWER);
}

/** The event to record for `input`, or the error that ends the request. */
function eventFor(flight: FlightRecorder | null, input: RateInput): { readonly event: RatingEvent } | { readonly refused: Envelope } {
  if (input.scope === 'answer') {
    const answerId = input.answerId ?? flight?.lastAnswer()?.id;
    if (answerId === undefined) return { refused: noRecentEnvelope('answer') };
    return { event: { kind: 'rating', scope: 'answer', value: input.value, answerId } };
  }
  if (input.scope === 'feature') {
    if (input.feature === undefined) return { refused: errorEnvelope('invalid_args', 'feature: a feature rating needs a feature name.') };
    return { event: { kind: 'rating', scope: 'feature', value: input.value, feature: input.feature } };
  }
  const sessionId = flight?.sessionId();
  if (sessionId === undefined || sessionId === null) return { refused: noRecentEnvelope('session') };
  return { event: { kind: 'rating', scope: 'session', value: input.value, sessionId } };
}

/**
 * Record `event` and write it now. True only when this rating reached the database: Metrics did not refuse it, drop it
 * or fail to write, and nothing is left in its queue. Never throws; a Metrics double that throws counts as not saved.
 */
async function save(metrics: Metrics, event: RatingEvent): Promise<boolean> {
  try {
    const before = metrics.status();
    metrics.record(event);
    await metrics.flush();
    const after = metrics.status();
    return (
      after.recording &&
      after.queued === 0 &&
      after.rejected === before.rejected &&
      after.dropped === before.dropped &&
      after.writeFailures === before.writeFailures
    );
  } catch {
    return false;
  }
}

/** What a saved rating tells the caller: the closed value and the one reference, never anything about the answer. */
function dataFor(event: RatingEvent): Record<string, unknown> {
  const base = { recorded: true, scope: event.scope, value: event.value };
  if (event.scope === 'answer') return { ...base, answer_id: event.answerId };
  if (event.scope === 'feature') return { ...base, feature: event.feature };
  return { ...base, session_id: event.sessionId };
}

/** The `rate` reply. A rating that could not be written is an error envelope with its own code, never a throw. */
export async function recordRating(deps: RateDeps, input: RateInput): Promise<Envelope> {
  const target = eventFor(deps.flight, input);
  if ('refused' in target) return target.refused;
  if (!(await save(deps.metrics, target.event))) {
    return errorEnvelope('rating_not_saved', 'The rating could not be saved, so nothing was recorded. Try again later.');
  }
  return okEnvelope(RATE_SCHEMA, dataFor(target.event));
}
