/**
 * Supplementary, unregistered analyses on existing session logs (priced cost; baseline-cost regression).
 * Pure functions only; `run.ts` reads the logs. Nothing here touches the frozen eval code or data.
 */

/** Fixed before looking at the numbers: 10,000 draws, seed 20261022, 90% percentile interval. */
export const BOOTSTRAP = { draws: 10_000, seed: 20261022, lowerIndex: 499, upperIndex: 9_499 } as const;

export type Arm = 'G' | 'A-ts' | 'A-reg';

export interface Session {
  dataset: string;
  arm: Arm;
  questionId: string;
  category: string;
  run: number;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** As logged: the sum of the four token counts. */
  billable: number;
  /** As logged by Claude Code (`total_cost_usd`). */
  costUsd: number;
  /** Tool calls excluding the final structured answer. */
  calls: number;
}

export type Metric = (s: Session) => number;

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

const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

function num(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`row ${String(row['jobId'] ?? row['questionId'])}: missing or non-numeric ${key}`);
  return v;
}

/** A row of `pilot-sessions.jsonl`. The logged `costUsd` is required; there is no fallback. */
export function parsePilotRow(row: Record<string, unknown>): Session {
  const input = num(row, 'input');
  const cacheCreation = num(row, 'cacheCreation');
  const cacheRead = num(row, 'cacheRead');
  const output = num(row, 'output');
  return {
    dataset: 'pilot',
    arm: row['condition'] as Arm,
    questionId: String(row['questionId']),
    category: String(row['category']),
    run: num(row, 'run'),
    input, cacheCreation, cacheRead, output,
    billable: input + cacheCreation + cacheRead + output,
    costUsd: num(row, 'costUsd'),
    calls: num(row, 'toolCalls'),
  };
}

/** A row of `results.jsonl` (registered run or clean-room replication). `grep` is G, `atlas` is A-reg (tools loaded upfront, as in the pilot's A-reg). */
export function parseRegisteredRow(row: Record<string, unknown>): Session {
  const usage = row['usage'] as Record<string, unknown>;
  const byName = (row['toolCallsByName'] ?? {}) as Record<string, number>;
  const input = num(usage, 'input');
  const cacheCreation = num(usage, 'cacheCreation');
  const cacheRead = num(usage, 'cacheRead');
  const output = num(usage, 'output');
  return {
    dataset: 'registered',
    arm: row['arm'] === 'grep' ? 'G' : 'A-reg',
    questionId: String(row['questionId']),
    category: String(row['category']),
    run: num(row, 'run'),
    input, cacheCreation, cacheRead, output,
    billable: input + cacheCreation + cacheRead + output,
    costUsd: num(row, 'costUsd'),
    calls: num(row, 'toolCalls') - (byName['StructuredOutput'] ?? 0),
  };
}

/** Per question (in `ids` order), the mean of `metric` over the arm's sessions on it. */
export function questionMeans(rows: readonly Session[], arm: Arm, ids: readonly string[], metric: Metric): number[] {
  return ids.map((id) => {
    const rs = rows.filter((r) => r.arm === arm && r.questionId === id);
    if (rs.length === 0) throw new Error(`no ${arm} session for question ${id}`);
    return mean(rs.map(metric));
  });
}

export interface Ratio {
  r: number;
  lo: number;
  hi: number;
}

function percentile(sorted: readonly number[]): { lo: number; hi: number } {
  const m = sorted.length;
  if (m === BOOTSTRAP.draws) return { lo: sorted[BOOTSTRAP.lowerIndex]!, hi: sorted[BOOTSTRAP.upperIndex]! };
  return { lo: sorted[Math.max(0, Math.floor(0.05 * m) - 1)]!, hi: sorted[Math.min(m - 1, Math.ceil(0.95 * m) - 1)]! };
}

