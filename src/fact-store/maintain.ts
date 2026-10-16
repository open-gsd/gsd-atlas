/**
 * `maintain`: collect, compact and check inside one budget (STO-10, plan 02-18).
 *
 * Unimplemented in this commit: the tests that drive it are written first.
 */
import type { Clock } from '../facts/index.ts';
import type { CheckResult, MaintenanceOptions, MaintenanceResult } from './types.ts';

/** The three upkeep tasks `maintainStore` runs, as the store provides them. */
export interface MaintainTasks {
  collect(options: MaintenanceOptions): Promise<MaintenanceResult>;
  compact(options: MaintenanceOptions): Promise<MaintenanceResult>;
  check(): Promise<CheckResult>;
}

export async function maintainStore(_tasks: MaintainTasks, _clock: Clock, _budgetMs: number): Promise<MaintenanceResult> {
  throw new Error('maintainStore is not implemented yet');
}
