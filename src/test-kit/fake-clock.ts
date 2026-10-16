import type { Clock } from '../facts/index.ts';

/** A pending wake-up: a sleeper's resolve or an `after` callback. */
interface Timer {
  readonly due: number;
  readonly seq: number;
  readonly fire: () => void;
}

/**
 * Deterministic clock. Time moves only through `advance`. `sleep(ms)` and `after(ms, fn)` stay
 * pending until `advance` moves `now()` to or past their due time.
 */
export class FakeClock implements Clock {
  private current: number;
  private nextSeq = 0;
  private timers: Timer[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.schedule(ms, resolve);
    });
  }

  /**
   * Run `fn` once when time reaches `ms` from now. The returned cancel removes the timer; it is
   * idempotent and does nothing once `fn` has run.
   */
  after(ms: number, fn: () => void): () => void {
    const timer = this.schedule(ms, fn);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /**
   * Move time forward by `ms`, firing due sleepers and `after` callbacks in due-time order (ties
   * in call order). Awaits a microtask turn after each one, so a woken sleeper or a callback can
   * schedule another timer that falls inside the same advance. `advance(0)` fires `sleep(0)`.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers) {
        if (t.due <= target && (next === undefined || t.due < next.due || (t.due === next.due && t.seq < next.seq))) {
          next = t;
        }
      }
      if (next === undefined) {
        break;
      }
      this.timers = this.timers.filter((t) => t !== next);
      this.current = Math.max(this.current, next.due);
      next.fire();
      await Promise.resolve();
    }
    this.current = target;
  }

  private schedule(ms: number, fire: () => void): Timer {
    const timer: Timer = { due: this.current + Math.max(0, ms), seq: this.nextSeq++, fire };
    this.timers.push(timer);
    return timer;
  }
}
