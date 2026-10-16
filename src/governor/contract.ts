import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Governor, GovernorStatus } from './types.ts';

/**
 * Behaviour every Governor must show, whatever its scheduling policy. Test code: it is imported
 * only by governor.test.ts (and any adapter added inside src/governor) and never re-exported
 * from index.ts.
 */
export function defineGovernorContract(label: string, make: () => Governor): void {
  describe(`Governor contract: ${label}`, () => {
    it('returns ok with the value and invokes the function exactly once', async () => {
      const governor = make();
      let calls = 0;
      const result = await governor.run({ tenant: 't', class: 'interactive', cost: 1 }, async () => {
        calls += 1;
        return 42;
      });
      assert.deepEqual(result, { kind: 'ok', value: 42 });
      assert.equal(calls, 1);
    });

    it('passes the function an AbortSignal that is not aborted for a job that completes', async () => {
      const governor = make();
      let seen: AbortSignal | undefined;
      await governor.run({ tenant: 't', class: 'indexing', cost: 1 }, async (signal) => {
        seen = signal;
      });
      assert.ok(seen instanceof AbortSignal);
      assert.equal(seen.aborted, false);
    });

    it('makes run reject with the same error when the function rejects, never busy', async () => {
      const governor = make();
      const boom = new Error('boom');
      await assert.rejects(
        governor.run({ tenant: 't', class: 'maintenance', cost: 1 }, async () => {
          throw boom;
        }),
        (error: unknown) => error === boom,
      );
      assert.equal(governor.status().running, 0);
    });

    it('grants a lease whose release is idempotent', async () => {
      const governor = make();
      const key = { tenant: 't', fileSetId: 'fs-1' };
      const result = await governor.lease(key, 100, () => {});
      assert.equal(result.kind, 'ok');
      if (result.kind !== 'ok') {
        return;
      }
      assert.deepEqual(result.lease.key, key);
      result.lease.release();
      const afterFirst = governor.status();
      result.lease.release();
      assert.deepEqual(governor.status(), afterFirst);
    });

    it('reports status as non-negative integers, idle and while work and a lease are held', async () => {
      const governor = make();
      assertCounters(governor.status());
      const granted = await governor.lease({ tenant: 't', fileSetId: 'fs-1' }, 64, () => {});
      assertCounters(governor.status());
      let during: GovernorStatus | undefined;
      await governor.run({ tenant: 't', class: 'fresh', cost: 1 }, async () => {
        during = governor.status();
      });
      assert.ok(during);
      assertCounters(during);
      assert.equal(during.running, 1);
      if (granted.kind === 'ok') {
        granted.lease.release();
      }
      assertCounters(governor.status());
    });

    it('rejects a negative or fractional byte estimate', async () => {
      const governor = make();
      const key = { tenant: 't', fileSetId: 'fs-1' };
      await assert.rejects(governor.lease(key, -1, () => {}), RangeError);
      await assert.rejects(governor.lease(key, 1.5, () => {}), RangeError);
    });
  });
}

function assertCounters(status: GovernorStatus): void {
  for (const value of [status.queued, status.running, status.leases, status.leasedBytes]) {
    assert.ok(Number.isInteger(value) && value >= 0, `status field ${String(value)} is not a non-negative integer`);
  }
}
