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
    const problem = healthProblem(dir, location, read.manifest);
    if (problem !== undefined) {
      diagnostics.push(problem);
      continue;
    }
    candidates.push({ ...location, dir, manifest: read.manifest });
  }
  return { candidates, diagnostics };
}

/**
 * A readable manifest can still make a folder unusable: its name must be the name the folder claims
 * by where it sits, and it must offer the grammar tier (the one tier every module has).
 */
function healthProblem(dir: string, location: Location, manifest: Manifest): Diagnostic | undefined {
  if (manifest.name !== location.expectedName) {
    return diagnostic(
      'name_mismatch',
      'warning',
      `${dir}: the folder is named ${JSON.stringify(location.expectedName)} but its manifest says ${JSON.stringify(manifest.name)}; the folder was skipped`,
      dir,
    );
  }
  if (!manifest.tiers.includes('grammar')) {
    return diagnostic(
      'grammar_tier_missing',
      'warning',
      `${dir}: the manifest does not list the grammar tier, which every module needs; the folder was skipped`,
      dir,
    );
  }
  return undefined;
}

/**
 * What each declared tier does right now, from manifest data alone. Nothing a manifest names is
 * started, resolved or imported: `precise.command` and `precise.adapter` are only ever read as text,
 * so a precise tier is inactive until user-level config approves it through the CommandRunner (T-01-36).
 */
function tiersOf(manifest: Manifest, approved: boolean, options: ResolveOptions = {}): TierStatus[] {
  const tiers: TierStatus[] = [];
  // Declaring a precise command or adapter asks for the precise tier even if `tiers` forgot to list it.
  for (const tier of ['grammar', 'precise', 'platform'] as const) {
    if (!manifest.tiers.includes(tier) && !(tier === 'precise' && manifest.precise !== undefined)) {
      continue;
    }
    if (tier === 'grammar') {
      tiers.push({ tier, active: true });
    } else if (tier === 'precise') {
      if (manifest.precise !== undefined && 'adapter' in manifest.precise && options.knownAdapters !== undefined) {
        // The composition root told the registry which built-in adapters exist (plan 03-23). The id is only ever compared
        // to that list; nothing it names is looked up, loaded or started here.
        const id = manifest.precise.adapter;
        if (!options.knownAdapters.includes(id)) tiers.push({ tier, active: false, reason: 'unknown precise adapter' });
        else if (options.disabledAdapters?.includes(id) === true) tiers.push({ tier, active: false, reason: 'provider_disabled' });
        else tiers.push({ tier, active: true });
        continue;
      }
      const reason =
        manifest.precise === undefined
          ? 'precise_not_declared'
          : 'command' in manifest.precise
            ? approved
              ? 'command_approved'
              : 'command_not_approved'
            : 'adapter_not_available';
      tiers.push({ tier, active: false, reason });
    } else {
      tiers.push({ tier, active: false, reason: 'no_sdk_provider' });
    }
  }
  return tiers;
}

/** One info diagnostic when the manifest declares a precise command or adapter that is therefore not run. */
function preciseNotes(entry: Pick<ModuleEntry, 'name' | 'dir'>, manifest: Manifest, approved: boolean, options: ResolveOptions = {}): Diagnostic[] {
  if (manifest.precise === undefined) {
    return [];
  }
  const isCommand = 'command' in manifest.precise;
  // A built-in adapter the composition root knows is not "declared but not run": the tier status says what it does.
  if (!isCommand && options.knownAdapters?.includes((manifest.precise as { readonly adapter: string }).adapter) === true) {
    return [];
  }
  if (approved) {
    // Approved by the person, for exactly this command. Listing a module still runs nothing.
    return [diagnostic('precise_command_approved', 'info', `${entry.name}: precise.command is approved by user-level config for this repository`, entry.dir)];
  }
  // Fixed text. The manifest's own words (the argv) are never copied here: this note travels in `lang_list` answers an
  // agent reads. Only the module name is used, and a name is limited to lower-case letters, digits and hyphens.
  const how = isCommand ? ` (review and approve it in a terminal with: gsd-atlas allow --module ${entry.name})` : '';
  return [
    diagnostic(
      'precise_command_inactive',
      'info',
      `${entry.name}: ${isCommand ? 'precise.command' : 'precise.adapter'} is declared but not run; the precise tier stays inactive until user-level config approves it${how}`,
      entry.dir,
    ),
  ];
}

/**
 * How a caller that knows the user's approvals can tell the registry about them. The registry reads no user configuration
 * and starts nothing, so it takes the answer as a function; without one every `precise.command` still needs approval.
 */
