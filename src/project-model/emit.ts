import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { resolveRepoPath } from './globs.ts';
import { PROJECT_MODEL_CODES } from './types.ts';
import type { ConfigInfo, EmitMap, EmitOutput } from './types.ts';

/**
 * Where the configs write the output of the overlay's sources (TSM-03), by TypeScript's own rules. The model is a
 * re-statement of `ts.getOutputFileNames` (checked against it by the emit tests and by `--emit` in
 * `scripts/project-model-differential.ts`): the extension map, `rootDir`, `outDir`, `declarationDir`, declaration
 * files that never emit, and JavaScript inputs under `allowJs`. Source maps and build info are not outputs here.
 *
 * All path arithmetic is on repo-relative POSIX strings through `resolveRepoPath`, so a Windows backslash never
 * enters a key.
 */

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A declaration file never emits: `.d.ts`, `.d.cts`, `.d.mts` and the arbitrary-extension form `.d.<ext>.ts`. */
const DECLARATION_FILE = /\.d\.(?:[cm]?ts|[^./]+\.ts)$/;

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** The longest list of sources a diagnostic message names. */
const NAMED_SOURCES = 4;

interface Parts {
  /** The path without its last extension. */
  readonly stem: string;
  readonly extension: string;
}

function partsOf(path: string): Parts | undefined {
  if (DECLARATION_FILE.test(path)) return undefined;
  const dot = path.lastIndexOf('.');
  if (dot <= path.lastIndexOf('/') + 1) return undefined; // no extension, or a dot file
  const extension = path.slice(dot);
  return SOURCE_EXTENSIONS.has(extension) ? { stem: path.slice(0, dot), extension } : undefined;
}

/** `ts.getOutputExtension`: what the code a source compiles to is called. */
function codeExtension(extension: string, preserveJsx: boolean): string {
  if (preserveJsx && (extension === '.jsx' || extension === '.tsx')) return '.jsx';
  if (extension === '.mts' || extension === '.mjs') return '.mjs';
  if (extension === '.cts' || extension === '.cjs') return '.cjs';
  return '.js';
}

/** `ts.getDeclarationEmitExtensionForPath`: what the declaration file of a source is called. */
function declarationExtension(extension: string): string {
  if (extension === '.mts' || extension === '.mjs') return '.d.mts';
  if (extension === '.cts' || extension === '.cjs') return '.d.cts';
  return '.d.ts';
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
 * `matches` says whether a path belongs to a config's file set. The map is a pure function of the configs, the
 * overlay paths and `matches`, and never depends on a content hash.
 */
export function buildEmitMap(
  configs: readonly ConfigInfo[],
  overlayPaths: readonly string[],
  matches: (configPath: string, path: string) => boolean,
): EmitMap {
  const bySource = new Map<string, EmitOutput[]>();
  const claimants = new Map<string, Set<string>>();
  const diagnostics: Diagnostic[] = [];

  for (const config of configs) {
    if (config.outFile) continue; // one bundle, not one file per source
    if (config.emitEscapes) {
      diagnostics.push(
        diagnostic(PROJECT_MODEL_CODES.emitOutsideRepo, 'warning', 'rootDir, outDir or declarationDir leaves the repository, so none of this config\'s outputs is mapped', config.path),
      );
      continue;
    }
    // TypeScript 6 roots the output tree at the config's directory when `rootDir` is not set.
    const root = asDir(config.rootDir) ?? dirOfPath(config.path);
    const outDir = asDir(config.outDir);
    const declarationDir = asDir(config.declarationDir) ?? outDir;
    // `ts.getOutputFileNames` ignores `noEmit`, and a typecheck config that extends the build config (gsd-core's
    // `tsconfig.json`) is how the build's outDir is found when nothing references the build config. So a noEmit config
    // places its outputs by its outDir; one with no outDir would only claim `.js` files beside its sources, which it
    // never writes, so it maps nothing.
    if (config.noEmit && outDir === undefined) continue;
    const preserveJsx = config.jsx?.toLowerCase() === 'preserve';

    /** The stem of `source`'s output below `dir` (`undefined` dir: beside the source), or undefined when it is outside `root`. */
    const stemIn = (dir: string | undefined, source: string, stem: string): string | undefined => {
      if (dir === undefined) return stem;
      const relative = below(root, stem);
      return relative === undefined ? undefined : resolveRepoPath(dir, relative);
    };

    for (const source of overlayPaths) {
      const parts = partsOf(source);
      if (parts === undefined || !matches(config.path, source)) continue;
      const outputs: EmitOutput[] = [];
      if (!config.emitDeclarationOnly) {
        const stem = stemIn(outDir, source, parts.stem);
        if (stem !== undefined) outputs.push({ path: stem + codeExtension(parts.extension, preserveJsx), kind: 'js' });
      }
      if (config.declaration) {
        const stem = stemIn(declarationDir, source, parts.stem);
        if (stem !== undefined) outputs.push({ path: stem + declarationExtension(parts.extension), kind: 'declaration' });
      }
      for (const output of outputs) {
        if (output.path === source) continue; // it would overwrite its own input (TS5055): not an output
        const known = bySource.get(source) ?? [];
        if (!known.some((each) => each.path === output.path)) known.push(output);
        bySource.set(source, known);
        const claimed = claimants.get(output.path) ?? new Set<string>();
        claimed.add(source);
        claimants.set(output.path, claimed);
      }
    }
  }

  // An output that is also a source of some config stays a source: it is never dropped from the index (T-03-221).
  const overlay = new Set(overlayPaths);
  for (const output of [...claimants.keys()].sort(compareCodeUnits)) {
    if (!overlay.has(output) || !configs.some((config) => matches(config.path, output))) continue;
    claimants.delete(output);
    diagnostics.push(
      diagnostic(PROJECT_MODEL_CODES.emitOverlapsSource, 'warning', 'this path is a source of a config and also the output of another source; it stays a source', output),
    );
  }
  // Two sources writing one output: the inverse says nothing and the plain specifier rule applies (T-03-222).
  for (const [output, sources] of [...claimants].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (sources.size < 2) continue;
    const named = [...sources].sort(compareCodeUnits);
    const shown = named.slice(0, NAMED_SOURCES).join(', ');
    const more = named.length > NAMED_SOURCES ? ` and ${String(named.length - NAMED_SOURCES)} more` : '';
    diagnostics.push(diagnostic(PROJECT_MODEL_CODES.emitAmbiguous, 'warning', `these sources emit to this path, so it maps to none of them: ${shown}${more}`, output));
  }

  const order = { js: 0, declaration: 1 } as const;
  return {
    outputToSource(path) {
      const sources = claimants.get(path);
      if (sources === undefined || sources.size !== 1) return undefined;
      return sources.values().next().value as string;
    },
    sourceToOutputs: (path) => (bySource.get(path) ?? []).map((output) => output.path).sort(compareCodeUnits),
    isOutput: (path) => claimants.has(path),
    outputsOf: (path) =>
      [...(bySource.get(path) ?? [])].sort((a, b) => order[a.kind] - order[b.kind] || compareCodeUnits(a.path, b.path)),
    diagnostics,
  };
}
