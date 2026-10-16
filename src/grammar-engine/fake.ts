import { assertInputSizes, hashMismatchMessage, sha256Hex, utf8Length } from './check.ts';
import { GrammarLoadError, GrammarRunError } from './errors.ts';
import { GRAMMAR_LIMITS } from './limits.ts';
import type { GrammarEngine, GrammarInput, GrammarRunResult, LoadedGrammar } from './types.ts';

/** What a fake engine answers: results keyed by the EXACT source text passed to `run`. */
export interface FakeGrammarScript {
  readonly abi: number;
  readonly results: ReadonlyMap<string, GrammarRunResult>;
}

/**
 * A production-safe double for the Grammar Engine seam (no node:test, no test-kit). It checks the
 * wasm hash and the size caps exactly as the real engine does, so the shared contract is meaningful,
 * but it never instantiates a WASM and answers `run` from the script. An unscripted source rejects
 * with `parse_failed`.
 */
export function createFakeGrammarEngine(script: FakeGrammarScript): GrammarEngine {
  const open = new Set<LoadedGrammar>();
  return {
    load(input: GrammarInput): Promise<LoadedGrammar> {
      try {
        assertInputSizes(input);
        const actual = sha256Hex(input.wasm);
        if (actual !== input.expectedSha256.toLowerCase()) {
          throw new GrammarLoadError('wasm_hash_mismatch', hashMismatchMessage(input, actual));
        }
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      let disposed = false;
      const grammar: LoadedGrammar = {
        name: input.name,
        abi: script.abi,
        run(source: string): Promise<GrammarRunResult> {
          if (disposed) {
            return Promise.reject(new GrammarRunError('parse_failed', `${input.name}: grammar is disposed`));
          }
          if (utf8Length(source) > GRAMMAR_LIMITS.sourceBytes) {
            return Promise.reject(
              new GrammarRunError(
                'source_too_large',
                `${input.name}: source is over the ${String(GRAMMAR_LIMITS.sourceBytes)} byte cap`,
              ),
            );
          }
          const scripted = script.results.get(source);
          if (scripted === undefined) {
            return Promise.reject(new GrammarRunError('parse_failed', `${input.name}: no scripted result for this source`));
          }
          return Promise.resolve(scripted);
        },
        dispose(): Promise<void> {
          disposed = true;
          open.delete(grammar);
          return Promise.resolve();
        },
      };
      open.add(grammar);
      return Promise.resolve(grammar);
    },
    async dispose(): Promise<void> {
      for (const grammar of [...open]) {
        await grammar.dispose();
      }
    },
  };
}
