/**
 * The Tenant seam (tenant-composition ADR decision 5): the per-repository composition of Source Tree, Fact Store,
 * Indexer, Query and Metrics. Only the Host builds one.
 */
export { createTenant } from './create.ts';
export { DEFAULT_TENANT_TUNING } from './defaults.ts';
export { createIdleMaintainer } from './idle.ts';
export type { IdleMaintainer, IdleMaintainerOptions } from './idle.ts';
export { answerEvent } from './record.ts';
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
