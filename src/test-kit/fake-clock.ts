import type { Clock } from '../facts/index.ts';

interface Sleeper {
  readonly due: number;
  readonly seq: number;
  readonly resolve: () => void;
}

/**
 * Deterministic clock. Time moves only through `advance`. `sleep(ms)` stays pending until
 * `advance` moves `now()` to or past its due time.
 */
export class FakeClock implements Clock {
  private current: number;
  private nextSeq = 0;
  private sleepers: Sleeper[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepers.push({ due: this.current + Math.max(0, ms), seq: this.nextSeq++, resolve });
    });
  }

  /**
   * Move time forward by `ms`, waking due sleepers in due-time order (ties in call order).
   * Awaits a microtask turn after each wake, so a woken sleeper can schedule another sleep that
   * falls inside the same advance. `advance(0)` wakes `sleep(0)`.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      let next: Sleeper | undefined;
      for (const s of this.sleepers) {
        if (s.due <= target && (next === undefined || s.due < next.due || (s.due === next.due && s.seq < next.seq))) {
          next = s;
        }
      }
      if (next === undefined) {
        break;
      }
      this.sleepers = this.sleepers.filter((s) => s !== next);
      this.current = Math.max(this.current, next.due);
      next.resolve();
      await Promise.resolve();
    }
    this.current = target;
  }
}
