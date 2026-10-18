import type { ResolutionContext } from '../facts/index.ts';
import type { CompilerChoice } from './types.ts';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The resolution context of a description (G4, research Pitfall 7): a pure function of what the model read.
 *
 * `id` names the model and the compiler identity, `typescript:<version>:<project|bundled>`, so edges computed by
 * 6.0.2 never serve a 6.0.3 question. `configHashes` holds the sorted sha256 of every config file in every chain
 * (BOM stripped, CRLF read as LF), so a changed tsconfig, a changed `extends` target or a compiler upgrade changes
 * the context and the cached edges are recomputed. Each chain is a map from config path to its hash; a file that
 * several chains share counts once, and the order the chains or the overlay were given in changes nothing.
 */
export function buildContext(compiler: CompilerChoice, chains: readonly ReadonlyMap<string, string>[]): ResolutionContext {
  const byPath = new Map<string, string>();
  for (const chain of chains) for (const [file, hash] of chain) byPath.set(file, hash);
  return {
    id: `typescript:${compiler.version}:${compiler.source}`,
    configHashes: [...byPath.values()].sort(compareCodeUnits),
  };
}