/** R = mean(a) / mean(g) over questions; the 90% interval resamples questions, keeping each question's pair together. */
export function bootstrapRatio(a: readonly number[], g: readonly number[]): Ratio {
  if (a.length !== g.length || a.length === 0) throw new Error('a and g need the same, non-zero number of questions');
  const n = a.length;
  const rand = mulberry32(BOOTSTRAP.seed);
  const draws: number[] = [];
  for (let d = 0; d < BOOTSTRAP.draws; d += 1) {
    let sa = 0;
    let sg = 0;
    for (let i = 0; i < n; i += 1) {
      const k = Math.floor(rand() * n);
      sa += a[k]!;
      sg += g[k]!;
    }
    draws.push(sa / sg);
  }
  draws.sort((x, y) => x - y);
  return { r: mean(a) / mean(g), ...percentile(draws) };
}

// ---------------------------------------------------------------- prices and weights

export interface Prices {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** Largest absolute difference (USD) between the logged cost of a session and the fitted linear price of its tokens. */
  maxResidual: number;
}

/** Least-squares USD-per-token prices that reproduce the logged cost from the four token counts. */
export function fitPrices(rows: readonly Session[]): Prices {
  const k = 4;
  const feats = (s: Session): number[] => [s.input, s.cacheCreation, s.cacheRead, s.output];
  const A = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (const s of rows) {
    const x = feats(s);
    for (let a = 0; a < k; a += 1) {
      for (let b = 0; b < k; b += 1) A[a]![b]! += x[a]! * x[b]!;
      A[a]![k]! += x[a]! * s.costUsd;
    }
  }
  for (let i = 0; i < k; i += 1) {
    let p = i;
    for (let j = i + 1; j < k; j += 1) if (Math.abs(A[j]![i]!) > Math.abs(A[p]![i]!)) p = j;
    [A[i], A[p]] = [A[p]!, A[i]!];
    for (let j = 0; j < k; j += 1) {
      if (j === i) continue;
      const f = A[j]![i]! / A[i]![i]!;
      for (let m = i; m <= k; m += 1) A[j]![m]! -= f * A[i]![m]!;
    }
  }
  const [input, cacheCreation, cacheRead, output] = A.map((r, i) => r[k]! / r[i]!) as [number, number, number, number];
  const maxResidual = Math.max(...rows.map((s) => Math.abs(s.costUsd - (input * s.input + cacheCreation * s.cacheCreation + cacheRead * s.cacheRead + output * s.output))));
  return { input, cacheCreation, cacheRead, output, maxResidual };
}

