// RED stub: returns a wrong verdict so the cases in analyze.test.ts fail on their assertions.
import type { ResultRow } from './rows.ts';

export interface AccuracyConfig {
  readonly marginPoints: number;
  readonly intervalLevel: number;
  readonly resamples: number;
  readonly seed: number;
}

export interface AccuracyResult {
  readonly observedDiff: number;
  readonly lower: number;
  readonly upper: number;
  readonly accuracyNonInferior: boolean;
}

export function analyzeAccuracy(_rows: readonly ResultRow[], _config: AccuracyConfig): AccuracyResult {
  return { observedDiff: 0, lower: 0, upper: 0, accuracyNonInferior: false };
}

export function analyzeResults(rows: readonly ResultRow[], config: AccuracyConfig): AccuracyResult {
  return analyzeAccuracy(rows, config);
}
