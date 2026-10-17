/**
 * Test-only doubles. A leaf over the kernel: imports only src/facts. Never imported by
 * production code and excluded from the build.
 */
export { FakeClock } from './fake-clock.ts';
export { makeTempDir, realPath } from './tmpdir.ts';
export type { TempDir } from './tmpdir.ts';
export { collectStages, createRunGate } from './run-gate.ts';
export type { RunGate } from './run-gate.ts';
export { createTempGitRepo } from './git-repo.ts';
export type {
  GitRepoWorld,
  SetupResult,
  SetupRunner,
  SetupSpec,
  TempGitRepo,
  TempGitRepoOptions,
} from './git-repo.ts';
