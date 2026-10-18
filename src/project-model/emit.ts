import type { Diagnostic } from '../facts/index.ts';
import { resolveRepoPath } from './globs.ts';
import type { ConfigInfo, EmitMap, EmitOutput } from './types.ts';

/** The extension a compiler gives the code it writes for a source, by the source's extension. */
const JS_EXTENSION: Readonly<Record<string, string>> = { '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs' };

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `path` with its last extension replaced, or undefined when it is not a source this rule maps. */
function emittedName(path: string): string | undefined {
  if (/\.d\.[cm]?ts$/.test(path)) return undefined; // declaration files never emit
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash + 1) return undefined; // no extension, or a dot file
  const mapped = JS_EXTENSION[path.slice(dot)];
  return mapped === undefined ? undefined : path.slice(0, dot) + mapped;
}

/** `p` below the repo-relative directory `dir` ('' is the root), or undefined when it is not below it. */
function below(dir: string, p: string): string | undefined {
  if (dir === '') return p;
  return p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : undefined;
}

const dirOfPath = (p: string): string => (p.lastIndexOf('/') === -1 ? '' : p.slice(0, p.lastIndexOf('/')));

/** An option directory as the config reports it (`.` for the root) as a repo-relative directory ('' is the root). */
const asDir = (dir: string | undefined): string | undefined => (dir === undefined ? undefined : dir === '.' ? '' : dir);

/**
 * Where the configs write the output of the overlay's sources (TSM-03). `matches` says whether a path belongs to a
 * config's file set. The map is a pure function of the configs, the overlay paths and `matches`.
 */
export function buildEmitMap(
  configs: readonly ConfigInfo[],
  overlayPaths: readonly string[],
  matches: (configPath: string, path: string) => boolean,
): EmitMap {
  const bySource = new Map<string, EmitOutput[]>();
  const outputToSource = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];

  for (const config of configs) {
    if (config.outFile) continue;
    // TypeScript 6 roots the output tree at the config's directory when `rootDir` is not set.
    const root = asDir(config.rootDir) ?? dirOfPath(config.path);
    const outDir = asDir(config.outDir);
    // `ts.getOutputFileNames` ignores `noEmit`, and a typecheck config that extends the build config (gsd-core's
    // `tsconfig.json`) is how the build's outDir is found when nothing references the build config. So a noEmit config
    // places its outputs by its outDir; one with no outDir would only claim `.js` files beside its sources, which it
    // never writes, so it maps nothing.
    if (config.noEmit && outDir === undefined) continue;
    for (const source of overlayPaths) {
      const name = emittedName(source);
      if (name === undefined || !matches(config.path, source)) continue;
      let output: string;
      if (outDir === undefined) output = name;
      else {
        const relative = below(root, name);
        if (relative === undefined) continue;
        output = resolveRepoPath(outDir, relative);
      }
      if (output === source) continue;
      if (!outputToSource.has(output)) outputToSource.set(output, source);
      const list = bySource.get(source) ?? [];
      if (!list.some((known) => known.path === output)) list.push({ path: output, kind: 'js' });
      bySource.set(source, list);
    }
  }

  return {
    outputToSource: (path) => outputToSource.get(path),
    sourceToOutputs: (path) => (bySource.get(path) ?? []).map((output) => output.path).sort(compareCodeUnits),
    isOutput: (path) => outputToSource.has(path),
    outputsOf: (path) => bySource.get(path) ?? [],
    diagnostics,
  };
}
