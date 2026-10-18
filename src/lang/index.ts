/**
 * The language-module seam: manifest and lock parsing, the confined module reader, and the
 * `lang test` runner (FND-03, FND-11, D-02). Other modules import from here and nowhere else.
 */
export { parseManifest } from './manifest.ts';
export type { Manifest, ParseManifestResult } from './manifest.ts';
export { PLATFORM_KEYS, expectedPlatformSha256, parseGrammarLock, platformKey } from './grammar-lock.ts';
export type { GrammarLock, GrammarLockResult, PlatformExpectation, PlatformKey } from './grammar-lock.ts';
export { MANIFEST_FILE, readManifest, readModuleFile, readModuleInputs } from './module-files.ts';
export type { ReadManifestResult, ReadModuleFileResult, ReadModuleInputsResult } from './module-files.ts';
export { MODULE_ID, MODULE_SOURCES, resolveModule, resolveModules } from './registry.ts';
export type {
  ModuleEntry,
  ModuleSource,
  ResolveModuleResult,
  ResolveModulesResult,
  ResolveOptions,
  Roots,
  ShadowedCopy,
  TierStatus,
} from './registry.ts';
export { GOLDEN_CONVENTION, compareGolden, goldenFileName, renderGolden, serializeGolden } from './golden.ts';
export type { Golden, GoldenCapture, GoldenDifference } from './golden.ts';
export { runLangTest } from './test-runner.ts';
export type { LangTestFixtureResult, LangTestOptions, LangTestReport } from './test-runner.ts';
