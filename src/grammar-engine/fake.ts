import { assertInputSizes, hashMismatchMessage, sha256Hex, utf8Length } from './check.ts';
import { GrammarLoadError, GrammarRunError } from './errors.ts';
import { GRAMMAR_LIMITS, captureTextLimit } from './limits.ts';
import type { Capture, GrammarEngine, GrammarInput, GrammarRunResult, LoadedGrammar, QueryKind } from './types.ts';

/** A scripted capture: `match` may be left out, and the fake then assigns one. */
export type ScriptedCapture = Omit<Capture, 'match'> & { readonly match?: number };

/** A scripted run result; any `GrammarRunResult` (every capture with a match) is also a valid one. */
export type ScriptedRunResult = Omit<GrammarRunResult, 'captures'> & { readonly captures: readonly ScriptedCapture[] };

/** What a fake engine answers: results keyed by the EXACT source text passed to `run`. */
export interface FakeGrammarScript {
  readonly abi: number;
  readonly results: ReadonlyMap<string, ScriptedRunResult>;
}

/**
 * Give every scripted capture a match index. A scripted index is kept. A capture without one gets a
 * fresh index of its own query kind, above every index scripted for that kind, so unscripted
 * captures are never grouped with anything (a distinct match per capture).
 */
function withMatches(scripted: ScriptedRunResult): GrammarRunResult {
  const next = new Map<QueryKind, number>();
  for (const capture of scripted.captures) {
    if (capture.match !== undefined) {
      next.set(capture.query, Math.max(next.get(capture.query) ?? 0, capture.match + 1));
    }
  }
  const captures = scripted.captures.map((capture): Capture => {
    const bounded = boundedComment(capture);
    if (capture.match !== undefined) {
      return { ...bounded, match: capture.match };
    }
    const match = next.get(capture.query) ?? 0;
    next.set(capture.query, match + 1);
    return { ...bounded, match };
  });
  return { ...scripted, captures };
}

/**
 * The real engine keeps the text of a capture named `comment` only up to `GRAMMAR_LIMITS.commentTextChars` units
 * and hands over an empty string beyond it; the fake does the same for a scripted comment so a test of the
 * extractor sees what production sees. Any other capture is left as scripted.
 */
function boundedComment(capture: ScriptedCapture): ScriptedCapture {
  return capture.name === 'comment' && capture.text.length > captureTextLimit(capture.name) ? { ...capture, text: '' } : capture;
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
          return Promise.resolve(withMatches(scripted));
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
