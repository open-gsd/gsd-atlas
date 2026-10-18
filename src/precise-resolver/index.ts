import type { OverlaySnapshot, RefSiteKey, ResolutionContext, ResolvedEdge, SymbolLookup } from '../facts/index.ts';

export { asStoreResolver } from './store-adapter.ts';
export { createScriptedResolver } from './stub.ts';
export type { ScriptedEdge, ScriptedResolverOptions } from './stub.ts';

/**
 * The PreciseResolver seam (PRD 4.5, FND-05). A compiler- or index-backed resolver that binds
 * reference sites to definitions. Production-safe: only the interface and the scripted stub are
 * exported. The shared contract suite lives in contract.ts and is test code, so it is
 * deliberately not re-exported here. Real adapters (TypeScript 6 and 7 compilers, SCIP import,
 * IndexStoreDB) arrive in later phases; each must pass that contract unchanged.
 *
 * Rules every implementation follows:
 * - Edges are `EXTRACTED`: they come from a compiler or an index, never from name matching, and
 *   each carries the resolver's `id`.
 * - A precise edge supersedes a grammar `INFERRED` edge at the same reference site. The resolver
 *   does not apply that rule; the Fact Store does, in Phase 2.
 * - Only edges for the requested sites are yielded, in a deterministic order, and an empty
 *   request yields nothing.
 * - Abandoning the iteration early (a `break` or a throw in the consumer) runs the resolver's
 *   cleanup, exactly once, as does finishing it.
 *
 * Per the language-modules ADR (decision 3), a PreciseResolver is the only code a language module
 * may add.
 */
export interface PreciseResolver {
  /** Stable, non-empty name of the adapter; stamped on every edge it yields as `resolver`. */
  readonly id: string;
  /**
   * Resolve `sites` against the file contents in `overlay`, under the configuration in `context`.
   * Resolvers never read the Fact Store; everything they need is passed in.
   *
   * `symbols` is the store's read-only lookup of the grammar tier's symbols. An adapter uses it to map a
   * compiler declaration to the grammar symbol whose span contains the declaration's name token, so the edge
   * names the symbol identity the store holds. It is optional: a resolver that does not need it ignores it,
   * and one called without it still resolves (it just cannot map identities itself).
   */
  resolve(
    overlay: OverlaySnapshot,
    context: ResolutionContext,
    sites: readonly RefSiteKey[],
    symbols?: SymbolLookup,
  ): AsyncIterable<ResolvedEdge>;
}
