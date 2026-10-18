import type { ResolverPort } from '../facts/index.ts';
import type { PreciseResolver } from './index.ts';

/**
 * Turns a PreciseResolver into the Fact Store's resolver port. (RED scaffold: yields nothing yet.)
 */
export function asStoreResolver(precise: PreciseResolver): ResolverPort {
  void precise;
  return async function* () {
    // scaffold
  };
}
