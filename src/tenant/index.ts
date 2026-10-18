/**
 * The Tenant seam (tenant-composition ADR decision 5): the per-repository composition of Source Tree, Fact Store,
 * Indexer, Query and Metrics. Only the Host builds one.
 */
export { createTenant } from './create.ts';
export { DEFAULT_TENANT_TUNING } from './defaults.ts';
export { createFollowerFresh, createOverlayReader } from './follower-overlay.ts';
export type { FollowerFreshDeps, OverlayContext, Patch } from './follower-overlay.ts';
export { createIdleMaintainer } from './idle.ts';
export type { IdleMaintainer, IdleMaintainerOptions } from './idle.ts';
export { leaseHeldEnvelope, notIndexedEnvelope, notIndexedNoStore, storeUnavailableEnvelope } from './messages.ts';
export type { LeaseHolderName } from './messages.ts';
export { CURRENT_FILE as FLIGHT_FILE, createFlightRecorder } from './flight.ts';
export type { FlightEvent, FlightEventInput, FlightFs, FlightRecorder, FlightRecorderOptions } from './flight.ts';
export { answerEvent, flightAnswer, isAnsweredKind } from './record.ts';
export { BUILD_SCHEMA, MAINTAIN_SCHEMA, MAINTAIN_TASKS, STATUS_SCHEMA } from './types.ts';
export type {
  MaintainOptions,
  MaintainTask,
  TaskReport,
  Tenant,
  TenantDeps,
  TenantStatus,
  TenantTuning,
} from './types.ts';
