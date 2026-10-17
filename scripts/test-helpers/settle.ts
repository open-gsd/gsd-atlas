/**
 * Wait for the product to report a settled state before a test compares two snapshots of it (plan 02-44).
 *
 * Two processes (a CLI run and an MCP server) each start their own Reconcile, and each answers the moment it is asked
 * (D-02: at most the approved start-up deadline, then honestly `reconciling`). A comparison of two answers is therefore
 * only meaningful when both are at rest. `untilSettled` asks again, with a pause between asks, until the answer
 * satisfies the predicate, and fails with the last observation when it never does, so a Reconcile that never ends still
 * fails the test. A probe that throws is not retried: a crash is not unsettledness.
 */

export interface SettleOptions {
  /** The most probes made, the first included. */
  readonly attempts: number;
  /** The pause between two probes, in milliseconds. */
  readonly delayMs: number;
  /** The pause itself; a timer by default. Injected by the unit tests so they take no wall time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const timer = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The first observation from `probe` that `isSettled` accepts; throws with the last observation after `attempts` probes. */
export async function untilSettled<T>(probe: () => Promise<T>, isSettled: (observation: T) => boolean, options: SettleOptions): Promise<T> {
  const sleep = options.sleep ?? timer;
  let last: T | undefined;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (attempt > 1) await sleep(options.delayMs);
    last = await probe();
    if (isSettled(last)) return last;
  }
  throw new Error(`the product did not settle within ${String(options.attempts)} attempts; the last observation was ${JSON.stringify(last)}`);
}
