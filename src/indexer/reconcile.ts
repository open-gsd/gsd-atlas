/**
 * Reconcile (IDX-03, D-13): the correctness mechanism of the Indexer. RED stub: the implementation follows.
 */
import type { Writer } from '../fact-store/index.ts';
import type { ProcessContext } from './process.ts';
import type { ReconcileOutcome } from './types.ts';

export type ReconcilePriority = 'indexing' | 'maintenance';

export interface ReconcileTarget {
  readonly worktree: string;
  readonly ref: string;
}

export function reconcileWorktree(
  _ctx: ProcessContext,
  _writer: Writer,
  _target: ReconcileTarget,
  _priority: ReconcilePriority,
): Promise<ReconcileOutcome> {
  return Promise.reject(new Error('reconcile is not implemented yet'));
}
