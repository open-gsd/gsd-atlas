import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineGrammarEngineContract, loadToyScenarios } from '../contract.ts';
import { GrammarRunError, GRAMMAR_LIMITS } from '../index.ts';
import type { GrammarInput } from '../index.ts';
import { createPooledGrammarEngine } from './pool.ts';
import { resolveWorkerUrl } from './worker-url.ts';

// The pooled engine passes the same contract as the in-process engine (LNG-07, LNG-08 through the pool).
defineGrammarEngineContract('pooled', () => createPooledGrammarEngine({ size: 1 }));

/** The supervision fixture: a worker that speaks the protocol and spins, crashes or throws on request. */
const SPIN_WORKER = new URL('./__fixtures__/spin-worker.ts', import.meta.url);

function isRunError(code: string, messagePattern?: RegExp) {
  return (error: unknown): boolean =>
    error instanceof GrammarRunError &&
    error.code === code &&
    (messagePattern === undefined || messagePattern.test(error.message));
}

describe('resolveWorkerUrl', () => {
  it('names worker.ts when this module is a .ts file', () => {
    const url = resolveWorkerUrl();
    assert.equal(url.protocol, 'file:');
    assert.ok(url.pathname.endsWith('/pool/worker.ts'), url.href);
  });

  it('names worker.js when the module is compiled', () => {
    const url = resolveWorkerUrl('file:///opt/app/dist/grammar-engine/pool/worker-url.js');
    assert.equal(url.href, 'file:///opt/app/dist/grammar-engine/pool/worker.js');
  });
});

describe('pooled engine against the in-process engine', () => {
  it('returns deep-equal results for every toy source', async () => {
    // `scenarios.expected` holds the real in-process engine's result for every source (see contract.ts).
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 1 });
    try {
      const grammar = await pooled.load(scenarios.input);
      assert.equal(grammar.abi, scenarios.abi);
      for (const [label, source] of Object.entries(scenarios.sources)) {
        assert.deepStrictEqual(await grammar.run(source), scenarios.expected.get(source), label);
      }
    } finally {
      await pooled.dispose();
    }
  });

  it('keeps the error class and code across the thread boundary', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 1 });
    try {
      const grammar = await pooled.load(scenarios.input);
      await assert.rejects(grammar.run('#'.repeat(GRAMMAR_LIMITS.sourceBytes + 1)), isRunError('source_too_large'));
      // The failed run leaves the worker usable.
      assert.equal((await grammar.run(scenarios.sources.basic)).hadBom, false);
    } finally {
      await pooled.dispose();
    }
  });

  it('leaves no live worker after dispose, and disposing twice is safe', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 1 });
    const grammar = await pooled.load(scenarios.input);
    await grammar.run(scenarios.sources.basic);
    assert.equal(pooled.poolStatus().workers, 1);
    await pooled.dispose();
    await pooled.dispose();
    assert.equal(pooled.poolStatus().workers, 0);
    // The runner finishing without a forced exit is the proof that no handle is left behind.
  });
});

