import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readModuleInputs } from '../../lang/index.ts';
import { defineGrammarEngineContract, loadToyScenarios, runInProcess } from '../contract.ts';
import { extractFileFacts, GrammarLoadError, GrammarRunError, GRAMMAR_LIMITS } from '../index.ts';
import type { GrammarInput, GrammarRunResult } from '../index.ts';
import { createPooledGrammarEngine, POOL_DEFAULTS } from './pool.ts';
import { resolveWorkerUrl } from './worker-url.ts';

// The pooled engine passes the same contract as the in-process engine (LNG-07, LNG-08 through the pool).
defineGrammarEngineContract('pooled', () => createPooledGrammarEngine({ size: 1 }));

/** The supervision fixture: a worker that speaks the protocol and spins, crashes or throws on request. */
const SPIN_WORKER = new URL('./__fixtures__/spin-worker.ts', import.meta.url);

/** A worker that accepts every request and answers none: a grammar load that never finishes. */
const SILENT_WORKER = new URL('./__fixtures__/silent-worker.ts', import.meta.url);

/** A worker that reports its start data as the name of the grammar it "loads". */
const ECHO_START_WORKER = new URL('./__fixtures__/echo-start-worker.ts', import.meta.url);

function isLoadError(code: string, messagePattern?: RegExp) {
  return (error: unknown): boolean =>
    error instanceof GrammarLoadError &&
    error.code === code &&
    (messagePattern === undefined || messagePattern.test(error.message));
}

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
      let results: GrammarRunResult[];
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

describe('pool load deadline (WR-09)', () => {
  /** Records the timers armed with `delay` and the timers cleared, so a test can see that none is left behind. */
  function watchTimers(delay: number): { restore(): void; armed: unknown[]; cleared: Set<unknown> } {
    const armed: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const timer = realSet(handler, ms, ...rest);
      if (ms === delay) {
        armed.push(timer);
      }
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(timer);
      realClear(timer);
    }) as typeof clearTimeout;
    return {
      armed,
      cleared,
      restore: () => {
        globalThis.setTimeout = realSet;
        globalThis.clearTimeout = realClear;
      },
    };
  }

  async function toyInput(): Promise<GrammarInput> {
    return (await loadToyScenarios()).input;
  }

  it('silent load: rejects with engine_init_failed saying the load timed out, ends the worker and frees the slot', { timeout: 10000 }, async () => {
    const input = await toyInput();
    const pool = createPooledGrammarEngine({ size: 1, loadTimeoutMs: 100, workerUrl: SILENT_WORKER });
    try {
      await assert.rejects(pool.load(input), isLoadError('engine_init_failed', /timed out/));
      const after = pool.poolStatus();
      assert.equal(after.busy, 0);
      assert.equal(after.workers, 0, 'the worker that never answered was terminated');
      assert.equal(after.queued, 0);
    } finally {
      await pool.dispose();
    }
  });

  it('queue continues: two loads started together on a one-slot pool both settle', { timeout: 10000 }, async () => {
    const input = await toyInput();
    const pool = createPooledGrammarEngine({ size: 1, loadTimeoutMs: 100, workerUrl: SILENT_WORKER });
    try {
      const outcomes = await Promise.allSettled([pool.load(input), pool.load(input)]);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.ok(isLoadError('engine_init_failed', /timed out/)(outcome.reason), String(outcome.reason));
        }
      }
      assert.equal(pool.poolStatus().busy, 0);
      assert.equal(pool.poolStatus().queued, 0);
    } finally {
      await pool.dispose();
    }
  });

  it('lazy load before a run: a run whose grammar load times out fails with parse_failed naming the load failure', { timeout: 10000 }, async () => {
    // The caller's own load goes to the first worker, which answers; a second worker (spawned for a run that
    // lands while the first is busy) never answers the lazy load that precedes the run.
    const input = await toyInput();
    const pool = createPooledGrammarEngine({
      size: 2,
      loadTimeoutMs: 100,
      workerUrl: (spawnCount) => (spawnCount === 1 ? SPIN_WORKER : SILENT_WORKER),
    });
    try {
      const grammar = await pool.load(input);
      // Occupy the first slot so the next run must go to the second, silent one.
      const stuck = grammar.run('spin');
      stuck.catch(() => undefined);
      await assert.rejects(
        grammar.run('fine'),
        isRunError('parse_failed', /could not be loaded into a parser worker.*timed out/s),
      );
      assert.equal(pool.poolStatus().busy <= 1, true);
    } finally {
      await pool.dispose();
    }
  });

  it('healthy load: the real worker loads a toy grammar and no timer is left behind', async () => {
    const input = await toyInput();
    const watch = watchTimers(123457);
    const pool = createPooledGrammarEngine({ size: 1, loadTimeoutMs: 123457 });
    try {
      const grammar = await pool.load(input);
      assert.ok(grammar.abi > 0);
      assert.equal(watch.armed.length, 1, 'one load deadline was armed');
      for (const timer of watch.armed) {
        assert.ok(watch.cleared.has(timer), 'the load deadline was cleared when the reply arrived');
      }
    } finally {
      watch.restore();
      await pool.dispose();
    }
  });

  it('dispose during load: a pending load rejects with the pool-disposed error and its timer is cleared', { timeout: 10000 }, async () => {
    const input = await toyInput();
    const watch = watchTimers(123459);
    const pool = createPooledGrammarEngine({ size: 1, loadTimeoutMs: 123459, workerUrl: SILENT_WORKER });
    try {
      const pending = pool.load(input);
      const outcome = Promise.allSettled([pending]);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(watch.armed.length, 1);
      await pool.dispose();
      const [settled] = await outcome;
      assert.equal(settled?.status, 'rejected');
      if (settled?.status === 'rejected') {
        assert.ok(isLoadError('engine_init_failed', /pool disposed/)(settled.reason), String(settled.reason));
      }
      for (const timer of watch.armed) {
        assert.ok(watch.cleared.has(timer), 'the load deadline was cleared by dispose');
      }
    } finally {
      watch.restore();
      await pool.dispose();
    }
  });

  it('defaults the load deadline to the approved value (02-CONSTANTS.md addendum 2026-10-17)', () => {
    assert.equal(POOL_DEFAULTS.loadTimeoutMs, 30000);
  });

  it('rejects an invalid load deadline with a RangeError', () => {
    for (const loadTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createPooledGrammarEngine({ loadTimeoutMs }), RangeError, String(loadTimeoutMs));
    }
  });
});

