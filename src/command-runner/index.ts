/**
 * The CommandRunner seam (FND-05, FND-06, D-10, D-11): the only code that starts a child process.
 *
 * This index exports production surface only: the spec and result types, the permission rule, the
 * real adapter, the recording fake, and their helpers. The shared contract suite (`contract.ts`) is
 * test code and is deliberately NOT exported here; the module's own tests import it by relative path.
 */
export type {
  BuiltinArgShape,
  BuiltinShape,
  CommandResult,
  CommandRunner,
  CommandSpec,
  CommandStream,
  DecideFn,
  Decision,
  RunContext,
  StdinChunk,
  StdinSource,
  UserPermissions,
} from './spec.ts';
export { COMMAND_CODES, DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDOUT_BYTES } from './spec.ts';
export { allowAll, decide } from './decide.ts';
export { COMPILER_WORKER_ID, compilerWorkerShape, matchShape } from './builtins.ts';
export type { CompilerWorkerShapeOptions } from './builtins.ts';
export { createAsyncQueue } from './async-queue.ts';
export type { AsyncQueue } from './async-queue.ts';
export { canonicalCommand, commandHash } from './hash.ts';
export type { HashableCommand } from './hash.ts';
export { createRealRunner } from './real.ts';
export type { RealRunnerOptions } from './real.ts';
export { createRecordingRunner } from './fake.ts';
export type { RecordedSpec, RecordedStdin, RecordingRunner, RecordingRunnerOptions, ScriptedResult } from './fake.ts';
export { defaultRunnable, resolveExecutable } from './exec-resolve.ts';
export type { ResolveOptions, ResolvedExecutable } from './exec-resolve.ts';
export { scrubEnv } from './env.ts';
export { GitConfigError, gitSpec, listFilterNames, neutraliseFilters, NULL_DEVICE, parseFilterNames } from './git-spec.ts';
export type { GitConfigErrorCode, GitSpecOptions } from './git-spec.ts';
