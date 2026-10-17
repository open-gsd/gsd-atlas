import type { Envelope } from '../facts/index.ts';
import type { MetricsEvent } from '../metrics/index.ts';

/** STUB (plan 02-28 RED commit): the real mapping lands in the GREEN commit. */
export function answerEvent(_kind: string, _envelope: Envelope, _latencyMs: number): MetricsEvent | null {
  return null;
}
