import type { TenantTuning } from './types.ts';

/**
 * Source: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved 2026-10-16). Each
 * value is copied from the key named beside it; change the value there first, this object only carries it.
 *
 * - `maintenanceSliceMs`: `maintenance.sliceMs`, the longest single maintenance pause (200 ms).
 * - `startupReconcileDeadlineMs`: `indexer.startupReconcileDeadlineMs`, the longest the first request waits for the
 *   start-up Reconcile before it is answered `reconciling` (1500 ms).
 * - `idleAfterMs`: `maintenance.idleAfterMs`, the quiet time before an idle maintenance round (30000 ms).
 * - `takeoverRetryMinMs` and `takeoverRetryMaxMs`: `lease.retryMinMs` and `lease.retryMaxMs`, the jittered range in
 *   which a follower retries the writer lease (10000 and 30000 ms).
 */
export const DEFAULT_TENANT_TUNING: TenantTuning = {
  maintenanceSliceMs: 200,
  startupReconcileDeadlineMs: 1500,
  idleAfterMs: 30000,
  takeoverRetryMinMs: 10000,
  takeoverRetryMaxMs: 30000,
};
