import type { NoticingResolverPort, RelationsPort, ResolvedEdge, ResolvedRelation, ResolverPort } from '../facts/index.ts';
import type { PreciseResolver } from './index.ts';

/** What a port with no scope yields: nothing. There is no overlay, so there is nothing to resolve against. */
async function* nothing(): AsyncGenerator<ResolvedEdge, void, undefined> {
  // no overlay, no edges
}

async function* noRelations(): AsyncGenerator<ResolvedRelation, void, undefined> {
  // no overlay, no relations
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
 *
 * When the resolver defines the optional `relations` method (plan 03-25), the returned port carries a `relations`
 * property that does the same for it; a resolver without the method gives a port without the property.
 */
export function asStoreResolver(precise: PreciseResolver): ResolverPort & NoticingResolverPort {
  const port: ResolverPort = (sites, context, symbols, scope) =>
    scope === undefined ? nothing() : precise.resolve(scope.overlay, context, sites, symbols);
  const relate = precise.relations?.bind(precise);
  if (relate === undefined) return port;
  const relations: RelationsPort = (files, context, symbols, scope) =>
    scope === undefined ? noRelations() : relate(scope.overlay, context, files, symbols);
  return Object.assign(port, { relations });
}
