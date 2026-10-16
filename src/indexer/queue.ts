import type { Clock } from '../facts/index.ts';

export interface CoalescingQueueOptions {
  readonly clock: Clock;
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly onBatch: (worktree: string, paths: readonly string[], firstAt: ReadonlyMap<string, number>) => Promise<void> | void;
}

export interface CoalescingQueue {
  submit(worktree: string, path: string): void;
  flushNow(worktree: string, paths: readonly string[]): ReadonlyMap<string, number>;
  pending(): number;
  close(): void;
}

/** RED stub: replaced by the real queue in the GREEN commit of this task. */
export function createCoalescingQueue(_options: CoalescingQueueOptions): CoalescingQueue {
  const notYet = (what: string): Error => new Error(`the coalescing queue ${what} is not implemented yet`);
  return {
    submit: () => {
      throw notYet('submit');
    },
    flushNow: () => {
      throw notYet('flushNow');
    },
    pending: () => {
      throw notYet('pending');
    },
    close: () => {
      throw notYet('close');
    },
  };
}
