import { isDegradedCode } from './degraded.ts';
import type { DegradedCode } from './degraded.ts';
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
 * The compiler a precise resolver should load for a project, as plain data (the shape of the ProjectModel's
 * `CompilerChoice`, repeated here because the kernel imports nothing). `dir` is repository-relative.
 */
export interface CompilerFacts {
  readonly source: 'project' | 'bundled';
  readonly version: string;
  /** The project's package directory, repository-relative, only when `source` is `project`. */
  readonly dir?: string;
  /** Why the bundled compiler was chosen, one of a fixed set of strings; absent for a project compiler. */
  readonly reason?: string;
  /** The install case the choice came from (`none`, `project-6`, `project-7-unstable`, ...). */
  readonly case: string;
}

/**
 * What a compiler-backed resolver needs to know about the project (plan 03-23): which config owns a path, which
 * compiler to load and the configs that exist. Data and pure lookups only; nothing here reads a file.
 */
export interface PreciseFacts {
  /** The repository-relative path of the one config that owns `path`, or undefined when no config covers it. */
  ownerOf(path: string): string | undefined;
  /**
   * True for a path the compiler resolves only under a config (a TypeScript file); false for one it may resolve without
   * (a JavaScript file) or does not handle. A path that requires an owner and has none makes an answer
   * `precise_unavailable`.
   */
  requiresOwner(path: string): boolean;
  readonly compiler: CompilerFacts;
  /** Repository-relative paths of the configs that were read, in lexical order. */
  readonly configs: readonly string[];
}

/**
 * What a resolver learns about the configuration it resolves under, besides the `ResolutionContext` that keys
 * the cache. Nothing else belongs in it without a plan.
 */
export interface ProjectContext {
  readonly context: ResolutionContext;
  /** Where the project's compiler writes its output; absent for a store with no project model or no config. */
  readonly emit?: EmitLookup;
  /** What a compiler-backed resolver needs (plan 03-23); absent for a store with no project model or no config. */
  readonly precise?: PreciseFacts;
  /**
   * Codes every read that has reference sites to resolve carries under this context, whether or not a resolver ran:
   * the state of the precise tier (for example `precise_unavailable` while the provider is turned off), not an event.
   */
  readonly degraded?: readonly DegradedCode[];
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
 * A condition a resolver reports without failing the read (plan 03-23): the answer keeps the edges it has and gains
 * the code. It travels in the same stream as the edges, so a resolver that never yields one is unchanged.
 */
export interface ResolverNotice {
  readonly kind: 'notice';
  readonly degraded: DegradedCode;
}

/** True when a thing a resolver yielded is a {@link ResolverNotice} and not an edge or a relation. */
export function isResolverNotice(value: ResolvedEdge | ResolvedRelation | ResolverNotice): value is ResolverNotice {
  return (value as { readonly kind?: unknown }).kind === 'notice';
}

/**
 * The error a resolver throws when it fails for a reason that has its own degraded code (for example `memory_budget`
 * when its compiler worker ran out of memory). The store answers with that code instead of `resolver_failed`.
 */
export class ResolverFailure extends Error {
  readonly degradedCode: DegradedCode;

  constructor(degradedCode: DegradedCode, message: string) {
    super(message);
    this.name = 'ResolverFailure';
    this.degradedCode = degradedCode;
  }
}

/** The degraded code a thrown resolver error asks for; `resolver_failed` for any error without a known code. */
export function degradedCodeOf(error: unknown): DegradedCode {
  const code = (error as { readonly degradedCode?: unknown } | null | undefined)?.degradedCode;
  return typeof code === 'string' && isDegradedCode(code) ? code : 'resolver_failed';
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

/**
 * A {@link ResolverPort} that may also yield {@link ResolverNotice}s among its edges (plan 03-23). It is what the Fact
 * Store accepts: every `ResolverPort` is one, so a resolver that never yields a notice is unchanged.
 */
export type NoticingResolverPort = ((
  sites: readonly RefSiteKey[],
  context: ResolutionContext,
  symbols: SymbolLookup,
  scope?: ResolveScope,
) => AsyncIterable<ResolvedEdge | ResolverNotice>) & {
  /**
   * The optional relations method (plan 03-25, OQ1): symbol-to-symbol relations a compiler knows and a reference site
   * cannot carry. A port without it simply yields no relations; nothing else about the port changes.
   */
  readonly relations?: RelationsPort;
};

/**
 * The symbol-to-symbol relations a compiler reports (plan 03-25, OQ1). `extends` and `implements` relate a class or an
 * interface to the declaration it names in its heritage clause; `overrides` relates a class member to the base-class member
 * it overrides, including an abstract one. A class member that only implements an interface member is not an `overrides`.
 */
export type RelationKind = 'extends' | 'implements' | 'overrides';

/** The relation kinds in the order they are listed and ranked. */
export const RELATION_KINDS: readonly RelationKind[] = Object.freeze(['extends', 'implements', 'overrides']);

/** True when `value` is one of the three relation kinds. */
export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === 'string' && (RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * One relation between two symbols, always compiler-resolved (`EXTRACTED`). Both endpoints name the symbol identity the
 * grammar tier stores; a relation whose endpoints the overlay does not hold is discarded by the store, like an edge.
 */
export interface ResolvedRelation {
  /** The subtype (`extends`, `implements`) or the overriding member (`overrides`). */
  readonly from: SymbolIdentity;
  /** The base class or interface, or the base member. */
  readonly to: SymbolIdentity;
  readonly relation: RelationKind;
  readonly resolver: string;
}

/**
 * The injected relations port: the relations whose `from` symbol is declared in one of `files` (repository-relative POSIX
 * paths of the overlay). Like {@link ResolverPort} it reads symbols only through the read-only lookup, may yield notices,
 * and may fail with an error that carries a degraded code.
 */
export type RelationsPort = (
  files: readonly string[],
  context: ResolutionContext,
  symbols: SymbolLookup,
  scope?: ResolveScope,
) => AsyncIterable<ResolvedRelation | ResolverNotice>;

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
