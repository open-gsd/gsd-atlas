/**
 * Supplementary analyses A (priced cost) and B (baseline-cost regression) on the existing session logs.
 * Read only; no sessions, no network. Prints Markdown to stdout.
 *
 *   node scripts/analysis-supplementary/run.ts [--root <repo root>]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  BOOTSTRAP,
  bootstrapRatio,
  bootstrapRegression,
  componentCosts,
  fitPrices,
  parsePilotRow,
  parseRegisteredRow,
  pointsFor,
  questionMeans,
  splitHalfPoints,
  weightedTokens,
  type Arm,
  type Interval,
  type Metric,
  type Point,
  type Ratio,
  type Session,
} from './lib.ts';

export interface Dataset {
  name: string;
  sessions: Session[];
  questionIds: string[];
  /** The arms compared with G, in report order. */
  arms: Arm[];
}

const EVAL_DIR = ['docs', 'ev' + 'al'];
const N3_BOUND = 1.5;

function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

function make(name: string, sessions: Session[], arms: Arm[]): Dataset {
  const ids = [...new Set(sessions.map((s) => s.questionId))].sort();
  return { name, sessions: sessions.map((s) => ({ ...s, dataset: name })), questionIds: ids, arms };
}

export function loadAll(root: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')): { pilot: Dataset; registered: Dataset; cleanroom: Dataset } {
  const dir = path.join(root, ...EVAL_DIR);
  const pilot = readJsonl(path.join(dir, 'angular-pilot', 'v2', 'pilot', 'pilot-sessions.jsonl')).map(parsePilotRow);
  const registered = readJsonl(path.join(dir, 'results', 'results.jsonl')).map(parseRegisteredRow);
  const cleanroom = readJsonl(path.join(dir, 'results-cleanroom', 'results.jsonl')).map(parseRegisteredRow);
  return {
    pilot: make('Angular v2 pilot', pilot, ['A-reg', 'A-ts']),
    registered: make('Registered run (gsd-core)', registered, ['A-reg']),
    cleanroom: make('Clean-room replication (gsd-core)', cleanroom, ['A-reg']),
  };
}

// ---------------------------------------------------------------- formatting

const f2 = (v: number): string => v.toFixed(2);
const f3 = (v: number): string => v.toFixed(3);
const usd = (v: number): string => `$${v.toFixed(4)}`;
const pct = (v: number): string => `${(100 * v).toFixed(1)}%`;
const ratioText = (r: Ratio): string => `${f3(r.r)} (${f3(r.lo)} to ${f3(r.hi)})`;
const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
const head = (cells: readonly string[]): string => `${row(cells)}\n${row(cells.map((_, i) => (i === 0 ? '---' : '---:')))}`;
const armLabel = (a: Arm): string => (a === 'G' ? 'G (grep)' : a);
const cost: Metric = (s) => s.costUsd;
const billable: Metric = (s) => s.billable;

// ---------------------------------------------------------------- analysis A

function ratioOf(d: Dataset, arm: Arm, metric: Metric, ids: readonly string[] = d.questionIds): Ratio {
  return bootstrapRatio(questionMeans(d.sessions, arm, ids, metric), questionMeans(d.sessions, 'G', ids, metric));
}

