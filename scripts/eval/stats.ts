// RED stubs: every function returns a wrong value so the cases in stats.test.ts fail on their assertions.
export interface QuestionSeries {
  readonly atlas: readonly number[];
  readonly grep: readonly number[];
}

export interface BootstrapResult {
  readonly diff: number;
  readonly lower: number;
  readonly upper: number;
}

export interface WilsonResult {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

export function mulberry32(_seed: number): () => number {
  return () => 0.5;
}

export function mean(_xs: readonly number[]): number {
  return 0;
}

export function percentile(_sorted: readonly number[], _p: number): number {
  return 0;
}

export function bootstrapDistribution(_diffs: readonly number[], _resamples: number, _seed: number): number[] {
  return [];
}

export function pairedClusterBootstrap(
  _perQuestion: readonly QuestionSeries[],
  _resamples: number,
  _seed: number,
  _level?: number,
): BootstrapResult {
  return { diff: 0, lower: 0, upper: 0 };
}

export function wilsonInterval(_successes: number, _n: number, _z: number): WilsonResult {
  throw new Error('wilsonInterval is implemented in Task 2');
}
