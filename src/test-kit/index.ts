/**
 * Test-only doubles. A leaf over the kernel: imports only src/facts. Never imported by
 * production code and excluded from the build.
 */
export { FakeClock } from './fake-clock.ts';
export { makeTempDir, realPath } from './tmpdir.ts';
export type { TempDir } from './tmpdir.ts';
