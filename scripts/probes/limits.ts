/** The stop rules of the exploratory probes: overage, rate-limit utilisation and a notional cost cap. */
import type { RateLimit } from './stream.ts';

export const LIMITS = { costCapUsd: 12, rateCap: 0.6 } as const;

export interface StopInput {
  /** Sum of `costUsd` over every probe session so far. */
  spentUsd: number;
  /** The most the next session may cost (its `--max-budget-usd`). */
  nextMaxUsd: number;
  rate: RateLimit;
}

/** A reason to stop, or null. */
export function shouldStop(input: StopInput): string | null {
  const { rate } = input;
  if (rate.isUsingOverage === true) return 'overage is in use';
  if (rate.fiveHour !== null && rate.fiveHour >= LIMITS.rateCap) return `five-hour utilization ${String(rate.fiveHour)} is at or over ${String(LIMITS.rateCap)}`;
  if (rate.sevenDay !== null && rate.sevenDay >= LIMITS.rateCap) return `seven-day utilization ${String(rate.sevenDay)} is at or over ${String(LIMITS.rateCap)}`;
  if (input.spentUsd + input.nextMaxUsd > LIMITS.costCapUsd) return `notional cost ${input.spentUsd.toFixed(2)} + next cap ${input.nextMaxUsd.toFixed(2)} would pass ${String(LIMITS.costCapUsd)} USD`;
  return null;
}
