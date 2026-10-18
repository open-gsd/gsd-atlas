/**
 * TypeScript's `files` / `include` / `exclude` semantics without the compiler (TSM-07).
 *
 * The matching is the compiler's own algorithm written out again: each spec becomes a regular expression the way
 * `getSubPatternFromSpec` builds it (`*`, `?` and `**` never match a leading dot or a package folder unless the
 * spec names it; a spec ending in a name without a dot or wildcard means "everything under it"), directories are
 * walked from the config's base paths and pruned by the same patterns, only supported extensions count, and a
 * `.js` file hides behind an `a.ts` of the same name. The differential test keeps this equal to
 * `ts.parseJsonConfigFileContent`; if the compiler changes, that test is what fails.
 *
 * Paths are repo-relative POSIX strings here. Internally every path is rooted at a virtual `/` so the patterns
 * behave exactly as they do on absolute paths.
 */

/** Folders an include never descends into unless a spec names them (TypeScript's `commonPackageFolders`). */
export const DEFAULT_EXCLUDES: readonly string[] = ['node_modules', 'bower_components', 'jspm_packages'];

const IMPLICIT_EXCLUDE = `(?!(?:${DEFAULT_EXCLUDES.join('|')})(?:/|$))`;
const RESERVED = /[^\w\s/]/g;

type Usage = 'files' | 'directories' | 'exclude';

const FRAGMENTS: Readonly<Record<Usage, { readonly single: string; readonly double: string }>> = {
  files: { single: '[^/]*', double: `(?:/${IMPLICIT_EXCLUDE}[^/.][^/]*)*?` },
  directories: { single: '[^/]+', double: `(?:/${IMPLICIT_EXCLUDE}[^/.][^/]*)*?` },
  exclude: { single: '[^/]*', double: '(?:/.+?)?' },
};

// ---------------------------------------------------------------------------------------------
// Repo paths

/**
 * `rel` resolved against the repo-relative directory `baseDir` ('' is the root), with `.` and `..` reduced. A `..`
 * above the root is dropped, as the compiler drops it at a drive or filesystem root. A leading `/` in `rel` is
 * kept as the root. Backslashes are read as separators. The result has no leading or trailing slash ('' is the root).
 */
