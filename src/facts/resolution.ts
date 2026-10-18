import type { Span } from './span.ts';

/**
 * Resolution contracts shared by the Fact Store and the PreciseResolver seam (PRD 4.5), so they
 * live in the kernel. Types only, plus `symbolKey` and the default project context.
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

/** A symbol identity together with the span of its definition (the whole declaration, as the grammar tier stored it). */
export type LocatedSymbol = SymbolIdentity & { readonly span: Span };

/** Read-only view of symbols the store hands a resolver; resolvers never read the store itself. */
export interface SymbolLookup {
  find(name: string): Promise<readonly SymbolIdentity[]>;
  /**
   * Every symbol called `name` that the overlay's version of the file at `path` defines, in definition order,
   * with its identity and its span. A compiler adapter matches a declaration to the one symbol whose span
   * contains the declaration's name token, so nothing is guessed. An unknown path, a path outside the overlay,
   * a path whose facts are still pending and an unknown name all give an empty list.
   */
  findIn(path: string, name: string): Promise<readonly LocatedSymbol[]>;
}

/**
 * Where a compiler writes the output of each included source (TSM-03), asked by repository-relative POSIX path. It
 * is a function of the project's configuration and its source files, so it never depends on a content hash and the
 * same lookup serves the specifier rule, the Indexer's output filter and `emittedAs`.
 */
export interface EmitLookup {
  /**
   * The one included source whose emit output is `path`, or undefined: not an output, or an output that more than
   * one source emits to (nothing is guessed) or a path that is itself a source.
   */
  outputToSource(path: string): string | undefined;
  /** The output paths of an included source (code and declaration files), in code-unit order; empty for any other path. */
  sourceToOutputs(path: string): readonly string[];
  /**
   * True when `path` is the emit output of an included source, even an ambiguous one. A path that is a source of any
   * config is never an output, so it is never dropped from the index.
   */
  isOutput(path: string): boolean;
}

/**
 * What a resolver learns about the configuration it resolves under, besides the `ResolutionContext` that keys
 * the cache. Nothing else belongs in it without a plan.
 */
export interface ProjectContext {
  readonly context: ResolutionContext;
  /** Where the project's compiler writes its output; absent for a store with no project model or no config. */
  readonly emit?: EmitLookup;
}

/** The context of a store with no project model: the grammar tier, no configuration hashes. */
export const DEFAULT_PROJECT_CONTEXT: ProjectContext = Object.freeze({
  context: Object.freeze({ id: 'grammar', configHashes: Object.freeze([]) as readonly string[] }),
});

/**
 * Computes the project context of one overlay snapshot, asynchronously (it may read tsconfig files, probe a
 * compiler, ...). The store calls it at most once per (worktree, snapshot id) and keys cached edges by the
 * `context` it returns, so a changed configuration or compiler identity misses the cache.
 */
export type ProjectContextProvider = (scope: {
  readonly worktree: string;
  readonly overlay: OverlaySnapshot;
}) => Promise<ProjectContext>;

/**
 * Where a resolver is resolving: the worktree, the overlay snapshot the sites were read from (its id and its
 * path to content hash map) and the project context computed for that snapshot. Read-only data.
 */
export interface ResolveScope {
  readonly worktree: string;
  readonly overlay: OverlaySnapshot;
  readonly project: ProjectContext;
}

/**
 * The injected resolver port: binds reference sites to target definitions. It reads symbols back through the
 * read-only `SymbolLookup` the store passes in, never through the store itself. Yields `EXTRACTED` edges. The
 * `scope` is the fourth argument so a resolver written for the earlier three-argument shape keeps working.
 */
export type ResolverPort = (
  sites: readonly RefSiteKey[],
  context: ResolutionContext,
  symbols: SymbolLookup,
  scope?: ResolveScope,
) => AsyncIterable<ResolvedEdge>;

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
