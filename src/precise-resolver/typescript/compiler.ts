/**
 * Which compiler the worker loads (plan 03-23, D-12, D-13, TSM-02).
 *
 * The host never loads a compiler. It only decides which directory the worker should load, from the project facts the
 * ProjectModel derived by reading `package.json` as data, and sends that directory in the worker's first message. The
 * project's own TypeScript is used only when it is 6.x; with none, or with 7.x or another major, the bundled 6.0.3 is
 * used and the answer says so (`compiler_fallback`, with a diagnostic whose text is fixed here and carries no
 * repository text).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CompilerFacts } from '../../facts/index.ts';

/** The version of the compiler this package ships (D-13); the same constant the ProjectModel reports. */
export const BUNDLED_TYPESCRIPT_VERSION = '6.0.3';

/**
 * The directory of the installed `typescript` package of this package. Only the location is resolved: the package is
 * not loaded here, so the host process never executes compiler code.
 */
export function bundledCompilerDir(moduleUrl: string = import.meta.url): string {
  return path.dirname(createRequire(moduleUrl).resolve('typescript/package.json'));
}

/** What the worker's `init` message carries about the compiler. */
export interface CompilerRequest {
  /** The project's compiler package directory (absolute), or null when the bundled compiler is used. */
  readonly compilerDir: string | null;
  readonly bundledDir: string;
}

/** True for a repository-relative directory that stays inside the repository. */
function insideRepository(dir: string): boolean {
  if (dir === '' || path.isAbsolute(dir) || /^[A-Za-z]:/.test(dir) || dir.includes('\\') || dir.includes('\0')) return false;
  return !dir.split('/').includes('..');
}

/**
 * The compiler the worker should load for `choice`: the project's directory (joined to the worktree root) only when the
 * choice is the project's own compiler and its directory is a plain repository-relative path, else the bundled one.
 */
export function compilerForRequest(choice: CompilerFacts, worktreeRoot: string, bundledDir: string = bundledCompilerDir()): CompilerRequest {
  if (choice.source === 'project' && choice.dir !== undefined && insideRepository(choice.dir)) {
    return { compilerDir: path.join(worktreeRoot, ...choice.dir.split('/')), bundledDir };
  }
  return { compilerDir: null, bundledDir };
}

/**
 * The fixed diagnostic text for a compiler fallback, or undefined for a project compiler. One sentence per install case;
 * nothing the repository wrote (no version string, no path) is copied into it.
 */
export function compilerFallbackText(choice: CompilerFacts): string | undefined {
  if (choice.source === 'project') return undefined;
  const bundled = `the bundled ${BUNDLED_TYPESCRIPT_VERSION} was used`;
  switch (choice.case) {
    case 'none':
      return `the project has no TypeScript compiler; ${bundled}`;
    case 'project-7-unstable':
      return `the project TypeScript is 7.x with the unstable API; ${bundled}`;
    case 'project-7-sync':
      return `the project TypeScript is 7.x with the sync API; ${bundled}`;
    case 'project-7-unknown-layout':
      return `the project TypeScript is 7.x with an unknown layout; ${bundled}`;
    case 'project-other':
      return `the project TypeScript is not 6.x; ${bundled}`;
    default:
      return `the project TypeScript could not be used; ${bundled}`;
  }
}
