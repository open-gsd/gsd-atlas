import type { QueryConfig } from './types.ts';

/**
 * Query's defaults. Every number comes from the user-approved constants table in
 * .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved, 2026-10-16):
 * query.defaultBudgetTokens, query.hardCeilingTokens, query.lineTextMaxChars, query.defaultLimit,
 * query.maxLimit, query.cursorMaxChars and indexer.ensureFreshWaitMs.
 */
export const DEFAULT_QUERY_CONFIG: QueryConfig = Object.freeze({
  defaultBudgetTokens: 2000,
  hardCeilingTokens: 8000,
  lineTextMaxChars: 240,
  defaultLimit: 50,
  maxLimit: 200,
  cursorMaxChars: 1024,
  ensureFreshWaitMs: 2000,
});

const KEYS = Object.keys(DEFAULT_QUERY_CONFIG) as ReadonlyArray<keyof QueryConfig>;

/** The default config with `overrides` on top. A key that is not a finite positive integer is a programming error. */
export function resolveQueryConfig(overrides: Partial<QueryConfig> | undefined): QueryConfig {
  const merged: { -readonly [K in keyof QueryConfig]: QueryConfig[K] } = { ...DEFAULT_QUERY_CONFIG };
  if (overrides === undefined) return merged;
  for (const key of KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`query config ${key} must be a positive integer`);
    }
    merged[key] = value;
  }
  return merged;
}
