/**
 * The Governor seam (FND-05). Production-safe: the interface plus two doubles. The shared contract
 * suite lives in contract.ts and is test code, so it is deliberately not re-exported here.
 */
export { JOB_CLASSES } from './types.ts';
export type {
  Governor,
  GovernorResult,
  GovernorStatus,
  Job,
  JobClass,
  Lease,
  LeaseKey,
  LeaseResult,
} from './types.ts';
export { createNoopGovernor } from './noop.ts';
export { createFakeGovernor } from './fake.ts';
export type { FakeGovernor, FakeGovernorOptions } from './fake.ts';
export { createGovernor } from './real.ts';
export type { GovernorOptions, RealGovernor } from './real.ts';
export { DEFAULT_GOVERNOR_OPTIONS } from './defaults.ts';
export type { GovernorDefaults } from './defaults.ts';
