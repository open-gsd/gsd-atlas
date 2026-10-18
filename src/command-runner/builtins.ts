/**
 * Exact-shape first-party built-ins (plan 03-19, TSM-05, D-13; command-runner ADR, Phase 3 amendment).
 *
 * The git built-in is recognised by the shape of its arguments inside `decide.ts`. The compiler worker is a second
 * kind of built-in: it is accepted only through a table of exact shapes that the composition root builds and injects
 * (`decide(spec, ctx, user, shapes)`, `createRealRunner({ builtinShapes })`). The table is an input, never module
 * state, and nothing in this file reads a file or takes input from repository data: the executable and the worker
 * path are chosen by the composition root, and the location of the project's own TypeScript travels in the first
 * stdin message, never in argv.
 */
import type { BuiltinShape, CommandSpec } from './spec.ts';

/** The id a spec must claim to be considered for the compiler worker shape. */
export const COMPILER_WORKER_ID = 'typescript-resolver';

/** Compiles an argument or value pattern anchored to the whole text, or `null` when the source is not a valid expression. */
function anchored(source: string): RegExp | null {
  try {
    return new RegExp(`^(?:${source})$`);
  } catch {
    return null;
  }
}

/**
 * True when `spec` is exactly what `shape` describes: it claims the shape id, runs the shape's executable (compared as
 * the exact string), has the same number of arguments with each one equal to its literal or matching its anchored
 * pattern, and sets only environment keys the shape lists, each with a value matching that key's anchored pattern.
 * A pattern that is not a valid regular expression never matches.
 */
export function matchShape(shape: BuiltinShape, spec: CommandSpec): boolean {
  if (spec.builtinId !== shape.id) return false;
  if (spec.executable !== shape.executable) return false;
  if (spec.args.length !== shape.args.length) return false;
  for (let i = 0; i < shape.args.length; i += 1) {
    const expected = shape.args[i];
    const actual = spec.args[i];
    if (expected === undefined || actual === undefined) return false;
    if ('literal' in expected) {
      if (actual !== expected.literal) return false;
    } else {
      const re = anchored(expected.pattern);
      if (re === null || !re.test(actual)) return false;
    }
  }
  if (spec.env !== undefined) {
    // Own keys only, looked up through a Map: `constructor` or `__proto__` must not resolve to an inherited member.
    const allowed = new Map(Object.entries(shape.env));
    for (const key of Object.keys(spec.env)) {
      const valuePattern = allowed.get(key);
      if (valuePattern === undefined) return false;
      const value = spec.env[key];
      const re = anchored(valuePattern);
      if (value === undefined || re === null || !re.test(value)) return false;
    }
  }
  return true;
}

export interface CompilerWorkerShapeOptions {
  /** The running Node binary, as the exact string the spec will carry (normally `process.execPath`). */
  readonly execPath: string;
  /** The absolute path of the worker file, chosen by the composition root. */
  readonly workerPath: string;
}

/**
 * The one shape of Phase 3: Node, a heap flag of one to six digits, then the known worker file path; the environment may
 * hold only `GSD_ATLAS_WORKER=1`. The memory watch lives inside the worker, so no per-OS process listing is allowed.
 */
export function compilerWorkerShape(options: CompilerWorkerShapeOptions): BuiltinShape {
  if (options.execPath === '') throw new TypeError('compilerWorkerShape: execPath must not be empty');
  if (options.workerPath === '') throw new TypeError('compilerWorkerShape: workerPath must not be empty');
  return {
    id: COMPILER_WORKER_ID,
    executable: options.execPath,
    args: [{ pattern: '--max-old-space-size=[0-9]{1,6}' }, { literal: options.workerPath }],
    env: { GSD_ATLAS_WORKER: '^1$' },
  };
}
