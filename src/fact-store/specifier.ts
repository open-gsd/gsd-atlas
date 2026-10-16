import { posix } from 'node:path';

/**
 * The language-neutral import specifier rule (D-06). One pure function over a set of overlay paths: it never
 * touches the file system, so a hostile specifier can only ever name a path the overlay already holds (T-02-33).
 *
 * Phase 3's ProjectModel replaces this rule for path aliases and packages; until then only relative specifiers
 * resolve, and a package name or an alias never matches.
 */

/** A 1 to 4 character alphanumeric extension: what makes the tail of a specifier look like `.cjs`, not `.b`. */
const EXTENSION = /^\.[A-Za-z0-9]{1,4}$/;

interface OverlayIndex {
  readonly size: number;
  /** Overlay paths grouped by their path with the last extension removed. */
  readonly byStem: ReadonlyMap<string, readonly string[]>;
  /** Index files (`index.ts`, `index.js`, ...) grouped by their directory. */
  readonly indexFiles: ReadonlyMap<string, readonly string[]>;
}

const indexes = new WeakMap<ReadonlySet<string>, OverlayIndex>();

/** A path with its last extension removed: `src/a.ts` and `src/a.js` both become `src/a`. */
export function stem(filePath: string): string {
  const ext = posix.extname(filePath);
  return ext === '' ? filePath : filePath.slice(0, filePath.length - ext.length);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * The lookup tables of one overlay path set, built once per set. The set is treated as immutable (the store
 * builds a fresh one for every read); a changed size rebuilds the tables as a cheap safety net.
 */
function indexOf(paths: ReadonlySet<string>): OverlayIndex {
  const known = indexes.get(paths);
  if (known !== undefined && known.size === paths.size) return known;
  const byStem = new Map<string, string[]>();
  const indexFiles = new Map<string, string[]>();
  for (const overlayPath of paths) {
    const bare = stem(overlayPath);
    push(byStem, bare, overlayPath);
    if (posix.basename(bare) === 'index') push(indexFiles, posix.dirname(overlayPath), overlayPath);
  }
  const built: OverlayIndex = { size: paths.size, byStem, indexFiles };
  indexes.set(paths, built);
  return built;
}

/** A specifier is relative when it names a file next to or above the importing file. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** A specifier written as a directory (`./util/`, `.`, `..`) can only name that directory's index file. */
function namesDirectory(specifier: string): boolean {
  return (
    specifier.endsWith('/') ||
    specifier === '.' ||
    specifier === '..' ||
    specifier.endsWith('/.') ||
    specifier.endsWith('/..')
  );
}

/**
 * The overlay paths a relative `specifier`, written in `importerPath`, can name. The specifier is resolved
 * against the importing file's directory with POSIX normalisation and matched four ways: by exact path, by
 * extension-stripped overlay path (`./b` names `src/b.ts`), by extension-stripped specifier when its tail looks
 * like an extension (`./foo.cjs` names `foo.cts` and `foo.cjs`), and by directory index file (`./b` names
 * `src/b/index.ts`). The union is returned in code-unit order: more than one entry is an ambiguity the caller
 * must report, never resolve by guessing.
 *
 * Non-relative specifiers (package names, aliases, absolute paths, `node:` built-ins) and specifiers that climb
 * above the root return an empty array.
 */
export function resolveSpecifier(
  importerPath: string,
  specifier: string,
  overlayPaths: ReadonlySet<string>,
): readonly string[] {
  if (!isRelativeSpecifier(specifier)) return [];
  const joined = posix.join(posix.dirname(importerPath), specifier);
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return [];
  let base = joined;
  while (base.length > 1 && base.endsWith('/')) base = base.slice(0, -1);

  const index = indexOf(overlayPaths);
  const found = new Set<string>();
  if (!namesDirectory(specifier)) {
    if (overlayPaths.has(base)) found.add(base);
    for (const match of index.byStem.get(base) ?? []) found.add(match);
    if (EXTENSION.test(posix.extname(base))) {
      for (const match of index.byStem.get(stem(base)) ?? []) found.add(match);
    }
  }
  for (const match of index.indexFiles.get(base) ?? []) found.add(match);
  return [...found].sort();
}