describe('pool limits: the engine cut-off fires before the pool deadline (IN-06)', () => {
  /** The `engineOptions` the pool handed to its worker, read back through the echo fixture. */
  async function handedToWorker(options: Parameters<typeof createPooledGrammarEngine>[0]) {
    const scenarios = await loadToyScenarios();
    const pool = createPooledGrammarEngine({ size: 1, ...options, workerUrl: ECHO_START_WORKER });
    try {
      const grammar = await pool.load(scenarios.input);
      const start = JSON.parse(grammar.name) as { engineOptions: { parseTimeoutMs: number } };
      return { limits: pool.poolStatus().limits, parseTimeoutMs: start.engineOptions.parseTimeoutMs };
    } finally {
      await pool.dispose();
    }
  }

  it('default limits: cut-off 5000, pool deadline 7000, load deadline from the approved addendum', async () => {
    const seen = await handedToWorker({});
    assert.deepEqual(seen.limits, { parseTimeoutMs: 5000, runTimeoutMs: 7000, loadTimeoutMs: 30000 });
    assert.equal(seen.parseTimeoutMs, 5000, 'the engine inside the worker cuts off at the cut-off, not at the deadline');
    assert.equal(POOL_DEFAULTS.parseTimeoutMs, 5000);
    assert.equal(POOL_DEFAULTS.terminateGraceMs, 2000);
    assert.equal(POOL_DEFAULTS.runTimeoutMs, POOL_DEFAULTS.parseTimeoutMs + POOL_DEFAULTS.terminateGraceMs);
  });

  it('only runTimeoutMs: the engine cut-off follows it, as before', async () => {
    const seen = await handedToWorker({ runTimeoutMs: 80 });
    assert.equal(seen.limits.runTimeoutMs, 80);
    assert.equal(seen.limits.parseTimeoutMs, 80);
    assert.equal(seen.parseTimeoutMs, 80);
  });

  it('only parseTimeoutMs: the pool deadline is that value plus the terminate grace', async () => {
    const seen = await handedToWorker({ engineOptions: { parseTimeoutMs: 100 } });
    assert.equal(seen.limits.parseTimeoutMs, 100);
    assert.equal(seen.limits.runTimeoutMs, 100 + POOL_DEFAULTS.terminateGraceMs);
    assert.equal(seen.parseTimeoutMs, 100);
  });

  it('both set: both are used as given', async () => {
    const seen = await handedToWorker({ runTimeoutMs: 300, engineOptions: { parseTimeoutMs: 90 } });
    assert.equal(seen.limits.runTimeoutMs, 300);
    assert.equal(seen.limits.parseTimeoutMs, 90);
    assert.equal(seen.parseTimeoutMs, 90);
  });

  it('rejects an invalid cut-off with a RangeError at construction', () => {
    for (const parseTimeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createPooledGrammarEngine({ engineOptions: { parseTimeoutMs } }),
        RangeError,
        String(parseTimeoutMs),
      );
    }
  });

  it('a parse over the cut-off ends in parse_timeout and the worker survives with its grammar', async () => {
    const scenarios = await loadToyScenarios();
    const huge = 'fn a {\n  helper();\n}\n'.repeat(80000);
    // The cut-off is far below the deadline (1 ms against 2001 ms), so the engine always wins the race.
    const pool = createPooledGrammarEngine({ size: 1, engineOptions: { parseTimeoutMs: 1 } });
    try {
      const grammar = await pool.load(scenarios.input);
      await assert.rejects(grammar.run(huge), isRunError('parse_timeout'));
      const after = pool.poolStatus();
      assert.equal(after.timedOut, 0, 'the pool did not have to kill the worker');
      assert.equal(after.crashed, 0);
      assert.equal(after.recycled, 0);
      assert.equal(after.workers, 1, 'the worker with its loaded grammar is still there');
      assert.deepStrictEqual(await grammar.run(scenarios.sources.basic), scenarios.expected.get(scenarios.sources.basic));
      assert.equal(pool.poolStatus().workers, 1);
    } finally {
      await pool.dispose();
    }
  });
});