describe('pool scheduling', () => {
  it('runs twelve concurrent runs on three workers, never more than three at once, with the sequential results', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 3 });
    try {
      const grammar = await pooled.load(scenarios.input);
      const sources = Object.values(scenarios.sources);
      const inputs = Array.from({ length: 12 }, (_, index) => sources[index % sources.length] ?? '');
      let maxBusy = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          maxBusy = Math.max(maxBusy, pooled.poolStatus().busy);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      })();
      const pending = inputs.map((source) => grammar.run(source));
      let results: Awaited<typeof pending>;
      try {
        const submitted = pooled.poolStatus();
        assert.equal(submitted.workers, 3);
        assert.equal(submitted.busy, 3);
        assert.equal(submitted.queued, 9);
        results = await Promise.all(pending);
      } finally {
        sampling = false;
        await sampler;
      }
      assert.ok(maxBusy <= 3, `busy reached ${String(maxBusy)}`);
      assert.equal(results.length, 12);
      results.forEach((result, index) => {
        assert.deepStrictEqual(result, scenarios.expected.get(inputs[index] ?? ''), `run ${String(index)}`);
      });
      const settled = pooled.poolStatus();
      assert.equal(settled.busy, 0);
      assert.equal(settled.queued, 0);
      assert.equal(settled.workers, 3);
    } finally {
      await pooled.dispose();
    }
  });

  it('answers queued runs in first-in first-out order on one worker', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 1 });
    try {
      const grammar = await pooled.load(scenarios.input);
      const order: number[] = [];
      const sources = Object.values(scenarios.sources);
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          grammar.run(sources[index % sources.length] ?? '').then(() => {
            order.push(index);
          }),
        ),
      );
      assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await pooled.dispose();
    }
  });

  it('loads a grammar lazily into each worker that receives a run, not into all workers at once', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 3 });
    try {
      const grammar = await pooled.load(scenarios.input);
      for (let round = 0; round < 3; round += 1) {
        await grammar.run(scenarios.sources.basic);
      }
      assert.equal(pooled.poolStatus().workers, 1, 'sequential runs reuse the worker that already has the grammar');
      await Promise.all(Array.from({ length: 6 }, () => grammar.run(scenarios.sources.basic)));
      assert.equal(pooled.poolStatus().workers, 3);
    } finally {
      await pooled.dispose();
    }
  });

  for (const [cpus, workers] of [
    [3, 2],
    [1, 1],
    [16, 4],
    [2, 1],
  ] as const) {
    it(`default size is ${String(workers)} workers for ${String(cpus)} available CPUs`, async () => {
      const scenarios = await loadToyScenarios();
      const pooled = createPooledGrammarEngine({ availableParallelism: () => cpus });
      try {
        const grammar = await pooled.load(scenarios.input);
        const pending = Array.from({ length: 10 }, () => grammar.run(scenarios.sources.basic));
        assert.equal(pooled.poolStatus().workers, workers);
        await Promise.all(pending);
      } finally {
        await pooled.dispose();
      }
    });
  }

  it('lets an explicit size win over the default size rule', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 2, availableParallelism: () => 16 });
    try {
      const grammar = await pooled.load(scenarios.input);
      const pending = Array.from({ length: 6 }, () => grammar.run(scenarios.sources.basic));
      assert.equal(pooled.poolStatus().workers, 2);
      await Promise.all(pending);
    } finally {
      await pooled.dispose();
    }
  });

  it('rejects an invalid size, recycle interval or run deadline with a RangeError', () => {
    for (const options of [
      { size: 0 },
      { size: 1.5 },
      { recycleAfterRuns: 0 },
      { recycleAfterRuns: 2.5 },
      { runTimeoutMs: 0 },
      { runTimeoutMs: Number.NaN },
      { runTimeoutMs: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(() => createPooledGrammarEngine(options), RangeError, JSON.stringify(options));
    }
  });
});

describe('pool recycling', () => {
  it('recycles a worker after recycleAfterRuns runs and reloads the grammar in the replacement', async () => {
    const scenarios = await loadToyScenarios();
    const pooled = createPooledGrammarEngine({ size: 1, recycleAfterRuns: 5 });
    try {
      const grammar = await pooled.load(scenarios.input);
      for (let run = 0; run < 12; run += 1) {
        const result = await grammar.run(scenarios.sources.basic);
        assert.deepStrictEqual(result, scenarios.expected.get(scenarios.sources.basic), `run ${String(run)}`);
      }
      assert.ok(pooled.poolStatus().recycled >= 2, `recycled ${String(pooled.poolStatus().recycled)}`);
      assert.equal(pooled.poolStatus().crashed, 0);
    } finally {
      await pooled.dispose();
    }
  });
});

