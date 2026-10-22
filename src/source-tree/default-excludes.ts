/**
 * The built-in index exclusions (quick task 261021-re7, D-01): the tooling and build-output paths no index should hold,
 * written once. Source Tree hands them to git as constant `--exclude <pattern>` values (never anything a repository or
 * a watcher supplied), so git itself decides every verdict; there is no matcher of ours in production code. The fake
 * Source Tree evaluates the same list with a small rule set (`fake-rules.ts`) and a test proves each pattern means the
 * same to both. Not named `DEFAULT_EXCLUDES`: `src/project-model/globs.ts` already exports that name for TypeScript's
 * own three package folders.
 *
 * `appliesToTracked` is set from the committed measurement
 * (`.planning/quick/261021-re7-indexer-ignore-rules-built-in-tooling-an/261021-re7-MEASUREMENTS.md`, "Per-entry
 * decision") and never by guess: true only when the pinned gsd-core and every measured corpus lose zero tracked
 * source-extension paths to the entry, false for every other entry and for every ecosystem with no measured corpus. A
 * false entry still prunes untracked files that git does not ignore; a tracked file under it stays indexed. The trust-
 * boundaries ADR and ADR 5 amendments of 2026-10-21 describe the feature, the reference page
 * `docs/reference/index-exclusions.md` lists every entry.
 *
 * Patterns use only forms git and the fake both read: `name/` (a directory at any depth), `a/b/` (anchored at the
 * root), `*.ext/` (a directory glob) and `*.ext` (a file glob). A negation can never re-include one of them: they are
 * command-line excludes, which git ranks above every ignore file.
 */

/** The ecosystem an entry belongs to, for the reference page and for the measurement rule. */
export type IndexDefaultEcosystem = 'javascript' | 'python' | 'jvm-rust' | 'apple' | 'bundle-output';

export interface IndexDefaultExclude {
  /** A git exclude pattern in one of the forms above. */
  readonly pattern: string;
  readonly ecosystem: IndexDefaultEcosystem;
  /** True when tracked files under the pattern leave the index too (measured), false when only untracked files do. */
  readonly appliesToTracked: boolean;
  /** One sentence saying why the path is tooling or build output. */
  readonly rationale: string;
}

export const INDEX_DEFAULT_EXCLUDES: readonly IndexDefaultExclude[] = [
  { pattern: 'node_modules/', ecosystem: 'javascript', appliesToTracked: false, rationale: 'Installed third-party packages written by a package manager, never first-party source.' },
  { pattern: 'bower_components/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Installed packages of the Bower package manager.' },
  { pattern: 'jspm_packages/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Installed packages of the jspm package manager.' },
  { pattern: '.pnpm-store/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'The content-addressed package store pnpm may create inside a project.' },
  { pattern: '.yarn/cache/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'The zipped package cache Yarn keeps at the project root.' },
  { pattern: '.npm/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'The package download cache npm may create inside a project.' },
  { pattern: 'dist/', ecosystem: 'javascript', appliesToTracked: false, rationale: 'Conventional output folder of a bundler or compiler.' },
  { pattern: 'build/', ecosystem: 'javascript', appliesToTracked: false, rationale: 'Conventional output folder of a build step.' },
  { pattern: 'out/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Conventional output folder of a compiler or static export.' },
  { pattern: '.next/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Build output and cache of Next.js.' },
  { pattern: '.nuxt/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Build output and cache of Nuxt.' },
  { pattern: '.svelte-kit/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Generated build output of SvelteKit.' },
  { pattern: '.turbo/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Task cache of Turborepo.' },
  { pattern: '.parcel-cache/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Build cache of the Parcel bundler.' },
  { pattern: '.cache/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Generic tool cache folder that build tools create next to the sources.' },
  { pattern: 'coverage/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Test coverage reports written by the test runner.' },
  { pattern: '.nyc_output/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Raw coverage data written by nyc.' },
  { pattern: '.angular/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Build cache of the Angular CLI.' },
  { pattern: '.vite/', ecosystem: 'javascript', appliesToTracked: true, rationale: 'Dependency pre-bundle cache of Vite.' },
  { pattern: '__pycache__/', ecosystem: 'python', appliesToTracked: false, rationale: 'Byte-code cache written by the Python interpreter.' },
  { pattern: '.venv/', ecosystem: 'python', appliesToTracked: false, rationale: 'A virtual environment holding installed Python packages.' },
  { pattern: '.tox/', ecosystem: 'python', appliesToTracked: false, rationale: 'Virtual environments and build output of tox.' },
  { pattern: '.mypy_cache/', ecosystem: 'python', appliesToTracked: false, rationale: 'Type-checker cache of mypy.' },
  { pattern: '.pytest_cache/', ecosystem: 'python', appliesToTracked: false, rationale: 'Run cache of pytest.' },
  { pattern: '*.egg-info/', ecosystem: 'python', appliesToTracked: false, rationale: 'Package metadata folder generated by setuptools.' },
  { pattern: 'target/', ecosystem: 'jvm-rust', appliesToTracked: false, rationale: 'Build output folder of Cargo and Maven.' },
  { pattern: '.gradle/', ecosystem: 'jvm-rust', appliesToTracked: false, rationale: 'Build cache of Gradle.' },
  { pattern: '.mvn/', ecosystem: 'jvm-rust', appliesToTracked: false, rationale: 'Maven wrapper and local state folder.' },
  { pattern: 'Pods/', ecosystem: 'apple', appliesToTracked: false, rationale: 'Installed CocoaPods dependencies.' },
  { pattern: 'DerivedData/', ecosystem: 'apple', appliesToTracked: false, rationale: 'Build products and indexes written by Xcode.' },
  { pattern: '.build/', ecosystem: 'apple', appliesToTracked: false, rationale: 'Build output of the Swift package manager.' },
  { pattern: '.swiftpm/', ecosystem: 'apple', appliesToTracked: false, rationale: 'Local state of the Swift package manager.' },
  { pattern: '*.min.js', ecosystem: 'bundle-output', appliesToTracked: true, rationale: 'A minified JavaScript bundle, generated from other files.' },
  { pattern: '*.min.css', ecosystem: 'bundle-output', appliesToTracked: true, rationale: 'A minified style sheet, generated from other files.' },
  { pattern: '*.bundle.js', ecosystem: 'bundle-output', appliesToTracked: true, rationale: 'A bundled JavaScript file, generated from other files.' },
  { pattern: '*.js.map', ecosystem: 'bundle-output', appliesToTracked: true, rationale: 'A source map generated next to a JavaScript output file.' },
  { pattern: '*.css.map', ecosystem: 'bundle-output', appliesToTracked: true, rationale: 'A source map generated next to a style sheet output file.' },
];


/** The built-in patterns of a scope, in list order: every entry (`all`) or the ones that also remove tracked files (`tracked`). */
export function defaultPatterns(scope: 'all' | 'tracked'): readonly string[] {
  return INDEX_DEFAULT_EXCLUDES.filter((entry) => scope === 'all' || entry.appliesToTracked).map((entry) => entry.pattern);
}

/** The name of the repo-level ignore file (git syntax, evaluated by git), the second source of exclusions. */
export const ATLASIGNORE_FILE = '.atlasignore';

/**
 * The most bytes of `.atlasignore` text Source Tree will let git read, summed over every such file of the worktree. It is
 * the approved cap of every repository-supplied file (`REPO_CONFIG_MAX_BYTES` in `src/tenant/repo-config.ts`); a test
 * keeps the two equal, so this change invents no new number.
 */
export const ATLASIGNORE_MAX_BYTES = 64 * 1024;
