/**
 * Why an answer is weaker than a full, fresh, precise one. A degraded read returns its data
 * (possibly empty) plus one or more of these codes; it never throws for missing data.
 *
 * The union is exactly these eight codes in Phase 1. New codes must be additive in later phases:
 * consumers treat an unknown code as "degraded, reason unknown" and never fail on it.
 */
export const DEGRADED_CODES = [
  'resolver_failed',
  'resolver_timeout',
  'fresh_timeout',
  'precise_base_commit',
  'precise_unavailable',
  'stale',
  'follower',
  'cache_unavailable',
] as const;

export type DegradedCode = (typeof DEGRADED_CODES)[number];

export function isDegradedCode(value: string): value is DegradedCode {
  return (DEGRADED_CODES as readonly string[]).includes(value);
}
