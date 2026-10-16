import { Parser } from 'web-tree-sitter';

import { utf8Length } from './check.ts';
import { GrammarRunError } from './errors.ts';
import { GRAMMAR_LIMITS } from './limits.ts';
import { compileGrammar, createInitializer, releaseQueries } from './load.ts';
import type { CompiledGrammar } from './load.ts';
import { measureErrors } from './measure.ts';
import { stripBom } from './normalize.ts';
import { collectCaptures } from './query.ts';
import type { GrammarEngine, GrammarInput, GrammarRunResult, LoadedGrammar } from './types.ts';
import { withTree } from './with-tree.ts';

function openGrammar(compiled: CompiledGrammar, onDispose: (grammar: LoadedGrammar) => void): LoadedGrammar {
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
        const result = withTree(live, text, (tree): GrammarRunResult => ({
          hadBom,
          captures: collectCaptures(compiled.queries, tree.rootNode, text),
          ...measureErrors(tree.rootNode, text),
        }));
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

/** The real Grammar Engine: web-tree-sitter 0.27.1 over hash-verified grammar WASM. */
export function createGrammarEngine(): GrammarEngine {
  const init = createInitializer();
  const open = new Set<LoadedGrammar>();
  return {
    async load(input: GrammarInput): Promise<LoadedGrammar> {
      const compiled = await compileGrammar(init, input);
      const grammar = openGrammar(compiled, (g) => open.delete(g));
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
