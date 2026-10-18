/**
 * The Tenant's project context (TSM-03, plan 03-22): the one place that turns the module manifests' `project.model`
 * into what the Fact Store and the Indexer need.
 *
 * - `createProjectContextProvider` builds the store's `projectContext` provider. For an overlay snapshot it describes
 *   the project through the named ProjectModel (configs, compiler identity, where sources are emitted to) and returns
 *   the resolution context plus the emit lookup. A repository whose modules name no model, or that has no config,
 *   gets the grammar-tier context of Phase 2 and nothing else changes.
 * - It is cheap on an unchanged project. The store asks once per overlay snapshot and a snapshot changes with every
 *   edit, so the provider remembers its answer per worktree and describes again only when the set of overlay paths
 *   changes or a config file it read changed. An edit of a source file costs one small read per config file and no
 *   process start (T-03-224).
 * - `createOutputFilter` is the Indexer's view of the same description: the paths that are the emit output of an
 *   included source and so get no facts (OQ3).
 */
import { createHash } from 'node:crypto';
import { DEFAULT_PROJECT_CONTEXT } from '../facts/index.ts';
import type { Diagnostic, EmitLookup, PreciseFacts, ProjectContext, ProjectContextProvider, ResolutionContext } from '../facts/index.ts';
import type { OutputFilter } from '../indexer/index.ts';
import { readManifest, resolveModules } from '../lang/index.ts';
import type { Roots } from '../lang/index.ts';
import { createProjectModel, normalizedHash } from '../project-model/index.ts';
import type { ProjectDescription, ProjectFs, ProjectModel } from '../project-model/index.ts';
import type { SourceTree } from '../source-tree/index.ts';

/** The provider the store is given, plus what the Indexer's filter reads from the same memo. */
export interface ProjectProvider extends ProjectContextProvider {
  /** The paths of `paths` that are the emit output of an included source. Never throws; on trouble it excludes nothing. */
  exclude(worktree: string, paths: Iterable<string>): Promise<ReadonlySet<string>>;
  /** True when `path` is an emit output according to the last description of the worktree; false before there is one. */
  isOutput(worktree: string, path: string): boolean;
  /** What the last description of the worktree reported (fixed words and paths). */
  diagnostics(worktree: string): readonly Diagnostic[];
  /** The precise-tier facts of the last description of the worktree, or undefined before there is one (plan 03-23). */
  precise(worktree: string): PreciseFacts | undefined;
  /** The resolution context of the last description of the worktree, or undefined before there is one (plan 03-29: the warm start). */
  resolution(worktree: string): ResolutionContext | undefined;
}

export interface ProjectProviderDeps {
  readonly tree: Pick<SourceTree, 'readText'>;
  /** The ProjectModels by id (`typescript` today). */
  readonly models: ReadonlyMap<string, ProjectModel>;
  /** The id of the ProjectModel the module serving `path` names through `project.model`, or undefined. */
  readonly moduleForPath: (path: string) => string | undefined;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What one description of one model read, kept to tell whether it is still true. */
interface Described {
  readonly files: ReadonlyMap<string, string>;
  readonly candidates: readonly string[];
  readonly present: ReadonlySet<string>;
}

interface Built {
  readonly context: ProjectContext;
  readonly described: readonly Described[];
  readonly diagnostics: readonly Diagnostic[];
}

interface Entry {
  /** The key of the path set the description was built from. */
  readonly pathsKey: string;
  /** The key of that set without the paths found to be outputs, which is what the store's overlay holds after a build. */
  readonly overlayKey: string;
  readonly built: Built;
}

const NOTHING: Built = { context: DEFAULT_PROJECT_CONTEXT, described: [], diagnostics: [] };

function keyOf(paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const p of paths) hash.update(p).update('\u0000');
  return hash.digest('hex');
}

/** A TypeScript source (not JavaScript): a file the compiler resolves only under a config. */
const TYPESCRIPT_FILE = /\.(?:[cm]?ts|tsx)$/i;

/**
 * What a compiler-backed resolver needs from a description (plan 03-23). Only the `typescript` model has a resolver
 * today; any other model gives none. The lookups close over the description, so they answer for the path set it read.
 */
function preciseFactsOf(modelId: string, description: ProjectDescription): PreciseFacts | undefined {
  if (modelId !== 'typescript') return undefined;
  const { compiler } = description;
  return {
    ownerOf: (p) => description.ownerOf(p),
    requiresOwner: (p) => TYPESCRIPT_FILE.test(p),
    compiler: {
      source: compiler.source,
      version: compiler.version,
      ...(compiler.dir === undefined ? {} : { dir: compiler.dir }),
      ...(compiler.reason === undefined ? {} : { reason: compiler.reason }),
      case: compiler.case,
    },
    configs: description.configs.map((config) => config.path),
  };
}

