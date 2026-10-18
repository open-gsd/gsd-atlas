/**
 * Why an answer is weaker than a full, fresh, precise one. A degraded read returns its data
 * (possibly empty) plus one or more of these codes; it never throws for missing data.
 *
 * The union is exactly these fourteen codes: the eight of Phase 1, then three added in Phase 2 as
 * the additive rule requires: `reconciling` (D-02, the index is catching up with the truth on
 * disk), `rebuilding` (D-14, the store is being rebuilt) and `watermark_moved` (D-09, the
 * watermark advanced while the answer was computed). Phase 3 adds three more (mcp-contract
 * amendment of 2026-10-18): `memory_budget` (the compiler worker was stopped or not started because
 * of the memory budget; answers are grammar-tier), `compiler_fallback` (a different compiler than the
 * project's own did the resolving, for example the bundled 6.0.3 because the project has none or has
 * 7.x) and `needs_approval` (a tier exists but its command is not approved for this repository).
 * New codes must stay additive in later phases: consumers treat an unknown code as "degraded, reason
 * unknown" and never fail on it.
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
  'memory_budget',
  'compiler_fallback',
  'needs_approval',
] as const;

export type DegradedCode = (typeof DEGRADED_CODES)[number];

export function isDegradedCode(value: string): value is DegradedCode {
  return (DEGRADED_CODES as readonly string[]).includes(value);
}
