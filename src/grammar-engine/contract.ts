// Test code: the shared Grammar Engine contract (D-10). Imported only by grammar-engine.test.ts as
// ./contract.ts and never re-exported from index.ts, so the CLI path never loads node:test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createGrammarEngine } from './engine.ts';
import { GrammarLoadError, GrammarRunError } from './errors.ts';
import { GRAMMAR_LIMITS } from './limits.ts';
import type { GrammarEngine, GrammarInput, GrammarRunResult } from './types.ts';

export const TOY_DIR = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

export interface ContractScenarios {
  /** The toy module's wasm, queries and the hash from its grammar.lock. */
  readonly input: GrammarInput;
  readonly abi: number;
  /** Fixture texts, exactly as read from disk (the bom text still starts with U+FEFF). */
  readonly sources: {
    readonly basic: string;
    readonly emoji: string;
    readonly crlf: string;
    readonly bom: string;
    readonly broken: string;
  };
  /** The real engine's results for every source, keyed by exact source text. Scripts the fake. */
  readonly expected: ReadonlyMap<string, GrammarRunResult>;
}

function readFixture(relative: string): string {
  return fs.readFileSync(path.join(TOY_DIR, relative), 'utf8');
}

let cachedScenarios: Promise<ContractScenarios> | undefined;

/** Read the toy module and run the REAL engine once over every fixture to produce the expectations. */
export function loadToyScenarios(): Promise<ContractScenarios> {
  cachedScenarios ??= buildToyScenarios();
  return cachedScenarios;
}

async function buildToyScenarios(): Promise<ContractScenarios> {
  const lock = JSON.parse(readFixture('grammar.lock')) as { name: string; abi: number; wasm: { sha256: string } };
  const input: GrammarInput = {
    name: lock.name,
    wasm: new Uint8Array(fs.readFileSync(path.join(TOY_DIR, 'grammar.wasm'))),
    expectedSha256: lock.wasm.sha256,
    queries: {
      tags: readFixture('queries/tags.scm'),
      refs: readFixture('queries/refs.scm'),
      imports: readFixture('queries/imports.scm'),
    },
  };
  const sources = {
    basic: readFixture('fixtures/basic.toy'),
    emoji: readFixture('fixtures/emoji.toy'),
    crlf: readFixture('fixtures/crlf.toy'),
    bom: readFixture('fixtures/bom.toy'),
    broken: readFixture('fixtures-negative/broken.toy'),
  };
  const real = createGrammarEngine();
  try {
    const grammar = await real.load(input);
    const expected = new Map<string, GrammarRunResult>();
    for (const source of Object.values(sources)) {
      expected.set(source, await grammar.run(source));
    }
    return { input, abi: grammar.abi, sources, expected };
  } finally {
    await real.dispose();
  }
}

function isLoadError(code: string) {
  return (error: unknown): boolean => error instanceof GrammarLoadError && error.code === code;
}

/**
 * Register the Grammar Engine contract under `label`. `make` returns a fresh engine for the given
 * scenarios; the same cases run against the real engine and against the fake, so the fake cannot
 * drift from the real behaviour.
 */
export function defineGrammarEngineContract(
  label: string,
  make: (scenarios: ContractScenarios) => GrammarEngine,
): void {
  async function withLoaded(
    fn: (grammar: Awaited<ReturnType<GrammarEngine['load']>>, scenarios: ContractScenarios) => Promise<void>,
  ) {
    const scenarios = await loadToyScenarios();
    const engine = make(scenarios);
    try {
      const grammar = await engine.load(scenarios.input);
      await fn(grammar, scenarios);
    } finally {
      await engine.dispose();
    }
  }

  describe(`Grammar Engine contract: ${label}`, () => {
    it('loads when the expected hash matches and reports the abi', async () => {
      await withLoaded(async (grammar, scenarios) => {
        assert.equal(grammar.abi, scenarios.abi);
      });
    });

    it('rejects a wrong hash with wasm_hash_mismatch', async () => {
      const scenarios = await loadToyScenarios();
      const engine = make(scenarios);
      try {
        await assert.rejects(
          engine.load({ ...scenarios.input, expectedSha256: 'f'.repeat(64) }),
          isLoadError('wasm_hash_mismatch'),
        );
      } finally {
        await engine.dispose();
      }
    });

    it('rejects a wasm over the 8 MiB cap with wasm_too_large', async () => {
      const scenarios = await loadToyScenarios();
      const engine = make(scenarios);
      try {
        await assert.rejects(
          engine.load({ ...scenarios.input, wasm: new Uint8Array(GRAMMAR_LIMITS.wasmBytes + 1) }),
          isLoadError('wasm_too_large'),
        );
      } finally {
        await engine.dispose();
      }
    });

    it('rejects a query over the 256 KiB cap with query_too_large', async () => {
      const scenarios = await loadToyScenarios();
      const engine = make(scenarios);
      try {
        await assert.rejects(
          engine.load({
            ...scenarios.input,
            queries: { ...scenarios.input.queries, refs: ' '.repeat(GRAMMAR_LIMITS.queryBytes + 1) },
          }),
          isLoadError('query_too_large'),
        );
      } finally {
        await engine.dispose();
      }
    });

    it('reports hadBom true and the definition name at line 0 columns 3 to 4 for bom.toy', async () => {
      await withLoaded(async (grammar, scenarios) => {
        const result = await grammar.run(scenarios.sources.bom);
        assert.equal(result.hadBom, true);
        const name = result.captures.find((c) => c.query === 'tags' && c.name === 'name');
        assert.ok(name, 'the definition name must be captured');
        assert.deepEqual(name.span, { startLine: 0, startColumn: 3, endLine: 0, endColumn: 4 });
      });
    });

    it('reports hadBom false for a text without a BOM', async () => {
      await withLoaded(async (grammar, scenarios) => {
        assert.equal((await grammar.run(scenarios.sources.basic)).hadBom, false);
      });
    });

    for (const fixture of ['basic', 'emoji', 'crlf', 'bom'] as const) {
      it(`reports errorBytes 0 for the clean ${fixture}.toy fixture`, async () => {
        await withLoaded(async (grammar, scenarios) => {
          const result = await grammar.run(scenarios.sources[fixture]);
          assert.equal(result.errorBytes, 0);
        });
      });
    }

    it('reports errorBytes above 0 and at most totalBytes for broken.toy', async () => {
      await withLoaded(async (grammar, scenarios) => {
        const result = await grammar.run(scenarios.sources.broken);
        assert.ok(result.errorBytes > 0, 'errorBytes must be above 0');
        assert.ok(result.errorBytes <= result.totalBytes, 'errorBytes must not exceed totalBytes');
      });
    });

    it('rejects an oversized source with source_too_large', async () => {
      await withLoaded(async (grammar, scenarios) => {
        await assert.rejects(
          grammar.run('#'.repeat(GRAMMAR_LIMITS.sourceBytes + 1)),
          (error: unknown) => error instanceof GrammarRunError && error.code === 'source_too_large',
        );
      });
    });

    it('is safe to dispose twice, for the grammar and for the engine', async () => {
      const scenarios = await loadToyScenarios();
      const engine = make(scenarios);
      const grammar = await engine.load(scenarios.input);
      await grammar.dispose();
      await grammar.dispose();
      await engine.dispose();
      await engine.dispose();
    });
  });
}