/** Several models at once: the contexts side by side, the emit lookups asked in id order. Today there is one. */
function combine(parts: readonly ProjectContext[]): ProjectContext {
  const [only] = parts;
  if (parts.length === 1 && only !== undefined) return only;
  const lookups = parts.map((part) => part.emit).filter((emit): emit is EmitLookup => emit !== undefined);
  const precise = parts.find((part) => part.precise !== undefined)?.precise;
  return {
    ...(precise === undefined ? {} : { precise }),
    context: {
      id: parts.map((part) => part.context.id).join('+'),
      configHashes: parts.flatMap((part) => part.context.configHashes).sort(compareCodeUnits),
    },
    ...(lookups.length === 0
      ? {}
      : {
          emit: {
            outputToSource: (p) => lookups.map((emit) => emit.outputToSource(p)).find((source) => source !== undefined),
            sourceToOutputs: (p) => [...new Set(lookups.flatMap((emit) => emit.sourceToOutputs(p)))].sort(compareCodeUnits),
            isOutput: (p) => lookups.some((emit) => emit.isOutput(p)),
          },
        }),
  };
}

export function createProjectContextProvider(deps: ProjectProviderDeps): ProjectProvider {
  const { tree, models, moduleForPath } = deps;
  const memo = new Map<string, Entry>();
  const flights = new Map<string, Promise<Built>>();

  const fsFor = (worktree: string): ProjectFs => ({
    readText: (p) => tree.readText(worktree, p),
    async exists(paths) {
      const found = new Set<string>();
      // One byte is enough to tell a file from nothing: a file over the cap still exists.
      for (const p of paths) {
        const read = await tree.readText(worktree, p, { maxBytes: 1 });
        if (read.kind === 'ok' || read.kind === 'too_large') found.add(p);
      }
      return found;
    },
  });

  /** The models some path of `paths` is served by, in id order. */
  function modelsFor(paths: readonly string[]): ProjectModel[] {
    const wanted = new Set<string>();
    for (const p of paths) {
      const id = moduleForPath(p);
      if (id !== undefined && models.has(id)) wanted.add(id);
      if (wanted.size === models.size) break;
    }
    return [...wanted].sort(compareCodeUnits).map((id) => models.get(id) as ProjectModel);
  }

  /** True while everything a description read is as it was. `probe` also checks that no config appeared or went away. */
  async function stillTrue(built: Built, fs: ProjectFs, probe: boolean): Promise<boolean> {
    for (const each of built.described) {
      for (const [file, hash] of each.files) {
        const read = await fs.readText(file);
        if (read.kind !== 'ok' || normalizedHash(read.text) !== hash) return false;
      }
      if (probe) {
        const now = await fs.exists(each.candidates);
        if (now.size !== each.present.size || [...now].some((p) => !each.present.has(p))) return false;
      }
    }
    return true;
  }

  async function describeAll(worktree: string, paths: readonly string[]): Promise<Built> {
    const used = modelsFor(paths);
    if (used.length === 0) return NOTHING;
    const fs = fsFor(worktree);
    const contexts: ProjectContext[] = [];
    const described: Described[] = [];
    const diagnostics: Diagnostic[] = [];
    let bare: PreciseFacts | undefined;
    for (const model of used) {
      const description: ProjectDescription = await model.describe({ overlayPaths: paths, fs });
      diagnostics.push(...description.diagnostics, ...description.emit.diagnostics);
      // What was read is remembered even when it found no config, so a config that appears is noticed (see `stillTrue`).
      described.push({
        files: description.configFiles,
        candidates: description.configProbe.candidates,
        present: new Set(description.configProbe.present),
      });
      const precise = preciseFactsOf(model.id, description);
      // A project with no config is not a project: the store keeps the grammar-tier context of Phase 2, plus the precise
      // facts that say no config covers anything, so a TypeScript file in it is answered `precise_unavailable`.
      if (description.configs.length > 0) {
        contexts.push({ context: description.context, emit: description.emit, ...(precise === undefined ? {} : { precise }) });
      } else if (precise !== undefined) {
        bare = precise;
      }
    }
    if (contexts.length === 0) {
      return { context: bare === undefined ? DEFAULT_PROJECT_CONTEXT : { ...DEFAULT_PROJECT_CONTEXT, precise: bare }, described, diagnostics };
    }
    return { context: combine(contexts), described, diagnostics };
  }

  /** The description of `paths` for `worktree`: the remembered one while it is still true, else a fresh one (shared by concurrent callers). */
  async function builtFor(worktree: string, paths: readonly string[], probe: boolean): Promise<{ built: Built; excluded: ReadonlySet<string> }> {
    const sorted = [...new Set(paths)].sort(compareCodeUnits);
    const key = keyOf(sorted);
    const known = memo.get(worktree);
    const outputsAmong = (built: Built): ReadonlySet<string> =>
      new Set(built.context.emit === undefined ? [] : sorted.filter((p) => built.context.emit?.isOutput(p) === true));
    if (known !== undefined && (known.pathsKey === key || known.overlayKey === key) && (await stillTrue(known.built, fsFor(worktree), probe))) {
      return { built: known.built, excluded: outputsAmong(known.built) };
    }
    const flightKey = `${worktree}\u0000${key}`;
    let flight = flights.get(flightKey);
    if (flight === undefined) {
      flight = describeAll(worktree, sorted).finally(() => {
        flights.delete(flightKey);
      });
      flights.set(flightKey, flight);
    }
    const built = await flight;
    const excluded = outputsAmong(built);
    const overlayKey = excluded.size === 0 ? key : keyOf(sorted.filter((p) => !excluded.has(p)));
    memo.set(worktree, { pathsKey: key, overlayKey, built });
    return { built, excluded };
  }

  const provider = async (scope: Parameters<ProjectContextProvider>[0]): Promise<ProjectContext> => {
    const paths = [...scope.overlay.pathToHash.keys()];
    return (await builtFor(scope.worktree, paths, false)).built.context;
  };

  return Object.assign(provider, {
    async exclude(worktree: string, paths: Iterable<string>): Promise<ReadonlySet<string>> {
      try {
        return (await builtFor(worktree, [...paths], true)).excluded;
      } catch {
        return new Set<string>(); // fail open: when the project cannot be described nothing is dropped
      }
    },
    isOutput(worktree: string, path: string): boolean {
      return memo.get(worktree)?.built.context.emit?.isOutput(path) === true;
    },
    diagnostics(worktree: string): readonly Diagnostic[] {
      return memo.get(worktree)?.built.diagnostics ?? [];
    },
    precise(worktree: string): PreciseFacts | undefined {
      return memo.get(worktree)?.built.context.precise;
    },
    resolution(worktree: string): ResolutionContext | undefined {
      return memo.get(worktree)?.built.context.context;
    },
  });
}

