import type { Diagnostic, ResolutionContext } from '../facts/index.ts';
import type { ReadTextResult } from '../source-tree/index.ts';

/** Diagnostic codes the ProjectModel reports. Messages never carry repository text, only fixed words and the subject path. */
export const PROJECT_MODEL_CODES = {
  /** A config could not be read or is not valid JSON with comments; it is skipped. */
  tsconfigInvalid: 'tsconfig_invalid',
  /** An `extends` target is above the repository root or reached through a link the reader refuses; it is ignored. */
  extendsOutsideRepo: 'extends_outside_repo',
  /** An `extends` target does not exist (or is not a file); the rest of the config still loads. */
  extendsUnresolved: 'extends_unresolved',
  /** A chain of `extends` leads back to a config already being read; the repeated link is ignored. */
  extendsCycle: 'extends_cycle',
  /** A chain of `extends` is deeper than the limit; the deeper links are ignored. */
  extendsTooDeep: 'extends_too_deep',
  /** More configs than the cap were found; only the first ones in lexical order are described. */
  tooManyConfigs: 'too_many_configs',
  /** A `files`, `include` or `exclude` entry the compiler rejects or that points outside the repository; it is dropped. */
  specInvalid: 'tsconfig_spec_invalid',
  /** A `references` entry points outside the repository; it is dropped. */
  referenceOutsideRepo: 'reference_outside_repo',
  /** The bundled compiler is used instead of the project's (D-12 to D-14). */
  compilerFallback: 'compiler_fallback',
  /** The project's `node_modules/typescript` is reached through a link that leaves the repository. */
  compilerOutsideRepo: 'compiler_outside_repo',
  /** The project's `node_modules/typescript/package.json` is not usable. */
  typescriptPackageInvalid: 'typescript_package_invalid',
} as const;

/**
 * The only way the ProjectModel touches a repository (TSM-07): paths are repo-relative POSIX strings, and the
 * implementation behind it confines every read to the repository root. The model never gets a handle that could
 * read elsewhere, so a hostile `extends` cannot reach a file outside it (T-03-181).
 */
export interface ProjectFs {
  /** Same contract as `SourceTree.readText`: bad input is an answer (`escape`, `missing`, ...), never a throw. */
  readText(path: string): Promise<ReadTextResult>;
  /** The subset of `paths` that exist as readable files. One call may answer many paths. */
  exists(paths: readonly string[]): Promise<ReadonlySet<string>>;
}

/** What a TypeScript project config says about one tsconfig or jsconfig, after `extends` is applied. */
export interface ConfigInfo {
  /** Repo-relative path of the config. */
  readonly path: string;
  /** sha256 of the config's own text (BOM stripped, CRLF read as LF). */
  readonly hash: string;
  /**
   * This config first, then every config it extends, each once, in the order they were read (an `extends` array is
   * read left to right and each entry's own chain follows it).
   */
  readonly chain: readonly string[];
  /** Effective `files`, resolved against the config that wrote them. Literal: never filtered by extension or `exclude`. */
  readonly files: readonly string[];
  /** Effective valid `include` specs (default `**\/*` when neither `files` nor `include` is set), repo-relative. */
  readonly include: readonly string[];
  /** Effective valid `exclude` specs (or the output directories when `exclude` is absent), repo-relative. */
  readonly exclude: readonly string[];
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly declarationDir?: string;
  readonly allowJs: boolean;
  readonly jsx?: string;
  /** Repo-relative paths of the referenced project configs (this config's own `references`; TypeScript does not inherit them). */
  readonly references: readonly string[];
}

/** Where a project's `typescript` package stands (TSM-02), decided from its package.json alone. */
export type TypeScriptInstallCase =
  | 'none'
  | 'project-6'
  | 'project-7-unstable'
  | 'project-7-sync'
  | 'project-7-unknown-layout'
  | 'project-other';

/** What reading `node_modules/typescript/package.json` showed. Nothing was loaded or run. */
export interface TypeScriptInstall {
  readonly case: TypeScriptInstallCase;
  /** The package's `version`, only when it is a plain semantic version (otherwise the install is `none`). */
  readonly version?: string;
  /** Repo-relative directory of the package (`packages/a/node_modules/typescript`). */
  readonly dir?: string;
  /** The subpath keys of `exports`, sorted. Empty when the package has no `exports` object. */
  readonly exportKeys: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Which compiler a precise resolver should load for a project (D-12 to D-14). */
export interface CompilerChoice {
  readonly source: 'project' | 'bundled';
  readonly version: string;
  /** The project's package directory, only when `source` is `project`. */
  readonly dir?: string;
  /** Why the bundled compiler was chosen; absent for a project compiler. One of a fixed set of strings. */
  readonly reason?: string;
  /** The install case this choice came from. */
  readonly case: TypeScriptInstallCase;
}

export interface ProjectDescription {
  /** What the cached edges are keyed on (G4): the model and compiler identity plus the hashes of every config read. */
  readonly context: ResolutionContext;
  /** One per config found, in lexical order of path. Configs that could not be read are absent (see `diagnostics`). */
  readonly configs: readonly ConfigInfo[];
  /**
   * True when `path` belongs to the config's file set under TypeScript's own rules. Sibling files (the `a.ts` that
   * hides `a.js`) are looked up in the overlay paths the description was built from. A config that is not in
   * `configs` matches nothing.
   */
  matches(configPath: string, path: string): boolean;
  /** The one config that owns `path`, or undefined when no config covers it. */
  ownerOf(path: string): string | undefined;
  readonly compiler: CompilerChoice;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DescribeInput {
  /** Repo-relative POSIX paths of the source files in the overlay. */
  readonly overlayPaths: readonly string[];
  /** The reader to use. Falls back to the one the model was created with. */
  readonly fs?: ProjectFs;
  /**
   * Repo-relative paths of configs to describe in addition to the ones found by directory and by `references`
   * (a `tsconfig.build.json` that nothing references, for instance). A path that does not exist is skipped.
   */
  readonly extraConfigs?: readonly string[];
}

/** A built-in, compiler-free ProjectModel (ADR 5, seam amendment of 2026-10-15). */
export interface ProjectModel {
  readonly id: string;
  describe(input: DescribeInput): Promise<ProjectDescription>;
}
