/**
 * Mechanical reading of the 96-session angular pilot (UNSCORED, UNREGISTERED). The rules are those pre-declared in
 * `docs/eval/angular-pilot/v2/pilot-run-plan.md` (from section 6 of the pilot plan); this file only computes them.
 *
 *   node scripts/angular-pilot/pilot-analysis.ts --out <driver out dir> --docs <docs dir> --dest <dir> [--keys-changed N]
 *
 * Reads `<out>/pilot-records.jsonl` and `<out>/streams/<jobId>.jsonl` (raw streams, read here only to take usage splits,
 * tool counts and the answered file names); writes `<dest>/pilot-sessions.jsonl` (counts, tokens, statuses; no answer
 * prose), `<dest>/summary.json` and `<dest>/tables.md`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { matchSets, projectItems, type ScoredItem } from '../eval/score.ts';
import { recordOf } from '../probes/stream.ts';
import { PREMISE, answerFromStream } from './pilot-plan.ts';

export const BOOTSTRAP = { draws: 10_000, seed: 20261021, lowerIndex: 499, upperIndex: 9_499 } as const;
export const THRESHOLDS = { worthR: 0.85, stopR: 1.1, correctnessMargin: 0.1, adoptionWorth: 0.5, adoptionLow: 0.2, correctnessLow: 0.5, keysChangedMax: 3 } as const;
const EPS = 1e-9;

export type Cond = 'G' | 'A-ts' | 'A-reg';
export interface Row {
  jobId: string;
  condition: Cond;
  questionId: string;
  category: string;
  run: number;
  status: string;
  billable: number;
  atlasCalls: number;
  /** Exact-set equality with the key; null when the answer could not be read (counted as wrong). */
  exact: boolean | null;
  matched: number;
  missing: number;
  extra: number;
  [more: string]: unknown;
}

/** mulberry32 (Tommy Ettinger's 32-bit generator), seeded with an unsigned integer. */
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

/** Per question (in `ids` order), the mean billable tokens of the condition's sessions on it. */
export function questionMeans(rows: readonly Row[], condition: Cond, ids: readonly string[]): number[] {
  return ids.map((id) => {
    const rs = rows.filter((r) => r.condition === condition && r.questionId === id);
    if (rs.length === 0) throw new Error(`no ${condition} session for question ${id}`);
    return mean(rs.map((r) => r.billable));
  });
}

export interface Ratio {
  r: number;
  lo: number;
  hi: number;
}

/** R = mean(a) / mean(g) over questions, with a 90% percentile interval from `BOOTSTRAP.draws` resamples of the questions. */
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
  return { r: mean(a) / mean(g), lo: draws[BOOTSTRAP.lowerIndex]!, hi: draws[BOOTSTRAP.upperIndex]! };
}

/** Share of sessions whose answer set equals the key (an unreadable answer counts as wrong). */
export function correctnessOf(rows: readonly Row[]): number {
  return rows.filter((r) => r.exact === true).length / rows.length;
}

/** Share of sessions with at least one atlas tool call. */
export function adoptionOf(rows: readonly Row[]): number {
  return rows.filter((r) => r.atlasCalls > 0).length / rows.length;
}

export type Premise = 'passed' | 'between' | 'failed';
export function premiseOf(gMean: number): Premise {
  return gMean >= PREMISE.floorBillable ? 'passed' : gMean < PREMISE.failedBelow ? 'failed' : 'between';
}

export interface CalledVsG {
  n: number;
  calledMean: number;
  matchedGMean: number;
  atLeastAsMuch: boolean;
}

/** A sessions with an atlas call (both A conditions) against the mean G session of the same question, one G mean per called session. */
export function calledVsMatchedG(rows: readonly Row[]): CalledVsG | null {
  const called = rows.filter((r) => r.condition !== 'G' && r.atlasCalls > 0);
  if (called.length === 0) return null;
  const gOf = (q: string): number => {
    const g = rows.filter((r) => r.condition === 'G' && r.questionId === q);
    if (g.length === 0) throw new Error(`no G session for question ${q}`);
    return mean(g.map((r) => r.billable));
  };
  const calledMean = mean(called.map((r) => r.billable));
  const matchedGMean = mean(called.map((r) => gOf(r.questionId)));
  return { n: called.length, calledMean, matchedGMean, atLeastAsMuch: calledMean >= matchedGMean };
}

