import type { Governor, GovernorResult, Job, Lease, LeaseKey, LeaseResult } from './types.ts';
import { assertEstimatedBytes, assertJob } from './validate.ts';

/**
 * A Governor that admits everything: it runs each job immediately, never reports busy or
 * timeout, grants every lease and never evicts. It exists for tests and for Phase 1 wiring
 * (D-10); it keeps counters only so `status()` stays truthful. The bounded behaviour is pinned by
 * the fake, and the real Governor lands in Phases 2 and 4.
 */
export function createNoopGovernor(): Governor {
  let running = 0;
  let leases = 0;
  let leasedBytes = 0;

  return {
    async run<T>(job: Job, fn: (signal: AbortSignal) => Promise<T>): Promise<GovernorResult<T>> {
      assertJob(job);
      running += 1;
      try {
        // The signal belongs to a controller nobody holds, so it can never abort.
        return { kind: 'ok', value: await fn(new AbortController().signal) };
      } finally {
        running -= 1;
      }
    },

    async lease(key: LeaseKey, estimatedBytes: number, _onEvict: () => void): Promise<LeaseResult> {
      assertEstimatedBytes(estimatedBytes);
      leases += 1;
      leasedBytes += estimatedBytes;
      let released = false;
      const lease: Lease = {
        key,
        release() {
          if (released) {
            return;
          }
          released = true;
          leases -= 1;
          leasedBytes -= estimatedBytes;
        },
      };
      return { kind: 'ok', lease };
    },

    status() {
      return { queued: 0, running, leases, leasedBytes };
    },
  };
}
