import type { ResolvedEdge, ResolverPort } from '../facts/index.ts';
import type { PreciseResolver } from './index.ts';

/** What a port with no scope yields: nothing. There is no overlay, so there is nothing to resolve against. */
async function* nothing(): AsyncGenerator<ResolvedEdge, void, undefined> {
  // no overlay, no edges
}

/**
 * Turns a PreciseResolver into the Fact Store's resolver port (`StoreDeps.resolver`). The store passes the
 * sites, the resolution context, a read-only lookup of the grammar tier's symbols and a scope that names the
 * worktree and the overlay snapshot; the adapter hands the overlay, the context, the sites and the lookup to
 * `PreciseResolver.resolve`, so the resolver can map its own declarations to the symbol identities the store
 * holds. A call without a scope (a caller that predates the scope argument) has no overlay to resolve against
 * and yields nothing, without calling the resolver.
 *
 * The iterable the resolver returns is passed through as is, so its cleanup runs exactly once, whether the
 * store finishes the iteration, abandons it on a timeout or the resolver throws.
 */
export function asStoreResolver(precise: PreciseResolver): ResolverPort {
  return (sites, context, symbols, scope) =>
    scope === undefined ? nothing() : precise.resolve(scope.overlay, context, sites, symbols);
}