function sectionA(d: Dataset): string {
  const out: string[] = [`### ${d.name}`, ''];
  const arms: Arm[] = ['G', ...d.arms];
  const prices = fitPrices(d.sessions);
  out.push(
    `Questions: ${d.questionIds.length}; sessions: ${d.sessions.length}. Logged cost reproduced from tokens at per million tokens input ${f2(prices.input * 1e6)}, cache creation ${f2(prices.cacheCreation * 1e6)}, cache read ${f2(prices.cacheRead * 1e6)}, output ${f2(prices.output * 1e6)} USD (largest residual ${prices.maxResidual.toExponential(1)} USD).`,
    '',
    'Mean per session, and the share of the logged cost by token class (fitted prices; the shares sum to the logged cost):',
    '',
    head(['arm', 'sessions', 'mean cost', 'mean billable tokens', 'cache read', 'cache creation', 'input', 'output']),
  );
  for (const arm of arms) {
    const rs = d.sessions.filter((s) => s.arm === arm);
    const c = componentCosts(rs, prices);
    const total = c.input + c.cacheCreation + c.cacheRead + c.output;
    out.push(row([armLabel(arm), String(rs.length), usd(total / rs.length), Math.round(rs.reduce((a, s) => a + s.billable, 0) / rs.length).toLocaleString('en-US'), pct(c.cacheRead / total), pct(c.cacheCreation / total), pct(c.input / total), pct(c.output / total)]));
  }
  out.push('', `Share of billable TOKENS (the unweighted measure of the earlier analyses) in cache reads: ${arms.map((a) => { const rs = d.sessions.filter((s) => s.arm === a); return `${a} ${pct(rs.reduce((x, s) => x + s.cacheRead, 0) / rs.reduce((x, s) => x + s.billable, 0))}`; }).join(', ')}.`, '');
  out.push(
    'Mean priced cost ratio, arm over G, paired by question (per-question mean over runs, questions resampled, 10,000 draws, seed 20261022, 90% percentile interval), with the billable-token ratio for comparison:',
    '',
    head(['arm / G', 'priced cost ratio (90% interval)', 'billable-token ratio (90% interval)', 'upper limit <= 1.5?']),
  );
  for (const arm of d.arms) {
    const rc = ratioOf(d, arm, cost);
    out.push(row([arm, ratioText(rc), ratioText(ratioOf(d, arm, billable)), rc.hi <= N3_BOUND ? 'yes' : 'no']));
  }
  out.push('', 'Per category, priced cost ratio (descriptive; the interval resamples the few questions of the category and is wide):', '');
  const cats = [...new Set(d.sessions.map((s) => s.category))].sort();
  out.push(head(['category', 'questions', ...d.arms.map((a) => `${a} / G (90% interval)`)]));
  for (const cat of cats) {
    const ids = d.questionIds.filter((id) => d.sessions.find((s) => s.questionId === id)!.category === cat);
    out.push(row([cat, String(ids.length), ...d.arms.map((a) => ratioText(ratioOf(d, a, cost, ids)))]));
  }
  out.push('', 'Sensitivity: the ratio when sessions are measured in weighted tokens (input 1, cache creation 2, output 5; these are the price ratios the log implies) with different cache-read weights. Weight 0.05 is the logged cost itself; weight 1.0 is the billable-token ratio except that cache creation and output are also weighted:', '');
  out.push(head(['arm / G', 'cache-read weight 0.05', 'weight 0.1', 'weight 1.0', 'logged cost', 'billable tokens (all weights 1)']));
  for (const arm of d.arms) {
    out.push(row([arm, ...[0.05, 0.1, 1].map((w) => ratioText(ratioOf(d, arm, (s) => weightedTokens(s, w)))), ratioText(ratioOf(d, arm, cost)), ratioText(ratioOf(d, arm, billable))]));
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------- analysis B

function range(v: readonly number[]): [number, number] {
  return [Math.min(...v), Math.max(...v)];
}

function intervalText(i: Interval, fmt: (v: number) => string): string {
  if (i.usableDraws === 0 || !Number.isFinite(i.est)) return `none (${i.usableDraws} usable draws)`;
  const partial = i.usableDraws < BOOTSTRAP.draws ? `; ${i.usableDraws} of ${BOOTSTRAP.draws} draws usable` : '';
  return `${fmt(i.est)} (${fmt(i.lo)} to ${fmt(i.hi)}${partial})`;
}

function breakText(i: Interval, xs: readonly number[], fmt: (v: number) => string): string {
  const base = intervalText(i, fmt);
  if (!Number.isFinite(i.est)) return base;
  const [lo, hi] = range(xs);
  return i.est < lo || i.est > hi ? `${base}, EXTRAPOLATION (observed ${fmt(lo)} to ${fmt(hi)})` : base;
}

interface Setup {
  label: string;
  d: Dataset;
  arm: Arm;
}

function regressionRows(points: readonly Point[], xName: string, ratioName: string, fmtX: (v: number) => string): string {
  const reg = bootstrapRegression(points);
  const xs = points.map((p) => p.x);
  return row([xName, ratioName, String(reg.n), intervalText(reg.spearman, f3), intervalText(reg.slope, f3), breakText(reg.breakEven1, xs, fmtX), breakText(reg.breakEven15, xs, fmtX)]);
}

function sectionB(setup: Setup): string {
  const { d, arm } = setup;
  const out: string[] = [`### ${setup.label}`, ''];
  const gCalls = questionMeans(d.sessions, 'G', d.questionIds, (s) => s.calls);
  const [cLo, cHi] = range(gCalls);
  out.push(`${d.questionIds.length} questions. G tool calls per question (mean over runs, final answer excluded): min ${f2(cLo)}, median ${f2([...gCalls].sort((a, b) => a - b)[Math.floor(gCalls.length / 2)]!)}, max ${f2(cHi)}.`, '');
  out.push('All runs (x = G mean over runs; ratio = A mean over G mean). This version has G in both x and the denominator, so it is exposed to regression to the mean:', '');
  out.push(head(['x', 'ratio of', 'n', 'Spearman (90%)', 'slope of ln(ratio) on ln(x) (90%)', 'break-even ratio 1.0', 'break-even ratio 1.5']));
  const byCalls = (m: Metric): Point[] => pointsFor(d.sessions, 'G', arm, d.questionIds, m);
  out.push(regressionRows(byCalls(cost), 'G calls', 'priced cost', f2));
  out.push(regressionRows(byCalls(billable), 'G calls', 'billable tokens', f2));
  const gCost = questionMeans(d.sessions, 'G', d.questionIds, cost);
  out.push(regressionRows(byCalls(cost).map((p, i) => ({ ...p, x: gCost[i]! })), 'G priced cost (USD)', 'priced cost', usd));
  out.push(regressionRows(byCalls(billable).map((p, i) => ({ ...p, x: gCost[i]! })), 'G priced cost (USD)', 'billable tokens', usd));
  out.push('', 'Regression-to-the-mean check (split half). x = G tool calls in ONE run; the denominator = G in the OTHER runs; the numerator = A over all its runs. G noise in x and in the denominator are independent. One row per choice of the x run:', '');
  out.push(head(['x run', 'ratio of', 'n', 'Spearman (90%)', 'slope of ln(ratio) on ln(x) (90%)', 'break-even ratio 1.0', 'break-even ratio 1.5']));
  const runs = [...new Set(d.sessions.filter((s) => s.arm === 'G').map((s) => s.run))].sort();
  const sumSlope: Record<string, number[]> = { cost: [], billable: [] };
  const sumRho: Record<string, number[]> = { cost: [], billable: [] };
  for (const [name, m] of [['priced cost', cost], ['billable tokens', billable]] as const) {
    for (const run of runs) {
      const pts = splitHalfPoints(d.sessions, 'G', arm, d.questionIds, m, run);
      const reg = bootstrapRegression(pts);
      const key = name === 'priced cost' ? 'cost' : 'billable';
      sumSlope[key]!.push(reg.slope.est);
      sumRho[key]!.push(reg.spearman.est);
      out.push(regressionRows(pts, `run ${run}`, name, f2));
    }
  }
  const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
  out.push('', `Mean over the x-run choices: priced cost Spearman ${f3(avg(sumRho['cost']!))}, slope ${f3(avg(sumSlope['cost']!))}; billable tokens Spearman ${f3(avg(sumRho['billable']!))}, slope ${f3(avg(sumSlope['billable']!))}.`, '');
  return out.join('\n');
}

function scatter(setup: Setup[]): string {
  const d = setup[0]!.d;
  const arms = setup.map((s) => s.arm);
  const out: string[] = [`### ${d.name}`, ''];
  out.push(head(['question', 'category', 'G calls', 'G cost', ...arms.flatMap((a) => [`${a} cost`, `${a}/G cost`, `${a}/G tokens`])]));
  const gCalls = questionMeans(d.sessions, 'G', d.questionIds, (s) => s.calls);
  const gCost = questionMeans(d.sessions, 'G', d.questionIds, cost);
  const gTok = questionMeans(d.sessions, 'G', d.questionIds, billable);
  const aCost = arms.map((a) => questionMeans(d.sessions, a, d.questionIds, cost));
  const aTok = arms.map((a) => questionMeans(d.sessions, a, d.questionIds, billable));
  const order = d.questionIds.map((_, i) => i).sort((a, b) => gCalls[a]! - gCalls[b]! || d.questionIds[a]!.localeCompare(d.questionIds[b]!));
  for (const i of order) {
    const id = d.questionIds[i]!;
    out.push(row([id, d.sessions.find((s) => s.questionId === id)!.category, f2(gCalls[i]!), usd(gCost[i]!), ...arms.flatMap((_, k) => [usd(aCost[k]![i]!), f2(aCost[k]![i]! / gCost[i]!), f2(aTok[k]![i]! / gTok[i]!)])]));
  }
  out.push('');
  return out.join('\n');
}

export function report(root?: string): string {
  const data = loadAll(root);
  const sets = [data.pilot, data.registered, data.cleanroom];
  const parts: string[] = ['## Tables for analysis A (priced cost)', ''];
  for (const d of sets) parts.push(sectionA(d));
  parts.push('## Tables for analysis B (baseline-cost regression)', '');
  const setups: Setup[] = [
    { label: 'Angular pilot, A-reg versus G', d: data.pilot, arm: 'A-reg' },
    { label: 'Angular pilot, A-ts versus G', d: data.pilot, arm: 'A-ts' },
    { label: 'Registered run, atlas (as A-reg) versus grep', d: data.registered, arm: 'A-reg' },
    { label: 'Clean-room replication, atlas (as A-reg) versus grep', d: data.cleanroom, arm: 'A-reg' },
  ];
  for (const s of setups) parts.push(sectionB(s));
  parts.push('## Scatter data (one row per question, sorted by G tool calls)', '');
  parts.push(scatter([setups[0]!, setups[1]!]), scatter([setups[2]!]), scatter([setups[3]!]));
  return parts.join('\n');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  process.stdout.write(`${report(at >= 0 ? process.argv[at + 1] : undefined)}\n`);
}