describe('pool supervision', () => {
  async function withFixturePool(
    options: Parameters<typeof createPooledGrammarEngine>[0],
    fn: (
      pool: ReturnType<typeof createPooledGrammarEngine>,
      grammar: Awaited<ReturnType<ReturnType<typeof createPooledGrammarEngine>['load']>>,
    ) => Promise<void>,
  ): Promise<void> {
    const scenarios = await loadToyScenarios();
    const input: GrammarInput = scenarios.input;
    const pool = createPooledGrammarEngine({ ...options, workerUrl: SPIN_WORKER });
    try {
      await fn(pool, await pool.load(input));
    } finally {
      await pool.dispose();
    }
  }

  it('rejects a run that passes runTimeoutMs with parse_timeout, ends the stuck worker and serves the next run on a fresh one', async () => {
    await withFixturePool({ size: 1, runTimeoutMs: 50 }, async (pool, grammar) => {
      await assert.rejects(grammar.run('spin'), isRunError('parse_timeout'));
      const after = pool.poolStatus();
      assert.equal(after.timedOut, 1);
      assert.equal(after.crashed, 0);
      assert.equal(after.workers, 0, 'the stuck worker was terminated');
      const result = await grammar.run('fine');
      assert.equal(result.totalBytes, 4);
      assert.equal(pool.poolStatus().workers, 1);
      assert.equal(pool.poolStatus().timedOut, 1);
    });
  });

  it('does not time out a run that answered in time', async () => {
    await withFixturePool({ size: 1, runTimeoutMs: 50 }, async (pool, grammar) => {
      await grammar.run('fine');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });
      assert.equal(pool.poolStatus().timedOut, 0);
      assert.equal(pool.poolStatus().workers, 1, 'the deadline timer was cleared when the reply arrived');
    });
  });

  it('rejects the in-flight run with parse_failed when its worker exits, counts one crash and keeps serving', async () => {
    await withFixturePool({ size: 1 }, async (pool, grammar) => {
      await assert.rejects(grammar.run('crash'), isRunError('parse_failed'));
      assert.equal(pool.poolStatus().crashed, 1);
      assert.equal(pool.poolStatus().timedOut, 0);
      assert.equal((await grammar.run('fine')).totalBytes, 4);
    });
  });

  it('counts a worker that dies from an uncaught error once, not once per event', async () => {
    await withFixturePool({ size: 1 }, async (pool, grammar) => {
      await assert.rejects(grammar.run('throw'), isRunError('parse_failed'));
      assert.equal(pool.poolStatus().crashed, 1);
      assert.equal((await grammar.run('fine')).totalBytes, 4);
      assert.equal(pool.poolStatus().crashed, 1);
    });
  });

  it('keeps queued runs alive when the run ahead of them crashes its worker', async () => {
    await withFixturePool({ size: 1 }, async (pool, grammar) => {
      const crashing = grammar.run('crash');
      const behind = [grammar.run('one'), grammar.run('three')];
      await assert.rejects(crashing, isRunError('parse_failed'));
      const results = await Promise.all(behind);
      assert.deepEqual(
        results.map((result) => result.totalBytes),
        [3, 5],
      );
      assert.equal(pool.poolStatus().crashed, 1);
    });
  });

  it('dispose with queued runs rejects every pending run with parse_failed "pool disposed" and leaves no worker', async () => {
    await withFixturePool({ size: 1 }, async (pool, grammar) => {
      const stuck = grammar.run('spin');
      const queued = [grammar.run('fine'), grammar.run('fine'), grammar.run('fine')];
      const settled = Promise.allSettled([stuck, ...queued]);
      assert.equal(pool.poolStatus().queued, 3);
      await pool.dispose();
      for (const outcome of await settled) {
        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.ok(isRunError('parse_failed', /pool disposed/)(outcome.reason), String(outcome.reason));
        }
      }
      assert.equal(pool.poolStatus().workers, 0);
      assert.equal(pool.poolStatus().queued, 0);
      await assert.rejects(grammar.run('fine'), isRunError('parse_failed'));
    });
  });
});
