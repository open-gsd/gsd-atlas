/**
 * `untilSettled` (plan 02-44): bounded retry of an observation until the product reports a settled state. The sleep is
 * injected, so none of these cases takes wall time.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { untilSettled } from './test-helpers/settle.ts';

/** A probe that answers from `answers` in order and counts its calls. */
function scripted<T>(answers: readonly T[]): { probe: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    probe: () => {
      const answer = answers[Math.min(calls, answers.length - 1)] as T;
      calls += 1;
      return Promise.resolve(answer);
    },
    calls: () => calls,
  };
}

describe('untilSettled', () => {
  it('first settled: a probe that is settled at once is asked once and never sleeps', async () => {
    const slept: number[] = [];
    const { probe, calls } = scripted([{ reconciling: false }]);
    const seen = await untilSettled(probe, (value) => !value.reconciling, {
      attempts: 5,
      delayMs: 100,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    assert.deepEqual(seen, { reconciling: false });
    assert.equal(calls(), 1);
    assert.deepEqual(slept, []);
  });

  it('retries until settled: the first settled observation is returned, the earlier ones are discarded', async () => {
    const { probe, calls } = scripted([{ n: 1, ok: false }, { n: 2, ok: false }, { n: 3, ok: true }, { n: 4, ok: true }]);
    const seen = await untilSettled(probe, (value) => value.ok, { attempts: 10, delayMs: 5, sleep: () => Promise.resolve() });
    assert.deepEqual(seen, { n: 3, ok: true });
    assert.equal(calls(), 3);
  });

  it('exhausted attempts quote the last observation: the error names the number of attempts and the last answer', async () => {
    const { probe, calls } = scripted([{ n: 1, state: 'reconciling' }, { n: 2, state: 'still reconciling' }]);
    await assert.rejects(
      untilSettled(probe, () => false, { attempts: 4, delayMs: 1, sleep: () => Promise.resolve() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /4 attempts/);
        assert.ok(error.message.includes(JSON.stringify({ n: 2, state: 'still reconciling' })), error.message);
        return true;
      },
    );
    assert.equal(calls(), 4);
  });

  it('a throwing probe is not retried: the error propagates at once, so a crash is not mistaken for unsettledness', async () => {
    let calls = 0;
    const crash = new Error('the CLI did not start');
    await assert.rejects(
      untilSettled(
        () => {
          calls += 1;
          return Promise.reject(crash);
        },
        () => true,
        { attempts: 5, delayMs: 1, sleep: () => Promise.resolve() },
      ),
      (error: unknown) => error === crash,
    );
    assert.equal(calls, 1);
  });

  it('sleep between attempts only: one sleep per retry, awaited before the next probe, none before the first', async () => {
    const order: string[] = [];
    let probes = 0;
    await untilSettled(
      () => {
        probes += 1;
        order.push(`probe${String(probes)}`);
        return Promise.resolve(probes);
      },
      (value) => value === 3,
      {
        attempts: 5,
        delayMs: 250,
        sleep: async (ms) => {
          order.push(`sleep${String(ms)}`);
          await Promise.resolve();
          order.push('slept');
        },
      },
    );
    assert.deepEqual(order, ['probe1', 'sleep250', 'slept', 'probe2', 'sleep250', 'slept', 'probe3']);
  });
});
