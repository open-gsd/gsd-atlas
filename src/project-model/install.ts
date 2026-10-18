import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { dirOf } from './globs.ts';
import { PROJECT_MODEL_CODES } from './types.ts';
import type { CompilerChoice, ProjectFs, TypeScriptInstall, TypeScriptInstallCase } from './types.ts';

/** The compiler the host ships (D-13); used whenever the project has no usable 6.x of its own. */
export const BUNDLED_VERSION = '6.0.3';

/** At most this many `exports` keys are kept; the layout decision needs two. */
const MAX_EXPORT_KEYS = 200;
/** A plain semantic version. Anything else in `version` is not trusted: it ends up in a cache key. */
const SEMVER = /^(\d{1,6})\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

const FALLBACK_REASONS: Readonly<Record<Exclude<TypeScriptInstallCase, 'project-6'>, string>> = {
  none: 'no project compiler',
  'project-7-unstable': 'project compiler is 7.x with the unstable layout',
  'project-7-sync': 'project compiler is 7.x with the sync layout',
  'project-7-unknown-layout': 'project compiler is 7.x with an unknown layout',
  'project-other': 'project compiler is not 6.x',
};

const none = (diagnostics: readonly Diagnostic[] = []): TypeScriptInstall => ({ case: 'none', exportKeys: [], diagnostics });

/** Which case a parsed `package.json` falls in. The layout rule is research Pattern 5, unchanged. */
function classify(major: number, exportKeys: readonly string[]): TypeScriptInstallCase {
  if (major === 6) return 'project-6';
  if (major === 7) {
    if (exportKeys.includes('./unstable/sync')) return 'project-7-unstable';
    if (exportKeys.includes('./sync')) return 'project-7-sync';
    return 'project-7-unknown-layout';
  }
  return 'project-other';
}

/**
 * Finds the project's TypeScript by reading `node_modules/typescript/package.json` in `ownerDir` and each directory
 * above it, nearest first, through the confined reader only (TSM-02, D-12, D-14). The package is data here: it is
 * never imported, required or run, so a hostile repository cannot execute anything through it.
 *
 * 6.x gives `project-6`. 7.x gives `project-7-unstable` when `exports` has `./unstable/sync`, else
 * `project-7-sync` when it has `./sync`, else `project-7-unknown-layout`. Another major gives `project-other`.
 * No package gives `none`; so does a package.json that cannot be used (a `typescript_package_invalid`
 * diagnostic) and one reached through a link that leaves the repository (`compiler_outside_repo`).
 */
export async function detectTypeScriptInstall(fs: ProjectFs, ownerDir: string): Promise<TypeScriptInstall> {
  for (let dir = ownerDir.replace(/^\/+|\/+$/g, ''); ; dir = dirOf(dir)) {
    const packageDir = dir === '' ? 'node_modules/typescript' : `${dir}/node_modules/typescript`;
    const packageJson = `${packageDir}/package.json`;
    const read = await fs.readText(packageJson);
    if (read.kind === 'escape') {
      return none([diagnostic(PROJECT_MODEL_CODES.compilerOutsideRepo, 'warning', 'the project TypeScript is reached through a link that leaves the repository and is not used', packageJson)]);
    }
    if (read.kind === 'not_file' || read.kind === 'too_large') {
      return none([diagnostic(PROJECT_MODEL_CODES.typescriptPackageInvalid, 'warning', `the project TypeScript package.json could not be read (${read.kind}) and is not used`, packageJson)]);
    }
    if (read.kind === 'ok') {
      const invalid = (): TypeScriptInstall =>
        none([diagnostic(PROJECT_MODEL_CODES.typescriptPackageInvalid, 'warning', 'the project TypeScript package.json is not usable (no valid version) and is not used', packageJson)]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text);
      } catch {
        return invalid();
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid();
      const record = parsed as Record<string, unknown>;
      const version = record['version'];
      const match = typeof version === 'string' ? SEMVER.exec(version) : null;
      if (typeof version !== 'string' || match === null) return invalid();
      const exportsField = record['exports'];
      const exportKeys =
        typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)
          ? Object.keys(exportsField).filter((k) => k.startsWith('.')).sort().slice(0, MAX_EXPORT_KEYS)
          : [];
      return { case: classify(Number(match[1]), exportKeys), version, dir: packageDir, exportKeys, diagnostics: [] };
    }
    if (dir === '') return none();
  }
}

/**
 * The compiler a precise resolver should load: the project's own copy for `project-6` (D-13), the bundled
 * {@link BUNDLED_VERSION} for every other case (D-12), with a fixed `reason` naming the case.
 */
export function selectCompiler(install: TypeScriptInstall): CompilerChoice {
  if (install.case === 'project-6' && install.version !== undefined && install.dir !== undefined) {
    return { source: 'project', version: install.version, dir: install.dir, case: install.case };
  }
  const kind = install.case === 'project-6' ? 'none' : install.case;
  return { source: 'bundled', version: BUNDLED_VERSION, reason: FALLBACK_REASONS[kind], case: kind };
}

/**
 * The `compiler_fallback` diagnostic for a choice that is not the project's own compiler, or undefined for one that
 * is. The message names the case and the fixed reason only; nothing the repository wrote (no version string, no path)
 * is copied into it.
 */
export function compilerFallbackDiagnostic(choice: CompilerChoice): Diagnostic | undefined {
  if (choice.source === 'project' || choice.reason === undefined) return undefined;
  return diagnostic(
    PROJECT_MODEL_CODES.compilerFallback,
    'warning',
    `the bundled TypeScript ${BUNDLED_VERSION} is used instead of the project compiler (case ${choice.case}: ${choice.reason})`,
  );
}
