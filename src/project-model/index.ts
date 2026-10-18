/**
 * The ProjectModel seam (TSM-07, ADR 5 amendments of 2026-10-15 and 2026-10-18): a compiler-free reader of a
 * project's own configuration. Production surface only; it never imports the TypeScript package.
 */
import { createTypeScriptProjectModel } from './typescript.ts';
import type { TypeScriptProjectModelOptions } from './typescript.ts';
import type { ProjectFs, ProjectModel } from './types.ts';

export { PROJECT_MODEL_IDS, createTypeScriptProjectModel } from './typescript.ts';
export type { TypeScriptProjectModelOptions } from './typescript.ts';
export { buildEmitMap } from './emit.ts';
export { buildContext } from './context.ts';
export { normalizedHash } from './jsonc.ts';
export { BUNDLED_VERSION, compilerFallbackDiagnostic, detectTypeScriptInstall, selectCompiler } from './install.ts';
export { PROJECT_MODEL_CODES } from './types.ts';
export type {
  CompilerChoice,
  ConfigInfo,
  DescribeInput,
  EmitKind,
  EmitMap,
  EmitOutput,
  ProjectDescription,
  ProjectFs,
  ProjectModel,
  TypeScriptInstall,
  TypeScriptInstallCase,
} from './types.ts';

/**
 * The built-in ProjectModel a manifest names through `project.model` (`typescript` today), or undefined for an id
 * nobody knows (ADR 5: the id is data, never a path or a command).
 */
export function createProjectModel(id: string, fs?: ProjectFs, options?: TypeScriptProjectModelOptions): ProjectModel | undefined {
  return id === 'typescript' ? createTypeScriptProjectModel(fs, options) : undefined;
}
