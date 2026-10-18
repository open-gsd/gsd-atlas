/**
 * The ProjectModel seam (TSM-07, ADR 5 amendments of 2026-10-15 and 2026-10-18): a compiler-free reader of a
 * project's own configuration. Production surface only; it never imports the TypeScript package.
 */
export { PROJECT_MODEL_IDS, createTypeScriptProjectModel } from './typescript.ts';
export type { TypeScriptProjectModelOptions } from './typescript.ts';
export { buildContext } from './context.ts';
export { BUNDLED_VERSION, compilerFallbackDiagnostic, detectTypeScriptInstall, selectCompiler } from './install.ts';
export { PROJECT_MODEL_CODES } from './types.ts';
export type {
  CompilerChoice,
  ConfigInfo,
  DescribeInput,
  ProjectDescription,
  ProjectFs,
  ProjectModel,
  TypeScriptInstall,
  TypeScriptInstallCase,
} from './types.ts';