const MODULES_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'modules');

/** A built-in module, read through the confined module reader, with the text of its `constructs` fixture. */
function readBuiltIn(name: string, fixture: string): { input: GrammarInput; version: string; text: string } {
  const dir = path.join(MODULES_DIR, name);
  const inputs = readModuleInputs(dir);
  if (!inputs.ok) {
    throw new Error(`cannot read module ${name}: ${inputs.diagnostics.map((d) => d.message).join('; ')}`);
  }
  return {
    input: inputs.input,
    version: inputs.manifest.version ?? 'unversioned',
    text: fs.readFileSync(path.join(dir, 'fixtures', fixture), 'utf8'),
  };
}

function factsOf(name: string, version: string, fixture: string, run: GrammarRunResult) {
  return extractFileFacts({ path: fixture, contentHash: '0'.repeat(40), module: name, grammarVersion: version, run });
}

/**
 * About 8 KB of TypeScript, deterministic in `index` (no random source): distinct identifiers, literals
 * and shapes per file, so no two files are the same text.
 */
function syntheticSource(index: number): string {
  const parts: string[] = [`import { shared${String(index % 7)} } from './shared${String(index % 7)}';\n\n`];
  let size = parts[0]?.length ?? 0;
  for (let n = 0; size < 8000; n += 1) {
    const id = `${String(index)}_${String(n)}`;
    const block =
      `export function compute${id}(a: number, b: string): string {\n` +
      `  const local${id} = shared${String(index % 7)}(a) + b.length * ${String(index * 31 + n)};\n` +
      `  return helper${String((index + n) % 11)}(local${id}, '${id}');\n}\n\n` +
      `export class Holder${id} {\n  value${id}: number = ${String(index + n)};\n` +
      `  read${id}(x: number): number {\n    return x + this.value${id} - ${String(n)};\n  }\n}\n\n`;
    parts.push(block);
    size += block.length;
  }
  return parts.join('');
}

