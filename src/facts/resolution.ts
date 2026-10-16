import type { Span } from './span.ts';

/**
 * Resolution contracts shared by the Fact Store and the PreciseResolver seam (PRD 4.5), so they
 * live in the kernel. Types only, plus `symbolKey`.
 */

/**
 * Stable symbol identity (fact-model ADR decision 6): repo, path, qualified name, kind and an
 * overload discriminator. The content hash is the symbol's version and is NOT part of identity.
 */
export interface SymbolIdentity {
  readonly repo: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly discriminator?: string;
}

/** The set of file contents a resolution ran against: an id plus path to content hash. */
export interface OverlaySnapshot {
  readonly id: string;
  readonly pathToHash: ReadonlyMap<string, string>;
}

/** Identifies the configuration a resolution derived from (tsconfig chain, lockfile, ...). */
export interface ResolutionContext {
  readonly id: string;
  readonly configHashes: readonly string[];
}

/** Locates one reference site. */
export interface RefSiteKey {
  readonly path: string;
  readonly span: Span;
  readonly name: string;
}

/** A reference site bound to its target definition by a compiler or index (always EXTRACTED). */
export interface ResolvedEdge {
  readonly site: RefSiteKey;
  readonly target: SymbolIdentity;
  readonly confidence: 'EXTRACTED';
  readonly resolver: string;
}

/** Read-only view of symbols the store hands a resolver; resolvers never read the store itself. */
export interface SymbolLookup {
  find(name: string): Promise<readonly SymbolIdentity[]>;
}

const SEPARATOR = '\u0000';

/**
 * A string usable as a map key. Equal identities give equal keys. The separator is NUL, which can
 * not occur in a file path, so fields can not run into each other. Never depends on a content hash.
 */
export function symbolKey(identity: SymbolIdentity): string {
  return [
    identity.repo,
    identity.path,
    identity.qualifiedName,
    identity.kind,
    identity.discriminator ?? '',
  ].join(SEPARATOR);
}
