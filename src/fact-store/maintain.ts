/**
 * `maintain`: collect, compact and check inside one budget (STO-10, plan 02-18). The Host's idle loop calls it
 * (plan 02-28); the store takes the writer slot around it (store.ts).
 */
import type { Clock } from '../facts/index.ts';
import { lifecycleTestHooks } from './lifecycle.ts';
import type { CheckResult, MaintenanceOptions, MaintenanceResult, StoreMaintainOptions } from './types.ts';

/** The three upkeep tasks `maintainStore` runs, as the store provides them. */
export interface MaintainTasks {
  collect(options: MaintenanceOptions): Promise<MaintenanceResult>;
  compact(options: MaintenanceOptions): Promise<MaintenanceResult>;
  check(): Promise<CheckResult>;
}

/**
 * The one policy of the Host's idle loop and of the size gate (STO-05, D-16): ask for a full compaction. It still
 * vacuums only past the recorded thresholds (`compact.fullFreeFraction`, `compact.fullUnusedFraction`) and only after
 * the collect step of the same call finished. Frozen, so a caller cannot change the policy for everyone else.
 */
export const IDLE_MAINTENANCE: StoreMaintainOptions = Object.freeze({ full: true });

/**
 * Run `collect`, then `compact`, then `check`. Collect gets half of the budget; compact gets a third and
 * whatever collect left unused; check is a single pass and takes the rest, so it is not given a budget. Time
 * collect overspends is not taken back from compact, which keeps its third: a task always does one unit of
 * work, so a tiny budget still makes progress on every call.
 *
 * `complete` is true only when collect and compact both finished (check always runs to its end);
 * `processed` adds collected files, pages returned to the file system and, when the check failed and the store
 * was rebuilt, the problem lines. A full VACUUM is an idle task when requested (`options.full`), never when not
 * requested, and never in a call whose collect did not finish: vacuuming before the retired rows are deleted would
 * copy rows that are about to go.
 */
export async function maintainStore(
  tasks: MaintainTasks,
  clock: Clock,
  budgetMs: number,
  options?: StoreMaintainOptions,
): Promise<MaintenanceResult> {
  const started = clock.now();
  const collectShare = Math.floor(budgetMs / 2);

  lifecycleTestHooks.onTask?.('collect');
  const collected = await tasks.collect({ budgetMs: collectShare });
  const unused = Math.max(0, collectShare - collected.spentMs);

  lifecycleTestHooks.onTask?.('compact');
  const compactBudget = Math.floor(budgetMs / 3) + unused;
  const compacted = await tasks.compact(
    options?.full === true && collected.complete
      ? { budgetMs: compactBudget, full: true, afterChurn: collected.processed > 0 }
      : { budgetMs: compactBudget },
  );

  lifecycleTestHooks.onTask?.('check');
  const checked = await tasks.check();

  return {
    complete: collected.complete && compacted.complete,
    spentMs: clock.now() - started,
    processed: collected.processed + compacted.processed + (checked.ok ? 0 : checked.problems.length),
  };
}
