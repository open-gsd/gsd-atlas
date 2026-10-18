import { PRECISE_DEFAULTS } from '../precise-resolver/index.ts';
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
 *
 * Source of the last two: .planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md (Status: Approved
 * 2026-10-18), DIAGNOSTICS.md section 9.1, locked.
 * - `flightMaxEvents`: `recorder.maxEvents`, the events the flight recorder keeps (2000).
 * - `flightMaxBytes`: `recorder.maxBytes`, the bytes the flight recorder keeps (5242880).
 *
 * Plan 03-29 (same file, `precise.*` rows), taken from the precise-resolver's own copy of the approved values so there is one:
 * - `resolveBoundMs`: `precise.requestTimeoutMs`, the bound of the eager pass after a build and of a module command (25000 ms).
 * - `resolveBatchSites`: `precise.sitesPerRequest`, the sites one resolver call of the eager pass carries (2000).
 * - `warmStart`: whether the compiler worker is started in the background over an indexed worktree (true; not a constant).
 */
export const DEFAULT_TENANT_TUNING: TenantTuning = {
  maintenanceSliceMs: 200,
  startupReconcileDeadlineMs: 1500,
  idleAfterMs: 30000,
  takeoverRetryMinMs: 10000,
  takeoverRetryMaxMs: 30000,
  flightMaxEvents: 2000,
  flightMaxBytes: 5242880,
  resolveBoundMs: PRECISE_DEFAULTS.requestTimeoutMs,
  resolveBatchSites: PRECISE_DEFAULTS.sitesPerRequest,
  warmStart: true,
};
