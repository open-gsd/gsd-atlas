/**
 * The coalescing queue (IDX-02, D-12). Events are keyed by (worktree, path). An entry's deadline is the earlier of
 * the last event plus `debounceMs` and the first event plus `maxWaitMs`, so a burst for one path is one job and a
 * continuous stream is still flushed within the maximum wait. Different paths and different worktrees never merge
 * into one entry; entries due at the same moment are delivered together, grouped by worktree, with the paths
 * sorted in code-unit order so the order never depends on arrival order.
 *
 * One timer, armed with `Clock.after`, serves the earliest deadline. A later event can only move a deadline
 * later, never earlier than one already waiting, so a submit normally does not re-arm it; when the timer fires it
 * delivers what is due and re-arms for the next deadline. A path is never processed twice at once: an event for a
 * path whose batch is still running is remembered and becomes one fresh entry when that batch ends.
 */
import type { Clock } from '../facts/index.ts';

export interface CoalescingQueueOptions {
  readonly clock: Clock;
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  /**
   * Called with a worktree, its due paths (sorted, unique) and when each path's entry was first created.
   * A rejection is swallowed: the callee reports its own problems.
   */
  readonly onBatch: (worktree: string, paths: readonly string[], firstAt: ReadonlyMap<string, number>) => Promise<void> | void;
}

export interface CoalescingQueue {
  /** Record an event for `path` of `worktree`. */
  submit(worktree: string, path: string): void;
  /**
   * Take the pending entries for `paths` out of the queue right now and hand them back (path to first-event time,
   * sorted by path). The caller is then responsible for processing them; the queue will not. Paths that are not
   * pending are not in the result. The timer is cancelled when nothing is left waiting.
   */
  flushNow(worktree: string, paths: readonly string[]): ReadonlyMap<string, number>;
  /** Entries waiting for their deadline. */
  pending(): number;
  /** Cancel the timer, drop every entry, and ignore later events. */
  close(): void;
}

interface Entry {
  readonly worktree: string;
  readonly path: string;
  readonly firstAt: number;
  deadline: number;
}

interface Running {
  rerun: boolean;
  /** When the first event that arrived during the run was seen. */
  rerunFirstAt: number;
}

const keyOf = (worktree: string, path: string): string => `${worktree}\0${path}`;
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createCoalescingQueue(options: CoalescingQueueOptions): CoalescingQueue {
  const { clock, debounceMs, maxWaitMs, onBatch } = options;
  const entries = new Map<string, Entry>();
  const running = new Map<string, Running>();
  let timer: { readonly cancel: () => void; readonly due: number } | undefined;
  let closed = false;

  function arm(due: number): void {
    const cancel = clock.after(Math.max(0, due - clock.now()), fire);
    timer = { cancel, due };
  }

  /** Re-arm for the earliest deadline still waiting, or leave no timer at all. */
  function rearm(): void {
    timer = undefined;
    let earliest = Infinity;
    for (const entry of entries.values()) earliest = Math.min(earliest, entry.deadline);
    if (earliest !== Infinity) arm(earliest);
  }

  function enqueue(worktree: string, path: string, firstAt: number): void {
    const now = clock.now();
    const key = keyOf(worktree, path);
    const existing = entries.get(key);
    const first = existing?.firstAt ?? firstAt;
    const deadline = Math.min(now + debounceMs, first + maxWaitMs);
    if (existing === undefined) entries.set(key, { worktree, path, firstAt: first, deadline });
    else existing.deadline = deadline;
    // A deadline is never earlier than one already waiting, except for the rerun of a path that was busy for longer
    // than the maximum wait; that one must not sit behind a later timer.
    if (timer === undefined || deadline < timer.due) {
      timer?.cancel();
      arm(deadline);
    }
  }

  function dispatch(worktree: string, paths: readonly string[], firstAt: ReadonlyMap<string, number>): void {
    for (const path of paths) running.set(keyOf(worktree, path), { rerun: false, rerunFirstAt: 0 });
    let work: Promise<void>;
    try {
      work = Promise.resolve(onBatch(worktree, paths, firstAt));
    } catch {
      work = Promise.resolve();
    }
    void work
      .catch(() => {})
      .then(() => {
        for (const path of paths) {
          const key = keyOf(worktree, path);
          const state = running.get(key);
          running.delete(key);
          if (state?.rerun === true && !closed) enqueue(worktree, path, state.rerunFirstAt);
        }
      });
  }

  function fire(): void {
    timer = undefined;
    if (closed) return;
    const now = clock.now();
    const byWorktree = new Map<string, Entry[]>();
    for (const [key, entry] of entries) {
      if (entry.deadline > now) continue;
      entries.delete(key);
      const group = byWorktree.get(entry.worktree);
      if (group === undefined) byWorktree.set(entry.worktree, [entry]);
      else group.push(entry);
    }
    rearm();
    for (const worktree of [...byWorktree.keys()].sort(compareCodeUnits)) {
      const due = (byWorktree.get(worktree) as Entry[]).sort((a, b) => compareCodeUnits(a.path, b.path));
      dispatch(
        worktree,
        due.map((entry) => entry.path),
        new Map(due.map((entry) => [entry.path, entry.firstAt])),
      );
    }
  }

  return {
    submit(worktree, path) {
      if (closed) return;
      const state = running.get(keyOf(worktree, path));
      if (state !== undefined) {
        if (!state.rerun) {
          state.rerun = true;
          state.rerunFirstAt = clock.now();
        }
        return;
      }
      enqueue(worktree, path, clock.now());
    },

    flushNow(worktree, paths) {
      const taken: Array<[string, number]> = [];
      for (const path of [...new Set(paths)].sort(compareCodeUnits)) {
        const key = keyOf(worktree, path);
        const entry = entries.get(key);
        if (entry === undefined) continue;
        entries.delete(key);
        taken.push([path, entry.firstAt]);
      }
      if (entries.size === 0 && timer !== undefined) {
        timer.cancel();
        timer = undefined;
      }
      return new Map(taken);
    },

    pending: () => entries.size,

    close() {
      closed = true;
      timer?.cancel();
      timer = undefined;
      entries.clear();
    },
  };
}
