/**
 * The statistics of the MVP eval (D-04, D-06): a seeded random source, a percentile rule, a paired cluster
 * bootstrap and the Wilson interval. No dependency; every function is pure. The definitions here are what the
 * pre-registration hashes, so a change after the freeze voids the claim (D-04).
 */

/** Per-question run results for the two arms; every run of a question stays together (PITFALLS C4). */
export interface QuestionSeries {
  readonly atlas: readonly number[];
  readonly grep: readonly number[];
}

export interface BootstrapResult {
  /** The observed mean over questions of (atlas run mean minus grep run mean). */
  readonly diff: number;
  /** The `1 - level` percentile of the bootstrap distribution (the 5th percentile at level 0.95). */
  readonly lower: number;
  /** The `level` percentile of the bootstrap distribution (the 95th percentile at level 0.95). */
  readonly upper: number;
}

export interface WilsonResult {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

/**
 * The mulberry32 generator (public domain, Tommy Ettinger): a 32-bit seeded stream of numbers in [0, 1).
 * Two calls with the same seed give the same sequence on every platform, which is what makes a registered
 * bootstrap reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The arithmetic mean. An empty list has no mean and throws a RangeError. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('mean of an empty list');
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * The percentile rule: `sorted[Math.floor(p * (n - 1))]` over an ascending list, p in [0, 1]. No interpolation.
 * A fixed 1e-9 allowance is added before the floor so that a product such as 0.29 * 100, which floating point
 * stores as 28.999999999999996, still reads index 29; every index the registered levels produce is far from a
 * half-integer, so the allowance never changes a registered result.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile of an empty list');
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile p must be in [0, 1], got ${String(p)}`);
  const index = Math.floor(p * (sorted.length - 1) + 1e-9);
  return sorted[Math.min(index, sorted.length - 1)] as number;
}

function checkResamples(resamples: number): void {
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`resamples must be a positive integer, got ${String(resamples)}`);
  }
}

/**
 * The bootstrap distribution of the mean of `diffs`, sorted ascending. Each of `resamples` rounds draws
 * `diffs.length` indices with `Math.floor(rand() * n)` (resampling WITH replacement) and records the mean of the
 * drawn differences. The seed fixes the stream.
 */
export function bootstrapDistribution(diffs: readonly number[], resamples: number, seed: number): number[] {
  if (diffs.length === 0) throw new RangeError('bootstrap needs at least one question');
  checkResamples(resamples);
  const rand = mulberry32(seed);
  const n = diffs.length;
  const stats: number[] = new Array<number>(resamples);
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(rand() * n)] as number;
    stats[b] = sum / n;
  }
  return stats.sort((x, y) => x - y);
}

/**
 * The paired cluster bootstrap of (atlas minus grep) over questions (D-04). The unit of resampling is the
 * question: the per-question difference is first computed from the mean over that question's runs in each arm,
 * and only then are questions resampled, so all runs of a question stay together. The distribution is sorted once
 * and read with `percentile`.
 *
 * `lower` and `upper` are the `1 - level` and `level` percentiles of the bootstrap distribution; at the default
 * level 0.95 they are the 5th and 95th percentiles, and the one-sided 95 percent lower bound is the 5th percentile.
 * The analysis passes the registered level explicitly and never relies on the default. Zero questions, a question
 * with no runs in an arm, or a bad resample count throw a RangeError.
 */
export function pairedClusterBootstrap(
  perQuestion: readonly QuestionSeries[],
  resamples: number,
  seed: number,
  level = 0.95,
): BootstrapResult {
  if (perQuestion.length === 0) throw new RangeError('bootstrap needs at least one question');
  if (!(level > 0.5 && level < 1)) throw new RangeError(`level must be in (0.5, 1), got ${String(level)}`);
  const diffs = perQuestion.map((question) => mean(question.atlas) - mean(question.grep));
  const distribution = bootstrapDistribution(diffs, resamples, seed);
  return {
    diff: mean(diffs),
    lower: percentile(distribution, Number((1 - level).toFixed(12))),
    upper: percentile(distribution, level),
  };
}

/** The Wilson score interval (implemented with the citation analysis, Task 2 of plan 03-05). */
export function wilsonInterval(_successes: number, _n: number, _z: number): WilsonResult {
  throw new Error('wilsonInterval is implemented in Task 2');
}
