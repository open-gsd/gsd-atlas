/** Injected time source. Production uses `systemClock`; tests use the test kit's FakeClock. */
export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
  /** Resolves after at least `ms` milliseconds of this clock's time. It can not be cancelled. */
  sleep(ms: number): Promise<void>;
  /**
   * Calls `fn` once after at least `ms` milliseconds of this clock's time and returns a cancel
   * function. Cancel is idempotent and does nothing once `fn` has run. Unlike `sleep`, a
   * cancelled timer leaves nothing pending, so a finished job or a coalesced event does not
   * keep a process alive.
   */
  after(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  // Not unref'd: a pending timer is real work and keeps the process alive until it fires or is cancelled.
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};
