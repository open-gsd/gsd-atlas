import { Language, Parser, Query } from 'web-tree-sitter';

import { assertInputSizes, hashMismatchMessage, sha256Hex } from './check.ts';
import { GrammarLoadError } from './errors.ts';
import { QUERY_KINDS } from './types.ts';
import type { GrammarInput, QueryKind } from './types.ts';

/** A verified, instantiated grammar with its compiled queries. The caller must `release` it. */
export interface CompiledGrammar {
  readonly language: Language;
  readonly queries: Readonly<Partial<Record<QueryKind, Query>>>;
  readonly name: string;
  readonly abi: number;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a function that initialises web-tree-sitter once per engine instance (memoised in the
 * closure, never at module level, so two engines never share hidden state). A failure maps to
 * `engine_init_failed` and is not cached, so a later load may retry.
 */
export function createInitializer(): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= Parser.init().catch((error: unknown) => {
      pending = undefined;
      throw new GrammarLoadError('engine_init_failed', `web-tree-sitter could not initialise: ${reason(error)}`);
    });
    return pending;
  };
}

/** Delete every compiled query. Safe on a partial set. */
export function releaseQueries(queries: Readonly<Partial<Record<QueryKind, Query>>>): void {
  for (const kind of QUERY_KINDS) {
    queries[kind]?.delete();
  }
}

/**
 * Verify and load a grammar. Order matters (T-01-29): size caps, then the sha256 against the
 * grammar.lock value, and only then `Language.load` on the verified bytes. Loading from bytes
 * (not a path) avoids Windows path quirks and lets the hash gate the load.
 */
export async function compileGrammar(init: () => Promise<void>, input: GrammarInput): Promise<CompiledGrammar> {
  assertInputSizes(input);
  const actual = sha256Hex(input.wasm);
  if (actual !== input.expectedSha256.toLowerCase()) {
    throw new GrammarLoadError('wasm_hash_mismatch', hashMismatchMessage(input, actual));
  }
  await init();
  let language: Language;
  try {
    language = await Language.load(input.wasm);
  } catch (error) {
    throw new GrammarLoadError('wasm_invalid', `${input.name}: grammar wasm could not be loaded: ${reason(error)}`);
  }
  const compiled: Partial<Record<QueryKind, Query>> = {};
  try {
    for (const kind of QUERY_KINDS) {
      const text = input.queries[kind];
      if (text !== undefined) {
        compiled[kind] = new Query(language, text);
      }
    }
  } catch (error) {
    releaseQueries(compiled);
    const failing = QUERY_KINDS.find((kind) => input.queries[kind] !== undefined && compiled[kind] === undefined);
    throw new GrammarLoadError('query_error', `${input.name}: ${failing ?? 'a'} query does not compile: ${reason(error)}`);
  }
  return { language, queries: compiled, name: language.name ?? input.name, abi: language.abiVersion };
}