/** The Indexer's output filter over a provider's memo. */
export function createOutputFilter(provider: ProjectProvider): OutputFilter {
  return {
    exclude: (worktree, paths) => provider.exclude(worktree, paths),
    isOutput: (worktree, path) => provider.isOutput(worktree, path),
  };
}

/** The lower-case extension of the last path segment, with its dot, or '' (same rule as Source Tree and the module host). */
function extensionOf(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Which ProjectModel each extension's module names (`project.model` in its manifest), for the modules that win the
 * registry's precedence and serve the extension. Read once, from manifests only: nothing a manifest names is run.
 */
export function modelIdsByExtension(roots: Roots): ReadonlyMap<string, string> {
  const byExtension = new Map<string, string>();
  for (const entry of resolveModules(roots).modules) {
    const read = readManifest(entry.dir);
    const model = read.ok ? read.manifest.project?.model : undefined;
    if (model === undefined) continue;
    for (const extension of entry.extensions) {
      if (!entry.inactiveExtensions.includes(extension)) byExtension.set(extension.toLowerCase(), model);
    }
  }
  return byExtension;
}

/**
 * The precise adapter ids the manifests of the modules that serve at least one extension name through `precise.adapter`,
 * sorted. Read once, from manifests only: an id is data that picks from the Host's own table, and nothing a manifest names
 * is started, resolved or imported (T-03-235).
 */
export function preciseAdapterIds(roots: Roots): readonly string[] {
  const ids = new Set<string>();
  for (const entry of resolveModules(roots).modules) {
    if (entry.extensions.every((extension) => entry.inactiveExtensions.includes(extension))) continue;
    const read = readManifest(entry.dir);
    const precise = read.ok ? read.manifest.precise : undefined;
    if (precise !== undefined && 'adapter' in precise) ids.add(precise.adapter);
  }
  return [...ids].sort(compareCodeUnits);
}

/** The provider for a Tenant: the models the manifests name, or undefined when none does (Phase 2 behaviour, untouched). */
export function createTenantProjectProvider(tree: Pick<SourceTree, 'readText'>, roots: Roots): ProjectProvider | undefined {
  const byExtension = modelIdsByExtension(roots);
  if (byExtension.size === 0) return undefined;
  // File names compare case-insensitively on macOS and Windows file systems, as they do for the compiler there.
  const caseSensitive = process.platform !== 'darwin' && process.platform !== 'win32';
  const models = new Map<string, ProjectModel>();
  for (const id of new Set(byExtension.values())) {
    const model = createProjectModel(id, undefined, { caseSensitive });
    if (model !== undefined) models.set(id, model);
  }
  if (models.size === 0) return undefined;
  return createProjectContextProvider({ tree, models, moduleForPath: (p) => byExtension.get(extensionOf(p)) });
}