export interface Components {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/** Sum over sessions of each token class times its price. */
export function componentCosts(rows: readonly Session[], p: Prices): Components {
  const c: Components = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  for (const s of rows) {
    c.input += s.input * p.input;
    c.cacheCreation += s.cacheCreation * p.cacheCreation;
    c.cacheRead += s.cacheRead * p.cacheRead;
    c.output += s.output * p.output;
  }
  return c;
}

/** Token-equivalents in units of one input token: cache creation 2, output 5 (the ratios the log implies), cache read as chosen. */
export function weightedTokens(s: Session, cacheReadWeight: number): number {
  return s.input + 2 * s.cacheCreation + cacheReadWeight * s.cacheRead + 5 * s.output;
}

// ---------------------------------------------------------------- rank correlation and log-log fit

export function averageRanks(v: readonly number[]): number[] {
  const order = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const ranks = new Array<number>(v.length);
  let at = 0;
  while (at < order.length) {
    let end = at;
    while (end + 1 < order.length && order[end + 1]!.x === order[at]!.x) end += 1;
    const rank = (at + end) / 2 + 1;
    for (let j = at; j <= end; j += 1) ranks[order[j]!.i] = rank;
    at = end + 1;
  }
  return ranks;
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i += 1) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation (average ranks for ties); NaN when one side is constant. */
export function spearman(x: readonly number[], y: readonly number[]): number {
  return pearson(averageRanks(x), averageRanks(y));
}

export interface Fit {
  intercept: number;
  slope: number;
}

/** Ordinary least squares of ln(y) on ln(x). */
export function olsLogLog(x: readonly number[], y: readonly number[]): Fit {
  const lx = x.map(Math.log);
  const ly = y.map(Math.log);
  const mx = mean(lx);
  const my = mean(ly);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < lx.length; i += 1) {
    sxy += (lx[i]! - mx) * (ly[i]! - my);
    sxx += (lx[i]! - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

/** The x at which the fitted ratio equals `target`; null when the fit is flat or rising (it never falls to the target from above). */
export function breakEven(f: Fit, target: number): number | null {
  if (!(f.slope < 0)) return null;
  return Math.exp((Math.log(target) - f.intercept) / f.slope);
}

// ---------------------------------------------------------------- regression of ratio on baseline work

export interface Point {
  questionId: string;
  category: string;
  /** Baseline (G) work: mean tool calls. */
  x: number;
  /** A over G, for the chosen metric. */
  ratio: number;
}

export interface Interval {
  est: number;
  lo: number;
  hi: number;
  /** Bootstrap draws in which the statistic existed. */
  usableDraws: number;
}

export interface Regression {
  n: number;
  spearman: Interval;
  slope: Interval;
  breakEven1: Interval;
  breakEven15: Interval;
}

function summarise(est: number, draws: number[]): Interval {
  if (draws.length === 0) return { est, lo: NaN, hi: NaN, usableDraws: 0 };
  draws.sort((a, b) => a - b);
  return { est, ...percentile(draws), usableDraws: draws.length };
}

/** Spearman, log-log slope and break-evens (ratio 1.0 and 1.5) with question-resampled percentile intervals. */
export function bootstrapRegression(points: readonly Point[]): Regression {
  const x = points.map((p) => p.x);
  const y = points.map((p) => p.ratio);
  const fit = olsLogLog(x, y);
  const rand = mulberry32(BOOTSTRAP.seed);
  const n = points.length;
  const sp: number[] = [];
  const sl: number[] = [];
  const b1: number[] = [];
  const b15: number[] = [];
  for (let d = 0; d < BOOTSTRAP.draws; d += 1) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const k = Math.floor(rand() * n);
      xs.push(x[k]!);
      ys.push(y[k]!);
    }
    const rho = spearman(xs, ys);
    const f = olsLogLog(xs, ys);
    if (Number.isFinite(rho)) sp.push(rho);
    if (Number.isFinite(f.slope)) {
      sl.push(f.slope);
      const e1 = breakEven(f, 1);
      const e15 = breakEven(f, 1.5);
      if (e1 !== null && Number.isFinite(e1)) b1.push(e1);
      if (e15 !== null && Number.isFinite(e15)) b15.push(e15);
    }
  }
  return {
    n,
    spearman: summarise(spearman(x, y), sp),
    slope: summarise(fit.slope, sl),
    breakEven1: summarise(breakEven(fit, 1) ?? NaN, b1),
    breakEven15: summarise(breakEven(fit, 1.5) ?? NaN, b15),
  };
}

/** One point per question: x = mean G calls, ratio = mean A metric over mean G metric (all runs of both). */
export function pointsFor(rows: readonly Session[], g: Arm, a: Arm, ids: readonly string[], metric: Metric): Point[] {
  const gm = questionMeans(rows, g, ids, metric);
  const am = questionMeans(rows, a, ids, metric);
  const gc = questionMeans(rows, g, ids, (s) => s.calls);
  return ids.map((id, i) => ({ questionId: id, category: rows.find((r) => r.questionId === id)!.category, x: gc[i]!, ratio: am[i]! / gm[i]! }));
}

/**
 * The regression-to-the-mean check. x is G's tool calls in run `xRun` only; the ratio's denominator is G's metric in the
 * OTHER runs; the numerator is A over all its runs. G's noise in x and G's noise in the denominator are then independent.
 */
export function splitHalfPoints(rows: readonly Session[], g: Arm, a: Arm, ids: readonly string[], metric: Metric, xRun: number): Point[] {
  return ids.map((id) => {
    const gx = rows.filter((r) => r.arm === g && r.questionId === id && r.run === xRun);
    const gd = rows.filter((r) => r.arm === g && r.questionId === id && r.run !== xRun);
    const as = rows.filter((r) => r.arm === a && r.questionId === id);
    if (gx.length === 0 || gd.length === 0 || as.length === 0) throw new Error(`question ${id}: missing sessions for the split`);
    return { questionId: id, category: gx[0]!.category, x: mean(gx.map((r) => r.calls)), ratio: mean(as.map(metric)) / mean(gd.map(metric)) };
  });
}
