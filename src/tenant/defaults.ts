import type { TenantTuning } from './types.ts';

/**
 * Source: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved 2026-10-16),
 * key `maintenance.sliceMs` (the longest single maintenance pause, 200 ms). Change the value there first; this
 * object only carries it. Plan 02-28 adds the start-up deadline, idle and takeover keys to this same object.
 */
export const DEFAULT_TENANT_TUNING: TenantTuning = {
  maintenanceSliceMs: 200,
};
