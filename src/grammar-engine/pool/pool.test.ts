import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineGrammarEngineContract, loadToyScenarios } from '../contract.ts';
import { GrammarRunError, GRAMMAR_LIMITS } from '../index.ts';
import { createPooledGrammarEngine } from './pool.ts';
import { resolveWorkerUrl } from './worker-url.ts';

// The pooled engine passes the same contract as the in-process engine (LNG-07, LNG-08 through the pool).
defineGrammarEngineContract('pooled', () => createPooledGrammarEngine({ size: 1 }));

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
      await assert.rejects(grammar.run('#'.repeat(GRAMMAR_LIMITS.sourceBytes + 1)), (error: unknown) => {
        return error instanceof GrammarRunError && error.code === 'source_too_large';
      });
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