describe('pool against the built-in modules and the toy language', () => {
  it('gives the typescript and javascript modules the captures and facts of the in-process engine', async () => {
    const pooled = createPooledGrammarEngine({ size: 2 });
    try {
      for (const [name, fixture] of [
        ['typescript', 'constructs.ts'],
        ['javascript', 'constructs.cjs'],
      ] as const) {
        const module = readBuiltIn(name, fixture);
        const grammar = await pooled.load(module.input);
        const pooledRun = await grammar.run(module.text);
        const [localRun] = await runInProcess(module.input, [module.text]);
        assert.ok(localRun, `${name}: the in-process run produced no result`);
        assert.deepStrictEqual(pooledRun, localRun, `${name}: captures`);
        const pooledFacts = factsOf(name, module.version, fixture, pooledRun);
        const localFacts = factsOf(name, module.version, fixture, localRun);
        assert.deepStrictEqual(pooledFacts, localFacts, `${name}: facts`);
        assert.ok(pooledFacts.facts.symbols.length > 0, `${name}: the fixture defines symbols`);
        assert.equal(pooledFacts.facts.parse.errorBytes, 0, `${name}: the fixture parses cleanly`);
      }
    } finally {
      await pooled.dispose();
    }
  });

  it('keeps toy runs and typescript runs apart when they interleave on one pool', async () => {
    const scenarios = await loadToyScenarios();
    const ts = readBuiltIn('typescript', 'constructs.ts');
    const [tsExpected] = await runInProcess(ts.input, [ts.text]);
    const toyExpected = scenarios.expected.get(scenarios.sources.basic);
    assert.ok(tsExpected && toyExpected);
    assert.notDeepEqual(tsExpected.captures, toyExpected.captures);
    const pooled = createPooledGrammarEngine({ size: 2 });
    try {
      const toy = await pooled.load(scenarios.input);
      const typescript = await pooled.load(ts.input);
      const jobs: Array<Promise<void>> = [];
      for (let index = 0; index < 200; index += 1) {
        jobs.push(
          toy.run(scenarios.sources.basic).then((result) => {
            assert.deepStrictEqual(result, toyExpected, `toy run ${String(index)}`);
          }),
          typescript.run(ts.text).then((result) => {
            assert.deepStrictEqual(result, tsExpected, `typescript run ${String(index)}`);
          }),
        );
      }
      await Promise.all(jobs);
    } finally {
      await pooled.dispose();
    }
  });
});

describe('pool memory plateau (LNG-07)', () => {
  const FILES = 1200;
  const SAMPLE_EVERY = 400;
  const MIB = 1024 * 1024;

  it('keeps the resident set size flat over 1,200 synthetic typescript files on two recycling workers', async () => {
    const ts = readBuiltIn('typescript', 'constructs.ts');
    const pooled = createPooledGrammarEngine({ size: 2, recycleAfterRuns: SAMPLE_EVERY });
    const samples: number[] = [process.memoryUsage().rss];
    try {
      const grammar = await pooled.load(ts.input);
      for (let first = 0; first < FILES; first += SAMPLE_EVERY) {
        const round = Array.from({ length: SAMPLE_EVERY }, (_, offset) => grammar.run(syntheticSource(first + offset)));
        const results = await Promise.all(round);
        assert.equal(results.length, SAMPLE_EVERY);
        assert.ok(
          results.every((result) => result.totalBytes >= 8000 && result.captures.length > 0),
          'every synthetic file parses and yields captures',
        );
        samples.push(process.memoryUsage().rss);
      }
      assert.ok(pooled.poolStatus().recycled >= 2, `workers were recycled during the run (${String(pooled.poolStatus().recycled)})`);
    } finally {
      await pooled.dispose();
    }
    const inMib = samples.map((bytes) => Math.round(bytes / MIB));
    process.stdout.write(`# rss samples in MiB (baseline, then after every ${String(SAMPLE_EVERY)} runs): ${inMib.join(', ')}\n`);
    // samples[0] is the baseline before warm-up; the bound compares the last sample with the two after it.
    const warm = Math.max(samples[1] ?? 0, samples[2] ?? 0);
    const last = samples[samples.length - 1] ?? 0;
    const allowed = warm * 1.25 + 64 * MIB;
    assert.ok(last <= allowed, `rss kept growing: samples ${inMib.join(', ')} MiB; last ${String(Math.round(last / MIB))} > allowed ${String(Math.round(allowed / MIB))}`);
  });
});