export type OutcomeClass = 'worth a registered run' | 'stop and reconsider the token gate' | 'inconclusive';
export interface ClassInput {
  premise: Premise;
  r: Record<'A-ts' | 'A-reg', number>;
  correctness: Record<Cond, number>;
  adoption: Record<'A-ts' | 'A-reg', number>;
  calledVsG: { atLeastAsMuch: boolean } | null;
  keysChanged: number;
}
export interface Classification {
  class: OutcomeClass | 'judgement';
  ifPremisePassed?: OutcomeClass;
  ifPremiseNotPassed?: OutcomeClass;
  premise: Premise;
  flags: string[];
}

const A_CONDS = ['A-ts', 'A-reg'] as const;

function classifyWith(input: ClassInput, premisePassed: boolean): { class: OutcomeClass; flags: string[] } {
  const flags: string[] = [];
  const t = THRESHOLDS;
  const worth = premisePassed && A_CONDS.some((c) => input.r[c] <= t.worthR + EPS && input.correctness[c] >= input.correctness.G - t.correctnessMargin - EPS && input.adoption[c] >= t.adoptionWorth - EPS);
  const stop1 = premisePassed && A_CONDS.every((c) => input.r[c] >= t.stopR - EPS);
  const stop2 = input.calledVsG !== null && input.calledVsG.atLeastAsMuch;
  if (A_CONDS.some((c) => input.r[c] > t.worthR + EPS && input.r[c] < t.stopR - EPS)) flags.push('R between 0.85 and 1.10');
  if (A_CONDS.some((c) => input.adoption[c] < t.adoptionLow - EPS)) flags.push('adoption below 20%');
  if (([...A_CONDS, 'G'] as const).some((c) => input.correctness[c] < t.correctnessLow - EPS)) flags.push('correctness below 50%');
  if (input.keysChanged > t.keysChangedMax) flags.push('more than 3 of 16 keys changed');
  if (worth) {
    if (stop2) flags.push('stop clause 2 also holds');
    return { class: 'worth a registered run', flags };
  }
  if (stop1 || stop2) {
    if (stop1) flags.push('stop clause 1: both R at or above 1.10 with the premise passed');
    if (stop2) flags.push('stop clause 2: atlas sessions with a call cost at least as much as G on the same questions');
    return { class: 'stop and reconsider the token gate', flags };
  }
  return { class: 'inconclusive', flags };
}

/**
 * The outcome class, in the plan's order: worth, then stop, then inconclusive. The test of "worth" is made for one A
 * condition at a time. The premise qualifier attaches to "worth" and to the first stop clause. When the premise is
 * between 55,000 and 68,000 both readings are computed and the class is `judgement` unless they agree.
 */
export function classify(input: ClassInput): Classification {
  if (input.premise === 'between') {
    const yes = classifyWith(input, true);
    const no = classifyWith(input, false);
    const same = yes.class === no.class;
    return { class: same ? yes.class : 'judgement', ifPremisePassed: yes.class, ifPremiseNotPassed: no.class, premise: input.premise, flags: [...new Set([...yes.flags, ...no.flags])] };
  }
  const one = classifyWith(input, input.premise === 'passed');
  return { class: one.class, premise: input.premise, flags: input.premise === 'failed' ? ['premise failed', ...one.flags] : one.flags };
}

// ---------------------------------------------------------------------------------------------
// CLI: records and streams in, compact data out

interface QuestionFile {
  questions: { id: string; category: string }[];
}
interface AnswerFile {
  answers: { questionId: string; abstain: boolean; granularity: 'file' | 'file+symbol' | 'file+line'; items: { file?: string; line?: number; symbol?: string }[] }[];
}
interface DriverRecord {
  jobId: string;
  condition: Cond;
  questionId: string;
  run: number;
  status: string;
  wallMs: number;
  costUsd: number | null;
  rate: { fiveHour: number | null; sevenDay: number | null; isUsingOverage: boolean | null; overageStatus: string | null };
}

const scored = (items: readonly { file?: string; line?: number; symbol?: string }[]): ScoredItem[] =>
  items.flatMap((i) => (i.file === undefined ? [] : [{ file: i.file, ...(i.line === undefined ? {} : { line: i.line }), ...(i.symbol === undefined ? {} : { symbol: i.symbol }) }]));
const label = (i: ScoredItem): string => (i.symbol !== undefined ? `${i.file}#${i.symbol}` : i.line !== undefined ? `${i.file}:${String(i.line)}` : i.file);

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const fix = (x: number, d = 0): string => x.toFixed(d);
const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? Number.NaN : n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