export interface ResolveOptions {
  /** True when the person approved exactly this command (an executable and its arguments) for the repository being listed. */
  readonly approved?: (command: readonly string[]) => boolean;
  /**
   * The built-in precise adapter ids the composition root knows (plan 03-23). A module's `precise.adapter` makes its precise
   * tier active only when its id is listed; a listed id the user turned off (`disabledAdapters`) is inactive with the
   * reason `provider_disabled`, and an unlisted one is inactive with the reason `unknown precise adapter`. Without the
   * option no adapter is known, as before.
   */
  readonly knownAdapters?: readonly string[];
  /** The known adapter ids the user turned off in user-level configuration (`providers.disabled`). */
  readonly disabledAdapters?: readonly string[];
}

interface Built {
  readonly entry: ModuleEntry;
  readonly manifest: Manifest;
  /** True when the manifest's `precise.command` is approved. Never true for an adapter or no precise declaration. */
  readonly approved: boolean;
}

function builtOf(options: ResolveOptions): (group: readonly Candidate[]) => Built {
  return (candidates) => buildOne(candidates, options);
}

function buildOne(group: readonly Candidate[], options: ResolveOptions): Built {
  const [active, ...rest] = group as [Candidate, ...Candidate[]];
  const { manifest } = active;
  const approved = manifest.precise !== undefined && 'command' in manifest.precise && options.approved?.(manifest.precise.command) === true;
  return {
    manifest,
    approved,
    entry: {
      name: active.expectedName,
      source: active.source,
      dir: active.dir,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      extensions: [...manifest.extensions],
      inactiveExtensions: [],
      tiers: tiersOf(manifest, approved, options),
      shadowed: rest.map((c) => ({ source: c.source, dir: c.dir })),
    },
  };
}

/** Group candidates by module name; `candidates` is already in precedence order, so each group's first is active. */
function group(candidates: readonly Candidate[], options: ResolveOptions): Built[] {
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byName.get(candidate.expectedName);
    if (list === undefined) {
      byName.set(candidate.expectedName, [candidate]);
    } else {
      list.push(candidate);
    }
  }
  return [...byName.values()].map(builtOf(options)).sort((a, b) => codeUnitOrder(a.entry.name, b.entry.name));
}

/**
 * Two different modules claiming one extension: the higher-precedence module (source rank, then name)
 * keeps it; the other module's claim is inactive and reported as an error, unless the higher one
 * declares `replace`, in which case the lower claim is dropped with an info note.
 */
function settleExtensions(built: readonly Built[]): { readonly modules: ModuleEntry[]; readonly diagnostics: Diagnostic[] } {
  const rank = (b: Built): number => MODULE_SOURCES.indexOf(b.entry.source);
  const byPrecedence = [...built].sort((a, b) => rank(a) - rank(b) || codeUnitOrder(a.entry.name, b.entry.name));
  const owner = new Map<string, Built>();
  const inactive = new Map<string, string[]>();
  const diagnostics: Diagnostic[] = [];
  for (const mine of byPrecedence) {
    for (const extension of mine.entry.extensions) {
      const key = extension.toLowerCase();
      const theirs = owner.get(key);
      if (theirs === undefined) {
        owner.set(key, mine);
        continue;
      }
      const list = inactive.get(mine.entry.name) ?? [];
      list.push(extension);
      inactive.set(mine.entry.name, list);
      const names = `${theirs.entry.name} (${theirs.entry.source}, ${theirs.entry.dir}) and ${mine.entry.name} (${mine.entry.source}, ${mine.entry.dir})`;
      diagnostics.push(
        theirs.manifest.replace === true
          ? diagnostic('extension_replaced', 'info', `${extension} is claimed by ${names}; ${theirs.entry.name} declares replace, so ${mine.entry.name} does not serve it`, mine.entry.dir)
          : diagnostic('extension_collision', 'error', `${extension} is claimed by both ${names}; ${mine.entry.name} does not serve it`, mine.entry.dir),
      );
    }
  }
  const modules = built.map((b) => ({ ...b.entry, inactiveExtensions: inactive.get(b.entry.name) ?? [] }));
  return { modules, diagnostics };
}

/** Every module visible from `roots`, one entry per name, sorted by name. */
export function resolveModules(roots: Roots, options: ResolveOptions = {}): ResolveModulesResult {
  const scanned = scan(roots);
  const built = group(scanned.candidates, options);
  const settled = settleExtensions(built);
  const notes = built.flatMap((b) => preciseNotes(b.entry, b.manifest, b.approved, options));
  return { modules: settled.modules, diagnostics: [...scanned.diagnostics, ...settled.diagnostics, ...notes] };
}

/**
 * The one module called `name`, or no entry. A name that is not a module id never matches. Other
 * modules are not scanned, so their extension claims are not weighed against this one.
 */
export function resolveModule(roots: Roots, name: string, options: ResolveOptions = {}): ResolveModuleResult {
  if (!MODULE_ID.test(name)) {
    return { entry: undefined, diagnostics: [] };
  }
  const scanned = scan(roots, name);
  const [only] = group(scanned.candidates, options);
  const notes = only === undefined ? [] : preciseNotes(only.entry, only.manifest, only.approved, options);
  return { entry: only?.entry, diagnostics: [...scanned.diagnostics, ...notes] };
}
