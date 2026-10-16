/**
 * Why an answer is weaker than a full, fresh, precise one. A degraded read returns its data
 * (possibly empty) plus one or more of these codes; it never throws for missing data.
 *
 * The union is exactly these eleven codes: the eight of Phase 1, then three added in Phase 2 as
 * the additive rule requires: `reconciling` (D-02, the index is catching up with the truth on
 * disk), `rebuilding` (D-14, the store is being rebuilt) and `watermark_moved` (D-09, the
 * watermark advanced while the answer was computed). New codes must stay additive in later
 * phases: consumers treat an unknown code as "degraded, reason unknown" and never fail on it.
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
  'reconciling',
  'rebuilding',
  'watermark_moved',
] as const;

export type DegradedCode = (typeof DEGRADED_CODES)[number];

export function isDegradedCode(value: string): value is DegradedCode {
  return (DEGRADED_CODES as readonly string[]).includes(value);
}
