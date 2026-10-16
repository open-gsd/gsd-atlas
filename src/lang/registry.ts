/**
 * The language-module registry (D-03, LNG-01): finds modules in four places and says which copy wins.
 *
 * Precedence, highest first: repo, user, npm, built-in. A module name is the folder name (for npm,
 * the package-name suffix), so the same module placed in several locations is one module with one
 * active copy and the others listed as shadowed. A copy that cannot be read or validated is skipped
 * with a diagnostic and the next tier's valid copy takes over (FND-03); nothing here throws.
 *
 * The registry reads only the plain absolute root paths it is given. It never looks up the home
 * directory or the working directory, because only the composition root knows those. It also never
 * starts, resolves or imports anything a manifest names: every status below is computed from
 * manifest data alone (trust-boundaries ADR, T-01-36).
 */
import fs from 'node:fs';
import path from 'node:path';

import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { readManifest } from './module-files.ts';
import type { Manifest } from './manifest.ts';

export type ModuleSource = 'repo' | 'user' | 'npm' | 'builtin';

/** Highest precedence first. */
export const MODULE_SOURCES: readonly ModuleSource[] = ['repo', 'user', 'npm', 'builtin'];

/** Plain absolute paths. Supplied by the composition root (or a request override); never derived here. */
export interface Roots {
  /** The repository being analysed: modules live in `<repoRoot>/.gsd-atlas/languages/<name>/`. */
  readonly repoRoot: string;
  /** User-level config folder: modules live in `<userDir>/languages/<name>/`. */
  readonly userDir: string;
  /** Modules shipped with the package: `<builtinDir>/<name>/`. Null when there is none. */
  readonly builtinDir: string | null;
  /** Folders whose `node_modules` may hold `gsd-atlas-lang-<name>` or `@opengsd/atlas-lang-<name>`. */
  readonly npmRoots: readonly string[];
}

export interface TierStatus {
  readonly tier: 'grammar' | 'precise' | 'platform';
  readonly active: boolean;
  readonly reason?: string;
}

export interface ShadowedCopy {
  readonly source: ModuleSource;
  readonly dir: string;
}

export interface ModuleEntry {
  readonly name: string;
  /** Where the active copy was found. */
  readonly source: ModuleSource;
  /** Real path of the active copy's folder. */
  readonly dir: string;
  readonly version?: string;
  /** Every extension the manifest declares. */
  readonly extensions: readonly string[];
  /** The subset of `extensions` another module owns; the module does not serve these. */
  readonly inactiveExtensions: readonly string[];
  readonly tiers: readonly TierStatus[];
  /** Lower-precedence copies of the same module, highest precedence first. */
  readonly shadowed: readonly ShadowedCopy[];
}

export interface ResolveModulesResult {
  readonly modules: readonly ModuleEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResolveModuleResult {
  readonly entry: ModuleEntry | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

/** A module id: the manifest's own name rule, so an id can never be a path. */
export const MODULE_ID = /^[a-z][a-z0-9-]*$/;

const REPO_LANGUAGES = path.join('.gsd-atlas', 'languages');
const NPM_UNSCOPED_PREFIX = 'gsd-atlas-lang-';
const NPM_SCOPE = '@opengsd';
const NPM_SCOPED_PREFIX = 'atlas-lang-';

interface Location {
  readonly source: ModuleSource;
  /** The name this folder claims by where it sits. */
  readonly expectedName: string;
  readonly dir: string;
}

interface Candidate extends Location {
  readonly manifest: Manifest;
}

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sub-folders of `dir` (links followed), by name in code-unit order. A missing or unreadable `dir` is empty. */
function subfolders(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort(codeUnitOrder);
}

/** Every folder that might hold a module, in precedence order. Reads directory listings only. */
function locate(roots: Roots): Location[] {
  const found: Location[] = [];
  const add = (source: ModuleSource, parent: string, folderName: string, expectedName: string): void => {
    found.push({ source, expectedName, dir: path.join(parent, folderName) });
  };

  const repoLanguages = path.join(roots.repoRoot, REPO_LANGUAGES);
  for (const name of subfolders(repoLanguages)) {
    add('repo', repoLanguages, name, name);
  }

  const userLanguages = path.join(roots.userDir, 'languages');
  for (const name of subfolders(userLanguages)) {
    add('user', userLanguages, name, name);
  }

  for (const npmRoot of roots.npmRoots) {
    const modules = path.join(npmRoot, 'node_modules');
    for (const folder of subfolders(modules)) {
      if (folder.startsWith(NPM_UNSCOPED_PREFIX)) {
        add('npm', modules, folder, folder.slice(NPM_UNSCOPED_PREFIX.length));
      }
    }
    const scope = path.join(modules, NPM_SCOPE);
    for (const folder of subfolders(scope)) {
      if (folder.startsWith(NPM_SCOPED_PREFIX)) {
        add('npm', scope, folder, folder.slice(NPM_SCOPED_PREFIX.length));
      }
    }
  }

  if (roots.builtinDir !== null) {
    for (const name of subfolders(roots.builtinDir)) {
      add('builtin', roots.builtinDir, name, name);
    }
  }
  return found;
}

function canonical(dir: string): string | undefined {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return undefined;
  }
}

/** A diagnostic from reading a candidate, with the folder named in the message. */
function skipped(dir: string, d: Diagnostic): Diagnostic {
  return diagnostic(d.code, d.severity, `${dir}: ${d.message}`, dir);
}

interface Scan {
  readonly candidates: readonly Candidate[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Read and validate each location; `only` limits the scan to folders claiming that one name. */
function scan(roots: Roots, only?: string): Scan {
  const candidates: Candidate[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const location of locate(roots)) {
    if (only !== undefined && location.expectedName !== only) {
      continue;
    }
    const dir = canonical(location.dir);
    if (dir === undefined || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    const read = readManifest(dir);
    if (!read.ok) {
      diagnostics.push(...read.diagnostics.map((d) => skipped(dir, d)));
      continue;
    }
    candidates.push({ ...location, dir, manifest: read.manifest });
  }
  return { candidates, diagnostics };
}

function entryOf(group: readonly Candidate[]): ModuleEntry {
  const [active, ...rest] = group as [Candidate, ...Candidate[]];
  const { manifest } = active;
  return {
    name: active.expectedName,
    source: active.source,
    dir: active.dir,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    extensions: [...manifest.extensions],
    inactiveExtensions: [],
    tiers: [{ tier: 'grammar', active: true }],
    shadowed: rest.map((c) => ({ source: c.source, dir: c.dir })),
  };
}

/** Group candidates by module name; `candidates` is already in precedence order, so each group's first is active. */
function group(candidates: readonly Candidate[]): ModuleEntry[] {
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byName.get(candidate.expectedName);
    if (list === undefined) {
      byName.set(candidate.expectedName, [candidate]);
    } else {
      list.push(candidate);
    }
  }
  return [...byName.values()].map(entryOf).sort((a, b) => codeUnitOrder(a.name, b.name));
}

/** Every module visible from `roots`, one entry per name, sorted by name. */
export function resolveModules(roots: Roots): ResolveModulesResult {
  const { candidates, diagnostics } = scan(roots);
  return { modules: group(candidates), diagnostics };
}

/** The one module called `name`, or no entry. A name that is not a module id never matches. */
export function resolveModule(roots: Roots, name: string): ResolveModuleResult {
  if (!MODULE_ID.test(name)) {
    return { entry: undefined, diagnostics: [] };
  }
  const { candidates, diagnostics } = scan(roots, name);
  return { entry: group(candidates)[0], diagnostics };
}
