/**
 * Idle scheduling (STO-10, plan 02-28). A request calls `touch()`; when `idleAfterMs` pass without another one, the
 * maintainer runs one round of `run`. It runs at most one round at a time and never re-arms itself: only a request
 * does. A request that arrives during a round makes `shouldYield()` return true, so the round stops at its next
 * check, and the timer is armed again once the round has returned, so the unfinished work resumes after the next
 * quiet period.
 *
 * All waiting goes through the injected `Clock.after`, so a test drives it with a fake clock and `close()` leaves no
 * timer pending.
 */
import type { Clock } from '../facts/index.ts';

export interface IdleMaintainerOptions {
  readonly clock: Clock;
  /** Quiet time before a round, in milliseconds (the approved `maintenance.idleAfterMs`). */
  readonly idleAfterMs: number;
  /**
   * One round of work. It must check `shouldYield()` between its steps and return early when it is true. A rejection
   * goes to `onError`; it never stops later rounds.
   */
  readonly run: (shouldYield: () => boolean) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface IdleMaintainer {
  /** A request happened: cancel the pending timer and arm a fresh one; during a round, ask it to yield. */
  touch(): void;
  /** Cancel the pending timer, ask a round in flight to yield and wait for it to return. Safe to call twice. */
  close(): Promise<void>;
}

export function createIdleMaintainer(options: IdleMaintainerOptions): IdleMaintainer {
  const { clock, idleAfterMs, run, onError } = options;
  let cancel: (() => void) | undefined;
  let closed = false;
  /** The round in flight, if any. */
  let round: Promise<void> | undefined;
  /** Set by `touch()` during a round: the round should stop at its next check. */
  let yielding = false;
  /** Set by `touch()` during a round: arm the timer again when the round returns. */
  let rearm = false;

  const disarm = (): void => {
    cancel?.();
    cancel = undefined;
  };

  const arm = (): void => {
    disarm();
    cancel = clock.after(idleAfterMs, fire);
  };

  function fire(): void {
    cancel = undefined;
    if (closed || round !== undefined) return;
    yielding = false;
    rearm = false;
    const mine: Promise<void> = (async () => {
      try {
        await run(() => yielding);
      } catch (error) {
        try {
          onError(error);
        } catch {
          // the error handler is not allowed to stop the maintainer either
        }
      }
    })().then(() => {
      if (round === mine) round = undefined;
      if (rearm && !closed) arm();
      rearm = false;
    });
    round = mine;
  }

  return {
    touch() {
      if (closed) return;
      if (round !== undefined) {
        yielding = true;
        rearm = true;
        return;
      }
      arm();
    },

    async close() {
      closed = true;
      yielding = true;
      disarm();
      await round;
    },
  };
}
