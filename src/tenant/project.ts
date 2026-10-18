/**
 * The Tenant's project context (TSM-03, plan 03-22). RED scaffold: answers the grammar-tier context and drops nothing.
 */
import { DEFAULT_PROJECT_CONTEXT } from '../facts/index.ts';
import type { ProjectContext, ProjectContextProvider } from '../facts/index.ts';
import type { OutputFilter } from '../indexer/index.ts';
import type { Roots } from '../lang/index.ts';
import type { ProjectModel } from '../project-model/index.ts';
import type { SourceTree } from '../source-tree/index.ts';

export interface ProjectProvider extends ProjectContextProvider {
  exclude(worktree: string, paths: Iterable<string>): Promise<ReadonlySet<string>>;
  isOutput(worktree: string, path: string): boolean;
}

export interface ProjectProviderDeps {
  readonly tree: Pick<SourceTree, 'readText'>;
  readonly models: ReadonlyMap<string, ProjectModel>;
  readonly moduleForPath: (path: string) => string | undefined;
}

export function createProjectContextProvider(_deps: ProjectProviderDeps): ProjectProvider {
  const provider = async (): Promise<ProjectContext> => DEFAULT_PROJECT_CONTEXT;
  return Object.assign(provider, {
    exclude: async (): Promise<ReadonlySet<string>> => new Set<string>(),
    isOutput: (): boolean => false,
  });
}

export function createOutputFilter(provider: ProjectProvider): OutputFilter {
  return { exclude: (worktree, paths) => provider.exclude(worktree, paths), isOutput: (worktree, path) => provider.isOutput(worktree, path) };
}

export function modelIdsByExtension(_roots: Roots): ReadonlyMap<string, string> {
  return new Map();
}