export function resolveRepoPath(baseDir: string, rel: string): string {
  const unified = rel.replace(/\\/g, '/');
  const joined = unified.startsWith('/') ? unified : `${baseDir}/${unified}`;
  const out: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** The directory part of a repo-relative path ('' for a top-level entry). */
export function dirOf(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
}

// ---------------------------------------------------------------------------------------------
// Spec validation (the compiler drops these with an error)

const INVALID_TRAILING_RECURSION = /(?:^|\/)\*\*\/?$/;

/** Why the compiler rejects `spec`, or undefined when it accepts it. `include` also rejects a trailing `**`. */
export function specProblem(spec: string, kind: 'include' | 'exclude'): 'trailing_recursion' | 'parent_after_recursion' | undefined {
  if (kind === 'include' && INVALID_TRAILING_RECURSION.test(spec)) return 'trailing_recursion';
  const wildcardIndex = spec.startsWith('**/') ? 0 : spec.indexOf('/**/');
  if (wildcardIndex !== -1) {
    const lastDotIndex = spec.endsWith('/..') ? spec.length : spec.lastIndexOf('/../');
    if (lastDotIndex > wildcardIndex) return 'parent_after_recursion';
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Extensions

const TS_GROUPS: readonly (readonly string[])[] = [['.ts', '.tsx', '.d.ts'], ['.cts', '.d.cts'], ['.mts', '.d.mts']];
const ALL_GROUPS: readonly (readonly string[])[] = [['.ts', '.tsx', '.d.ts', '.js', '.jsx'], ['.cts', '.d.cts', '.cjs'], ['.mts', '.d.mts', '.mjs']];
/** What the compiler strips to find a file's stem, in its order (the longest declaration forms first). */
const STEM_EXTENSIONS: readonly string[] = ['.d.ts', '.d.mts', '.d.cts', '.mjs', '.mts', '.cjs', '.cts', '.ts', '.js', '.tsx', '.jsx', '.json'];

/**
 * The extension groups a file may have to be a source file: TypeScript only, or with JavaScript when `allowJs`
 * (`.js`, `.jsx`, `.cjs`, `.mjs`). Within a group an earlier extension wins over a later one of the same stem.
 */
export function supportedExtensions(allowJs: boolean): readonly (readonly string[])[] {
  return allowJs ? ALL_GROUPS : TS_GROUPS;
}

/** True when `p` ends in a supported extension (`.d.ts`, `.d.cts` and `.d.mts` included). */
export function isSupportedExtension(p: string, allowJs: boolean): boolean {
  return supportedExtensions(allowJs).some((group) => group.some((ext) => p.endsWith(ext)));
}

function withExtension(p: string, ext: string): string {
  const old = STEM_EXTENSIONS.find((candidate) => p.endsWith(candidate));
  return old === undefined ? p : p.slice(0, p.length - old.length) + ext;
}

/**
 * True when another member of the same stem has a higher-priority extension in the file's group, so the compiler
 * leaves `p` out (`a.js` next to `a.ts`). `isMember` says whether a sibling path is in the file set. The compiler's
 * legacy exception is kept: a `.d.ts` does not hide a `.js` or `.jsx`.
 */
export function hasHigherPriorityExtension(p: string, allowJs: boolean, isMember: (sibling: string) => boolean): boolean {
  const group = supportedExtensions(allowJs).find((candidate) => candidate.some((ext) => p.endsWith(ext)));
  if (group === undefined) return false;
  for (const ext of group) {
    if (p.endsWith(ext)) return false;
    if (!isMember(withExtension(p, ext))) continue;
    if (ext === '.d.ts' && (p.endsWith('.js') || p.endsWith('.jsx'))) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Spec to regular expression

/** Path components of `spec` rooted at the virtual `/`: `['/', 'src', '*.cts']`. */
function components(spec: string): string[] {
  const out = ['/'];
  for (const segment of resolveRepoPath('', spec).split('/')) if (segment !== '') out.push(segment);
  return out;
}

const isImplicitGlob = (lastComponent: string): boolean => !/[.*?]/.test(lastComponent);

function subPattern(spec: string, usage: Usage): string | undefined {
  const parts = components(spec);
  const last = parts[parts.length - 1] ?? '/';
  if (usage !== 'exclude' && last === '**') return undefined;
  const { single, double } = FRAGMENTS[usage];
  const replaceWildcard = (match: string): string => (match === '*' ? single : match === '?' ? '[^/]' : `\\${match}`);

  parts[0] = ''; // the root without its separator
  if (isImplicitGlob(last)) parts.push('**', '*');

  let out = '';
  let written = false;
  let optional = 0;
  for (const part of parts) {
    if (part === '**') {
      out += double;
    } else {
      let component = part;
      if (usage === 'directories') {
        out += '(';
        optional += 1;
      }
      if (written) out += '/';
      if (usage !== 'exclude') {
        let pattern = '';
        // `*` and `?` first in a component never match a name that starts with a dot.
        if (component.startsWith('*')) {
          pattern += `([^./]${single})?`;
          component = component.slice(1);
        } else if (component.startsWith('?')) {
          pattern += '[^./]';
          component = component.slice(1);
        }
        pattern += component.replace(RESERVED, replaceWildcard);
        // A wildcard component never enters a package folder; a literal one may (it names the folder).
        if (pattern !== component) out += IMPLICIT_EXCLUDE;
        out += pattern;
      } else {
        out += component.replace(RESERVED, replaceWildcard);
      }
    }
    written = true;
  }
  return out + ')?'.repeat(optional);
}

function combined(specs: readonly string[], usage: Usage): string | undefined {
  const patterns = specs.map((spec) => subPattern(spec, usage)).filter((p): p is string => p !== undefined);
  if (patterns.length === 0) return undefined;
  return `^(${patterns.map((p) => `(${p})`).join('|')})${usage === 'exclude' ? '($|/)' : '$'}`;
}

/**
 * One `include` spec as the compiler compiles it: a test for the repo-relative file paths it selects by wildcard
 * (before the extension, exclude and priority rules). `spec` is read relative to the repo-relative `baseDir`.
 * Undefined for a spec that selects nothing by itself (`src/**` and `**` alone, which the compiler rejects).
 */
export function compileInclude(spec: string, baseDir: string, caseSensitive = true): { test(p: string): boolean } | undefined {
  const pattern = subPattern(resolveRepoPath(baseDir, spec), 'files');
  if (pattern === undefined) return undefined;
  const regex = new RegExp(`^${pattern}$`, caseSensitive ? '' : 'i');
  return { test: (p) => regex.test(`/${p}`) };
}

// ---------------------------------------------------------------------------------------------
// The file set of one config

export interface FileSetInput {
  /** Repo-relative directory of the config ('' for the root). */
  readonly configDir: string;
  /** Resolved `files`, repo-relative. */
  readonly files: readonly string[];
  /** Resolved, valid `include` specs, repo-relative. */
  readonly include: readonly string[];
  /** Resolved, valid `exclude` specs, repo-relative. */
  readonly exclude: readonly string[];
  readonly allowJs: boolean;
  readonly caseSensitive: boolean;
}

export interface FileSetMatcher {
  /** True when `p` is named in `files`: a literal file is always in, whatever its extension or `exclude`. */
  isLiteral(p: string): boolean;
  /** True when `p` passes the include and exclude rules by wildcard, before the extension-priority rule is applied. */
  isWildcardCandidate(p: string): boolean;
}

function includeBasePath(spec: string): string {
  const absolute = `/${resolveRepoPath('', spec)}`;
  const wildcardOffset = absolute.search(/[*?]/);
  if (wildcardOffset < 0) {
    const name = absolute.slice(absolute.lastIndexOf('/') + 1);
    return name.includes('.') ? absolute.slice(0, absolute.lastIndexOf('/')) || '/' : absolute;
  }
  return absolute.slice(0, absolute.lastIndexOf('/', wildcardOffset)) || '/';
}

/** The directories the compiler starts walking from: the config's own, then include bases outside every earlier one. */
function basePaths(configDir: string, include: readonly string[], fold: (s: string) => string): string[] {
  const bases = [`/${configDir}`.replace(/\/$/, '') || '/'];
  const contains = (parent: string, child: string): boolean => parent === '/' || child === parent || child.startsWith(`${parent}/`);
  const candidates = include.map(includeBasePath).sort((a, b) => (fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0));
  for (const candidate of candidates) {
    if (bases.every((base) => !contains(fold(base), fold(candidate)))) bases.push(candidate);
  }
  return bases;
}

/** Builds the matcher for one config. Compile once, ask many times. */
export function createFileSetMatcher(input: FileSetInput): FileSetMatcher {
  const flags = input.caseSensitive ? '' : 'i';
  const fold = (s: string): string => (input.caseSensitive ? s : s.toLowerCase());
  const literal = new Set(input.files.map((f) => fold(resolveRepoPath('', f))));

  const filePatterns = input.include
    .map((spec) => subPattern(spec, 'files'))
    .filter((p): p is string => p !== undefined)
    .map((p) => new RegExp(`^${p}$`, flags));
  const directoryPattern = combined(input.include, 'directories');
  const excludePattern = combined(input.exclude, 'exclude');
  const directoryRegex = directoryPattern === undefined ? undefined : new RegExp(directoryPattern, flags);
  const excludeRegex = excludePattern === undefined ? undefined : new RegExp(excludePattern, flags);
  const bases = new Set(basePaths(input.configDir, input.include, fold).map(fold));

  const visitable = new Map<string, boolean>();
  const canVisit = (dir: string): boolean => {
    const known = visitable.get(dir);
    if (known !== undefined) return known;
    let result: boolean;
    if (bases.has(fold(dir))) result = true;
    else if (dir === '/' || dir === '') result = false;
    else {
      result =
        (directoryRegex === undefined || directoryRegex.test(dir)) &&
        (excludeRegex === undefined || !excludeRegex.test(dir)) &&
        canVisit(dir.slice(0, dir.lastIndexOf('/')) || '/');
    }
    visitable.set(dir, result);
    return result;
  };

  return {
    isLiteral: (p) => literal.has(fold(resolveRepoPath('', p))),
    isWildcardCandidate(p) {
      if (filePatterns.length === 0 || !isSupportedExtension(p, input.allowJs)) return false;
      const absolute = `/${p}`;
      if (excludeRegex !== undefined && excludeRegex.test(absolute)) return false;
      if (!filePatterns.some((re) => re.test(absolute))) return false;
      return canVisit(absolute.slice(0, absolute.lastIndexOf('/')) || '/');
    },
  };
}
