/** Injected time source. Production uses `systemClock`; tests use the test kit's FakeClock. */
export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
  /** Resolves after at least `ms` milliseconds of this clock's time. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};
