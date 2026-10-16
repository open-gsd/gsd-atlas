/**
 * The EventSource port (tenant-composition ADR decision 2 and its Phase 1 amendment): the Indexer, not the
 * Host, owns how file events arrive. A production source (the native watcher, plan 02-17) and the manual test
 * double below both satisfy it. Events are an accelerator only: Reconcile repairs anything a source misses.
 */

/** A file in a worktree changed, appeared or went away. `path` is repo-relative POSIX. */
export interface FsChange {
  readonly worktree: string;
  readonly path: string;
}

/** The source lost events (`overflow`) or failed (`error`); the Indexer answers with a Reconcile. */
export interface WatchProblem {
  readonly worktree: string;
  readonly kind: 'error' | 'overflow';
}

/** What a subscription delivers for one worktree root. */
export type SourceEvent =
  | { readonly kind: 'change'; readonly path: string }
  | { readonly kind: 'problem'; readonly problem: 'error' | 'overflow' };

export type SourceHandler = (event: SourceEvent) => void;

export interface EventSource {
  /** Start delivering events for `worktreeRoot`. The returned function stops the subscription. */
  subscribe(worktreeRoot: string, handler: SourceHandler): Promise<() => Promise<void>>;
}

/** A source driven by the test: nothing arrives until `emit` or `emitProblem` is called. */
export interface ManualEventSource {
  readonly source: EventSource;
  /** Deliver a change to every handler subscribed for `worktree`. */
  emit(worktree: string, path: string): void;
  /** Deliver a watcher problem to every handler subscribed for `worktree`. */
  emitProblem(worktree: string, kind: WatchProblem['kind']): void;
  /** How many subscriptions are active right now. */
  subscriptions(): number;
}

export function createManualEventSource(): ManualEventSource {
  const handlers = new Map<string, Set<SourceHandler>>();
  const deliver = (worktree: string, event: SourceEvent): void => {
    for (const handler of [...(handlers.get(worktree) ?? [])]) handler(event);
  };
  const source: EventSource = {
    subscribe(worktreeRoot, handler) {
      const set = handlers.get(worktreeRoot) ?? new Set<SourceHandler>();
      set.add(handler);
      handlers.set(worktreeRoot, set);
      return Promise.resolve(() => {
        set.delete(handler);
        return Promise.resolve();
      });
    },
  };
  return {
    source,
    emit: (worktree, path) => {
      deliver(worktree, { kind: 'change', path });
    },
    emitProblem: (worktree, kind) => {
      deliver(worktree, { kind: 'problem', problem: kind });
    },
    subscriptions: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
  };
}
