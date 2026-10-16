/**
 * The EventSource port (tenant-composition ADR decision 2 and its Phase 1 amendment): the Indexer, not the
 * Host, owns how file events arrive. A production source (the native watcher, plan 02-17) and the manual test
 * double below both satisfy it. Events are an accelerator only: Reconcile repairs anything a source misses.
 *
 * Two kinds of subscription exist. A file watch is per worktree root and delivers `change` events: the kind of
 * change (create, update, delete) is deliberately not part of the event, because the native watcher reports a
 * modification as a create and an atomic-rename save as a delete plus a create, so every event means only "hash
 * this path". A git watch is one per repository, on the common git directory: it delivers `head` events (a
 * branch switch or checkout in the main worktree, or in the linked worktree of that git directory name) and
 * `worktrees` events (a worktree was added or removed).
 */
import { gitDirNameOf } from './git-dir.ts';

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

/** How file events arrive: from the operating system (`native`), by scanning (`poll`), or not at all. */
export type WatchMode = 'native' | 'poll' | 'reconcile-only';

/** What a file subscription delivers for one worktree root. */
export type SourceEvent =
  | { readonly kind: 'change'; readonly path: string }
  | { readonly kind: 'problem'; readonly problem: 'error' | 'overflow' };

export type SourceHandler = (event: SourceEvent) => void;

/**
 * What the git subscription delivers. `gitDirName` is `''` for the main worktree and the name under
 * `<common git directory>/worktrees/` for a linked one.
 */
export type GitSourceEvent =
  | { readonly kind: 'head'; readonly gitDirName: string }
  | { readonly kind: 'worktrees' }
  | { readonly kind: 'problem'; readonly problem: 'error' | 'overflow' };

export type GitHandler = (event: GitSourceEvent) => void;

export interface EventSource {
  /** Start delivering file events for `worktreeRoot`. The returned function stops the subscription. */
  subscribe(worktreeRoot: string, handler: SourceHandler): Promise<() => Promise<void>>;
  /**
   * Start delivering git-directory events for the repository whose common git directory is `commonDir`: HEAD
   * changes of every worktree, and worktrees added or removed. Objects, logs, lock files, hooks and `info` never
   * produce an event.
   */
  subscribeGit(commonDir: string, handler: GitHandler): Promise<() => Promise<void>>;
  /** How events arrive right now. A source whose watcher could not start reports `reconcile-only`. */
  watchMode(): WatchMode;
  /**
   * Optional start-up hint: remember the state of `worktreeRoot` so a later `eventsSince` can name what changed
   * while nothing was watching. Reconcile is authoritative; a failure here is ignored by the Indexer.
   */
  writeSnapshot?(worktreeRoot: string): Promise<void>;
  /** Optional start-up hint: repo-relative paths that changed since `writeSnapshot`, in no particular order. */
  eventsSince?(worktreeRoot: string): Promise<readonly string[]>;
}

/** A source driven by the test: nothing arrives until `emit` or `emitProblem` is called. */
export interface ManualEventSource {
  readonly source: EventSource;
  /** Deliver a change to every handler subscribed for `worktree`. */
  emit(worktree: string, path: string): void;
  /** Deliver a watcher problem to every handler subscribed for `worktree`. */
  emitProblem(worktree: string, kind: WatchProblem['kind']): void;
  /**
   * Deliver a HEAD change of `worktree` to the git handlers: the git directory name is read from the worktree's
   * `.git` the way production does, so a worktree whose `.git` does not lead into the subscribed git directory
   * delivers nothing.
   */
  emitHead(worktree: string): void;
  /** Deliver "a worktree was added or removed" to the git handlers. */
  emitWorktrees(): void;
  /** Deliver a problem of the git watch to the git handlers. */
  emitGitProblem(kind: WatchProblem['kind']): void;
  /** How many file subscriptions are active right now. */
  subscriptions(): number;
  /** The common git directories with an active git subscription, one entry per subscription. */
  gitSubscriptions(): readonly string[];
}

export function createManualEventSource(): ManualEventSource {
  const handlers = new Map<string, Set<SourceHandler>>();
  const gitHandlers = new Set<{ readonly commonDir: string; readonly handler: GitHandler }>();
  const deliver = (worktree: string, event: SourceEvent): void => {
    for (const handler of [...(handlers.get(worktree) ?? [])]) handler(event);
  };
  const deliverGit = (event: (commonDir: string) => GitSourceEvent | null): void => {
    for (const entry of [...gitHandlers]) {
      const next = event(entry.commonDir);
      if (next !== null) entry.handler(next);
    }
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
    subscribeGit(commonDir, handler) {
      const entry = { commonDir, handler };
      gitHandlers.add(entry);
      return Promise.resolve(() => {
        gitHandlers.delete(entry);
        return Promise.resolve();
      });
    },
    watchMode: () => 'native',
  };
  return {
    source,
    emit: (worktree, path) => {
      deliver(worktree, { kind: 'change', path });
    },
    emitProblem: (worktree, kind) => {
      deliver(worktree, { kind: 'problem', problem: kind });
    },
    emitHead: (worktree) => {
      deliverGit((commonDir) => {
        const gitDirName = gitDirNameOf(worktree, commonDir);
        return gitDirName === null ? null : { kind: 'head', gitDirName };
      });
    },
    emitWorktrees: () => {
      deliverGit(() => ({ kind: 'worktrees' }));
    },
    emitGitProblem: (kind) => {
      deliverGit(() => ({ kind: 'problem', problem: kind }));
    },
    subscriptions: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
    gitSubscriptions: () => [...gitHandlers].map((entry) => entry.commonDir),
  };
}
