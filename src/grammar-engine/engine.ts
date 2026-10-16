import { Parser } from 'web-tree-sitter';

import { utf8Length } from './check.ts';
import { GrammarRunError } from './errors.ts';
import { GRAMMAR_LIMITS } from './limits.ts';
import { compileGrammar, createInitializer, releaseQueries } from './load.ts';
import type { CompiledGrammar } from './load.ts';
import { measureErrors } from './measure.ts';
import { stripBom } from './normalize.ts';
import { collectCaptures } from './query.ts';
import type { QueryLimits } from './query.ts';
import type { GrammarEngine, GrammarEngineOptions, GrammarInput, GrammarRunResult, LoadedGrammar } from './types.ts';
import { withTree } from './with-tree.ts';
import type { ParseLimits } from './with-tree.ts';

function checkOptions(options: GrammarEngineOptions): void {
  const { matchLimit, parseTimeoutMs } = options;
  if (
    matchLimit !== undefined &&
    (!Number.isInteger(matchLimit) || matchLimit < 1 || matchLimit > GRAMMAR_LIMITS.matchLimitMax)
  ) {
    throw new RangeError(
      `matchLimit must be an integer from 1 to ${String(GRAMMAR_LIMITS.matchLimitMax)}, got ${String(matchLimit)}`,
    );
  }
  if (parseTimeoutMs !== undefined && (!Number.isFinite(parseTimeoutMs) || parseTimeoutMs <= 0)) {
    throw new RangeError(`parseTimeoutMs must be a finite number above 0, got ${String(parseTimeoutMs)}`);
  }
}

function openGrammar(
  compiled: CompiledGrammar,
  options: GrammarEngineOptions,
  onDispose: (grammar: LoadedGrammar) => void,
): LoadedGrammar {
  const queryLimits: QueryLimits = options.matchLimit === undefined ? {} : { matchLimit: options.matchLimit };
  const parseLimits: ParseLimits = options.parseTimeoutMs === undefined ? {} : { timeoutMs: options.parseTimeoutMs };
  // One reusable Parser per loaded grammar; its language is set once.
  let parser: Parser | undefined;
  try {
    parser = new Parser();
    parser.setLanguage(compiled.language);
  } catch (error) {
    parser?.delete();
    releaseQueries(compiled.queries);
    throw error;
  }
  const live = parser;
  let disposed = false;

  const grammar: LoadedGrammar = {
    name: compiled.name,
    abi: compiled.abi,
    run(source: string): Promise<GrammarRunResult> {
      // Synchronous body inside an async-shaped API: the worker pool of a later phase can sit behind the same seam.
      try {
        if (disposed) {
          throw new GrammarRunError('parse_failed', `${compiled.name}: grammar is disposed`);
        }
        if (utf8Length(source) > GRAMMAR_LIMITS.sourceBytes) {
          throw new GrammarRunError(
            'source_too_large',
            `${compiled.name}: source is over the ${String(GRAMMAR_LIMITS.sourceBytes)} byte cap`,
          );
        }
        const { text, hadBom } = stripBom(source);
        // A failed run leaves nothing behind: withTree deletes the tree in `finally`, a cancelled parse
        // resets the parser, and queries and the parser belong to the loaded grammar, not to the run.
        const result = withTree(
          live,
          text,
          (tree): GrammarRunResult => ({
            hadBom,
            captures: collectCaptures(compiled.queries, tree.rootNode, text, queryLimits),
            ...measureErrors(tree.rootNode, text),
          }),
          parseLimits,
        );
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        live.delete();
        releaseQueries(compiled.queries);
        onDispose(grammar);
      }
      return Promise.resolve();
    },
  };
  return grammar;
}

/**
 * The real Grammar Engine: web-tree-sitter 0.27.1 over hash-verified grammar WASM. `options` sets the
 * optional run limits (match limit, parse deadline); an invalid value throws a RangeError here.
 */
export function createGrammarEngine(options: GrammarEngineOptions = {}): GrammarEngine {
  checkOptions(options);
  const init = createInitializer();
  const open = new Set<LoadedGrammar>();
  return {
    async load(input: GrammarInput): Promise<LoadedGrammar> {
      const compiled = await compileGrammar(init, input);
      const grammar = openGrammar(compiled, options, (g) => open.delete(g));
      open.add(grammar);
      return grammar;
    },
    async dispose(): Promise<void> {
      for (const grammar of [...open]) {
        await grammar.dispose();
      }
    },
  };
}
