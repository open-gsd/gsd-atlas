/**
 * A full build of one worktree: Reconcile at the `indexing` priority, reported in the shape a build has. The
 * Fact Store's `reconcile` says which paths need work (changed, new, pending, stale, or gone), so a rebuild of an
 * unchanged tree touches nothing and moves no watermark. See `reconcile.ts` for how a run goes.
 */
import type { Writer } from '../fact-store/index.ts';
import type { ProcessContext } from './process.ts';
import { reconcileWorktree } from './reconcile.ts';
import type { ReconcileObserver } from './reconcile.ts';
import type { BuildResult } from './types.ts';

export interface BuildTarget {
  /** The worktree root, also the Fact Store's worktree id. */
  readonly worktree: string;
  /** The branch or commit the overlay tracks. */
  readonly ref: string;
}

/**
 * Tells the Indexer what a build did path by path, so it can keep its failure list and send notices: the results
 * of the paths it indexed (oversize ones included, as failures) and the paths that left the overlay.
 */
export type BuildObserver = ReconcileObserver;

export async function runBuild(
  ctx: ProcessContext,
  writer: Writer,
  target: BuildTarget,
  observe?: BuildObserver,
): Promise<BuildResult> {
  const report = await reconcileWorktree(ctx, writer, target, 'indexing', observe === undefined ? {} : { observe });
  return {
    files: report.files,
    parsed: report.parsed,
    linked: report.linked,
    removed: report.removed,
    skipped: report.skipped,
    failed: report.failed,
  };
}
