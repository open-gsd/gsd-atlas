/**
 * `maintain`: collect, compact and check inside one budget (STO-10, plan 02-18). The Host's idle loop calls it
 * (plan 02-28); the store takes the writer slot around it (store.ts).
 */
import type { Clock } from '../facts/index.ts';
import { lifecycleTestHooks } from './lifecycle.ts';
import type { CheckResult, MaintenanceOptions, MaintenanceResult } from './types.ts';

/** The three upkeep tasks `maintainStore` runs, as the store provides them. */
export interface MaintainTasks {
  collect(options: MaintenanceOptions): Promise<MaintenanceResult>;
  compact(options: MaintenanceOptions): Promise<MaintenanceResult>;
  check(): Promise<CheckResult>;
}

/**
 * Run `collect`, then `compact`, then `check`. Collect gets half of the budget; compact gets a third and
 * whatever collect left unused; check is a single pass and takes the rest, so it is not given a budget. Time
 * collect overspends is not taken back from compact, which keeps its third: a task always does one unit of
 * work, so a tiny budget still makes progress on every call.
 *
 * `complete` is true only when collect and compact both finished (check always runs to its end);
 * `processed` adds collected files, pages returned to the file system and, when the check failed and the store
 * was rebuilt, the problem lines. `compact` is called without `full`: a full VACUUM is never an idle task.
 */
export async function maintainStore(tasks: MaintainTasks, clock: Clock, budgetMs: number): Promise<MaintenanceResult> {
  const started = clock.now();
  const collectShare = Math.floor(budgetMs / 2);

  lifecycleTestHooks.onTask?.('collect');
  const collected = await tasks.collect({ budgetMs: collectShare });
  const unused = Math.max(0, collectShare - collected.spentMs);

  lifecycleTestHooks.onTask?.('compact');
  const compacted = await tasks.compact({ budgetMs: Math.floor(budgetMs / 3) + unused });

  lifecycleTestHooks.onTask?.('check');
  const checked = await tasks.check();

  return {
    complete: collected.complete && compacted.complete,
    spentMs: clock.now() - started,
    processed: collected.processed + compacted.processed + (checked.ok ? 0 : checked.problems.length),
  };
}