function main(): void {
  const { values } = parseArgs({ options: { out: { type: 'string' }, docs: { type: 'string' }, dest: { type: 'string' }, 'keys-changed': { type: 'string', default: '1' } } });
  if (values.out === undefined || values.docs === undefined || values.dest === undefined) throw new Error('usage: --out <driver out dir> --docs <docs dir> --dest <dir> [--keys-changed N]');
  const qf = JSON.parse(fs.readFileSync(path.join(values.docs, 'pilot-questions.json'), 'utf8')) as QuestionFile;
  const af = JSON.parse(fs.readFileSync(path.join(values.docs, 'pilot-answers.json'), 'utf8')) as AnswerFile;
  const keys = new Map(af.answers.map((a) => [a.questionId, a] as const));
  const category = new Map(qf.questions.map((q) => [q.id, q.category] as const));
  const ids = qf.questions.map((q) => q.id);
  const records = fs.readFileSync(path.join(values.out, 'pilot-records.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as DriverRecord);
  const rows: Row[] = [];
  const notExact: Record<string, unknown>[] = [];
  for (const rec of records) {
    const text = fs.readFileSync(path.join(values.out, 'streams', `${rec.jobId}.jsonl`), 'utf8');
    const f = recordOf(text, { wallMs: rec.wallMs });
    const key = keys.get(rec.questionId)!;
    const ans = answerFromStream(text, []);
    let exact: boolean | null = null;
    let matched = 0;
    let missing = 0;
    let extra = 0;
    let detail: { missing: string[]; extra: string[] } = { missing: [], extra: [] };
    if (ans !== null) {
      const keyItems = projectItems(scored(key.items), key.granularity);
      if (key.abstain) {
        exact = ans.answer === 'not_found' && ans.items.length === 0;
        extra = ans.items.length;
        detail = { missing: [], extra: ans.items.map((i) => i.file) };
      } else if (ans.answer === 'not_found') {
        exact = false;
        missing = keyItems.length;
        detail = { missing: keyItems.map(label), extra: [] };
      } else {
        const given = projectItems(scored(ans.items), key.granularity);
        const m = matchSets(keyItems, given, key.granularity);
        matched = m.matched.length;
        missing = m.missing.length;
        extra = m.extra.length;
        exact = missing === 0 && extra === 0 && given.length > 0;
        detail = { missing: m.missing.map(label), extra: m.extra.map(label) };
      }
    }
    rows.push({
      jobId: rec.jobId, condition: rec.condition, questionId: rec.questionId, category: category.get(rec.questionId) ?? '?', run: rec.run, status: rec.status,
      billable: f.usage.billable, atlasCalls: f.atlasCalls, exact, matched, missing, extra,
      input: f.usage.input, cacheCreation: f.usage.cacheCreation, cacheRead: f.usage.cacheRead, output: f.usage.output, firstRequest: f.firstRequest?.total ?? null,
      numTurns: f.numTurns, toolCalls: f.toolCallsExStructured, toolSearchCalls: f.byTool['ToolSearch'] ?? 0, byTool: f.byTool, skillLoaded: f.skillLoaded,
      claudeCodeVersion: f.claudeCodeVersion, apiKeySource: f.apiKeySource, initMcpToolCount: f.init?.mcpToolCount ?? null,
      wallMs: rec.wallMs, costUsd: rec.costUsd, fiveHour: rec.rate.fiveHour, sevenDay: rec.rate.sevenDay, isUsingOverage: rec.rate.isUsingOverage, overageStatus: rec.rate.overageStatus,
    });
    if (exact !== true) notExact.push({ jobId: rec.jobId, condition: rec.condition, questionId: rec.questionId, status: rec.status, answered: ans?.answer ?? null, matched, missing, extra, missingFiles: detail.missing, extraFiles: detail.extra });
  }
  const conds: Cond[] = ['G', 'A-ts', 'A-reg'];
  const num = (r: Row, k: string): number => Number(r[k] ?? 0);
  const g = questionMeans(rows, 'G', ids);
  const ratio = { 'A-ts': bootstrapRatio(questionMeans(rows, 'A-ts', ids), g), 'A-reg': bootstrapRatio(questionMeans(rows, 'A-reg', ids), g) };
  const byCond = Object.fromEntries(conds.map((c) => {
    const rs = rows.filter((r) => r.condition === c);
    const right = rs.filter((r) => r.exact === true);
    return [c, {
      sessions: rs.length, billableMean: mean(rs.map((r) => r.billable)), billableMedian: median(rs.map((r) => r.billable)),
      billableMeanExactOnly: right.length === 0 ? null : mean(right.map((r) => r.billable)), exactSessions: right.length,
      inputMean: mean(rs.map((r) => num(r, 'input'))), cacheCreationMean: mean(rs.map((r) => num(r, 'cacheCreation'))), cacheReadMean: mean(rs.map((r) => num(r, 'cacheRead'))), outputMean: mean(rs.map((r) => num(r, 'output'))),
      firstRequestMean: mean(rs.map((r) => num(r, 'firstRequest'))), toolCallsMean: mean(rs.map((r) => num(r, 'toolCalls'))),
      correctness: correctnessOf(rs), adoption: adoptionOf(rs), sessionsWithAtlasCall: rs.filter((r) => r.atlasCalls > 0).length, atlasCallsTotal: rs.reduce((a, r) => a + r.atlasCalls, 0),
      toolSearchCalls: rs.reduce((a, r) => a + num(r, 'toolSearchCalls'), 0), skillLoaded: rs.filter((r) => r.skillLoaded === true).length,
      matched: rs.reduce((a, r) => a + r.matched, 0), missing: rs.reduce((a, r) => a + r.missing, 0), extra: rs.reduce((a, r) => a + r.extra, 0),
      wallSecMean: mean(rs.map((r) => num(r, 'wallMs') / 1000)), costSum: rs.reduce((a, r) => a + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0),
    }];
  }));
  const cats = [...new Set(ids.map((i) => category.get(i)!))];
  const byCategory = Object.fromEntries(cats.map((cat) => {
    const qids = ids.filter((i) => category.get(i) === cat);
    const gm = mean(questionMeans(rows, 'G', qids));
    return [cat, { questions: qids.length, ...Object.fromEntries(conds.map((c) => {
      const rs = rows.filter((r) => r.condition === c && qids.includes(r.questionId));
      const m = mean(questionMeans(rows, c, qids));
      return [c, { billableMean: m, ratioToG: m / gm, correctness: correctnessOf(rs), adoption: c === 'G' ? null : adoptionOf(rs) }];
    })) }];
  }));
  const withVs = Object.fromEntries(['A-ts', 'A-reg', 'both'].map((c) => {
    const rs = rows.filter((r) => (c === 'both' ? r.condition !== 'G' : r.condition === c));
    const w = rs.filter((r) => r.atlasCalls > 0);
    const wo = rs.filter((r) => r.atlasCalls === 0);
    const side = (x: Row[]): unknown => (x.length === 0 ? null : { sessions: x.length, billableMean: mean(x.map((r) => r.billable)), correctness: correctnessOf(x) });
    return [c, { withAtlasCall: side(w), withoutAtlasCall: side(wo) }];
  }));
  const matchedQs = ids.flatMap((q) => {
    const rs = rows.filter((r) => r.condition !== 'G' && r.questionId === q);
    const w = rs.filter((r) => r.atlasCalls > 0);
    const wo = rs.filter((r) => r.atlasCalls === 0);
    return w.length > 0 && wo.length > 0 ? [{ questionId: q, called: mean(w.map((r) => r.billable)), notCalled: mean(wo.map((r) => r.billable)) }] : [];
  });
  const gMean = mean(g);
  const called = calledVsMatchedG(rows);
  const classification = classify({
    premise: premiseOf(gMean),
    r: { 'A-ts': ratio['A-ts'].r, 'A-reg': ratio['A-reg'].r },
    correctness: { G: byCond['G']!.correctness, 'A-ts': byCond['A-ts']!.correctness, 'A-reg': byCond['A-reg']!.correctness },
    adoption: { 'A-ts': byCond['A-ts']!.adoption, 'A-reg': byCond['A-reg']!.adoption },
    calledVsG: called,
    keysChanged: Number(values['keys-changed']),
  });
  const fives = rows.map((r) => r.fiveHour).filter((x): x is number => typeof x === 'number');
  const sevens = rows.map((r) => r.sevenDay).filter((x): x is number => typeof x === 'number');
  const summary = {
    sessions: rows.length, nonOk: rows.filter((r) => r.status !== 'ok').map((r) => r.jobId),
    premise: { gMean, verdict: premiseOf(gMean) }, ratio, byCond, byCategory, withVs, matchedQuestions: matchedQs, calledVsMatchedG: called,
    classification, keysChanged: Number(values['keys-changed']),
    rate: { maxFiveHour: Math.max(...fives), maxSevenDay: Math.max(...sevens), anyOverage: rows.some((r) => r.isUsingOverage !== false), overageStatuses: [...new Set(rows.map((r) => String(r.overageStatus)))] },
    versions: [...new Set(rows.map((r) => String(r.claudeCodeVersion)))], apiKeySources: [...new Set(rows.map((r) => String(r.apiKeySource)))],
    costSum: rows.reduce((a, r) => a + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0), wallSecSum: rows.reduce((a, r) => a + num(r, 'wallMs') / 1000, 0),
    notExact,
  };
  fs.mkdirSync(values.dest, { recursive: true });
  fs.writeFileSync(path.join(values.dest, 'pilot-sessions.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  fs.writeFileSync(path.join(values.dest, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  const t: string[] = [];
  t.push('| | G | A-ts | A-reg |', '| --- | ---: | ---: | ---: |');
  const line = (name: string, f: (c: Cond) => string): void => void t.push(`| ${name} | ${conds.map(f).join(' | ')} |`);
  line('billable mean (median)', (c) => `${fix(byCond[c]!.billableMean)} (${fix(byCond[c]!.billableMedian)})`);
  line('billable mean, exact sessions only', (c) => (byCond[c]!.billableMeanExactOnly === null ? 'n/a' : fix(byCond[c]!.billableMeanExactOnly!)));
  line('input / cache creation / cache read / output (mean)', (c) => `${fix(byCond[c]!.inputMean)} / ${fix(byCond[c]!.cacheCreationMean)} / ${fix(byCond[c]!.cacheReadMean)} / ${fix(byCond[c]!.outputMean)}`);
  line('first request (mean)', (c) => fix(byCond[c]!.firstRequestMean));
  line('tool calls excl. final answer (mean)', (c) => fix(byCond[c]!.toolCallsMean, 1));
  line('correctness (exact set)', (c) => `${pct(byCond[c]!.correctness)} (${String(byCond[c]!.exactSessions)}/${String(byCond[c]!.sessions)})`);
  line('matched / missing / extra (sum)', (c) => `${String(byCond[c]!.matched)} / ${String(byCond[c]!.missing)} / ${String(byCond[c]!.extra)}`);
  line('adoption (sessions with an atlas call)', (c) => (c === 'G' ? 'n/a' : `${pct(byCond[c]!.adoption)} (${String(byCond[c]!.sessionsWithAtlasCall)}/${String(byCond[c]!.sessions)})`));
  line('atlas calls total / ToolSearch calls / skill loaded', (c) => (c === 'G' ? 'n/a' : `${String(byCond[c]!.atlasCallsTotal)} / ${String(byCond[c]!.toolSearchCalls)} / ${String(byCond[c]!.skillLoaded)}`));
  line('wall seconds (mean)', (c) => fix(byCond[c]!.wallSecMean, 1));
  line('cost USD (sum)', (c) => byCond[c]!.costSum.toFixed(3));
  t.push('', '| R | point | 90% interval |', '| --- | ---: | --- |');
  for (const c of ['A-ts', 'A-reg'] as const) t.push(`| ${c} / G | ${ratio[c].r.toFixed(3)} | ${ratio[c].lo.toFixed(3)} to ${ratio[c].hi.toFixed(3)} |`);
  t.push('', '| category | questions | G mean | A-ts mean (R) | A-reg mean (R) | correctness G / A-ts / A-reg | adoption A-ts / A-reg |', '| --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const cat of cats) {
    const b = byCategory[cat] as Record<string, any>;
    t.push(`| ${cat} | ${String(b['questions'])} | ${fix(b['G'].billableMean)} | ${fix(b['A-ts'].billableMean)} (${b['A-ts'].ratioToG.toFixed(2)}) | ${fix(b['A-reg'].billableMean)} (${b['A-reg'].ratioToG.toFixed(2)}) | ${pct(b['G'].correctness)} / ${pct(b['A-ts'].correctness)} / ${pct(b['A-reg'].correctness)} | ${pct(b['A-ts'].adoption)} / ${pct(b['A-reg'].adoption)} |`);
  }
  fs.writeFileSync(path.join(values.dest, 'tables.md'), `${t.join('\n')}\n`);
  process.stdout.write(`${t.join('\n')}\n\npremise ${summary.premise.verdict} (G mean ${fix(gMean)})\nclass: ${classification.class}\nflags: ${classification.flags.join('; ')}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
