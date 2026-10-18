import type { Diagnostic } from '../facts/index.ts';
import { createFileSetMatcher, hasHigherPriorityExtension } from './globs.ts';
import type { FileSetMatcher } from './globs.ts';
import { chooseOwner } from './owners.ts';
import { createReadContext, discoverConfigs, effectiveConfig } from './tsconfig.ts';
import type { ConfigInfo, DescribeInput, ProjectDescription, ProjectFs, ProjectModel } from './types.ts';

/** The ids of the built-in ProjectModels a manifest may name through `project.model` (ADR 5). */
export const PROJECT_MODEL_IDS: readonly string[] = ['typescript'];

export interface TypeScriptProjectModelOptions {
  /** Whether file names compare case-sensitively. Default true, as on Linux; set it from the file system on macOS and Windows. */
  readonly caseSensitive?: boolean;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Overlay paths that are usable as repo-relative POSIX paths, each once. */
function cleanOverlay(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (p === '' || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) continue;
    out.add(p);
  }
  return [...out].sort(compareCodeUnits);
}

/** Dedupes diagnostics that several chains reported for the same cause, keeping the first order. */
function uniqueDiagnostics(all: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of all) {
    const key = `${d.code}\u0000${d.subject ?? ''}\u0000${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * The compiler-free ProjectModel for TypeScript (TSM-07). It reads tsconfig and jsconfig files through the
 * injected, confined reader and never loads the TypeScript package, so it works with no compiler installed and
 * a hostile repository cannot make it run any of its code.
 */
export function createTypeScriptProjectModel(defaultFs?: ProjectFs, options: TypeScriptProjectModelOptions = {}): ProjectModel {
  const caseSensitive = options.caseSensitive ?? true;
  return {
    id: 'typescript',
    async describe(input: DescribeInput): Promise<ProjectDescription> {
      const fs = input.fs ?? defaultFs;
      if (fs === undefined) throw new TypeError('describe needs a ProjectFs: pass one to describe() or to createTypeScriptProjectModel()');
      const overlay = cleanOverlay(input.overlayPaths);
      const overlaySet = new Set(overlay);
      const ctx = createReadContext(fs);

      const nodes = await discoverConfigs(ctx, overlay, input.extraConfigs);
      const effective = nodes.map((node) => effectiveConfig(ctx, node));
      const configs: ConfigInfo[] = effective.map((e) => e.info);

      const matchers = new Map<string, { readonly info: ConfigInfo; readonly matcher: FileSetMatcher; readonly memo: Map<string, boolean> }>();
      for (const info of configs) {
        const matcher = createFileSetMatcher({
          configDir: info.path.includes('/') ? info.path.slice(0, info.path.lastIndexOf('/')) : '',
          files: info.files,
          include: info.include,
          exclude: info.exclude,
          allowJs: info.allowJs,
          caseSensitive,
        });
        matchers.set(info.path, { info, matcher, memo: new Map() });
      }

      const matches = (configPath: string, p: string): boolean => {
        const entry = matchers.get(configPath);
        if (entry === undefined) return false;
        const known = entry.memo.get(p);
        if (known !== undefined) return known;
        const { matcher, info } = entry;
        let result = matcher.isLiteral(p);
        if (!result && matcher.isWildcardCandidate(p)) {
          // A literal sibling is a member whether or not it exists; a wildcard sibling must be in the overlay.
          result = !hasHigherPriorityExtension(p, info.allowJs, (sibling) => matcher.isLiteral(sibling) || (overlaySet.has(sibling) && matcher.isWildcardCandidate(sibling)));
        }
        entry.memo.set(p, result);
        return result;
      };

      const owners = new Map<string, string | undefined>();
      const ownerOf = (p: string): string | undefined => {
        if (owners.has(p)) return owners.get(p);
        const owner = chooseOwner(p, configs.filter((c) => matches(c.path, p)).map((c) => c.path));
        owners.set(p, owner);
        return owner;
      };

      return {
        context: { id: 'typescript:unknown', configHashes: [] },
        configs,
        matches,
        ownerOf,
        compiler: { source: 'bundled', version: '6.0.3', case: 'none' },
        diagnostics: uniqueDiagnostics(ctx.diagnostics),
      };
    },
  };
}
