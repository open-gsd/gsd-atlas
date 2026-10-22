/**
 * Supplementary audit of the angular pilot (rule v2) session answers against the keys. Unscored, unregistered.
 * Pure helpers: rescoring the 96 sessions under another key set and/or with the leading `packages/` restored, and the
 * bookkeeping of the per-file verdicts. The outcome class is computed by the pre-declared rules in `pilot-analysis.ts`.
 */
import { adoptionOf, bootstrapRatio, calledVsMatchedG, classify, correctnessOf, premiseOf, questionMeans, type Classification, type Cond, type Premise, type Row } from './pilot-analysis.ts';

export type Keys = Record<string, string[]>;

/** The `notExact` entries of `pilot/summary.json` (only the fields used here). */
export interface NotExact {
  jobId: string;
  questionId: string;
  missingFiles: string[];
  extraFiles: string[];
}

export type Verdict = 'a' | 'b' | 'c' | 'd';
/**
 * a: the key is right, the session is wrong. b: the session found a genuine hit the key lacks (key defect).
 * c: the session omitted a genuine key hit. d: path-format artifact or question-wording ambiguity.
 */
export interface VerdictEntry {
  questionId: string;
  file: string;
  side: 'missing' | 'extra';
  verdict: Verdict;
  reason: string;
  evidence: string;
}

const CONDS: readonly Cond[] = ['G', 'A-ts', 'A-reg'];

/** The key's comparison entries at the question's granularity (`file`, `file#symbol` or `file:line`), deduplicated and sorted. */
export function keyEntries(a: { granularity: string; items: readonly { file?: string; line?: number; symbol?: string }[] }): string[] {
  const one = (i: { file?: string; line?: number; symbol?: string }): string => (a.granularity === 'file+symbol' ? `${i.file ?? ''}#${i.symbol ?? ''}` : a.granularity === 'file+line' ? `${i.file ?? ''}:${String(i.line ?? 0)}` : (i.file ?? ''));
  return [...new Set(a.items.map(one))].sort();
}

/** The registered matching works on the path as answered; this only restores the leading `packages/`. */
export function normalizePath(p: string): string {
  const q = p.startsWith('./') ? p.slice(2) : p;
  return q.startsWith('packages/') ? q : `packages/${q}`;
}

export interface RescoreOptions {
  /** The key set to score against. */
  keys: Keys;
  /** Restore the leading `packages/` on every answered path before matching. */
  normalize: boolean;
}

/**
 * Re-scores every session. A session that was an exact match answered the original key; a session in `notExact`
 * answered (original key minus its missing files) plus its extra files. An answer that could not be read
 * (`exact === null`) is left as it is.
 */
export function rescoreRows(rows: readonly Row[], notExact: readonly NotExact[], original: Keys, opts: RescoreOptions): Row[] {
  const detail = new Map(notExact.map((n) => [n.jobId, n]));
  return rows.map((r) => {
    if (r.exact === null) return { ...r };
    const d = detail.get(r.jobId);
    if (r.exact === false && d === undefined) throw new Error(`session ${r.jobId} is not exact and has no detail`);
    const base = original[r.questionId];
    const target = opts.keys[r.questionId];
    if (base === undefined || target === undefined) throw new Error(`no key for ${r.questionId}`);
    const answered = new Set(d === undefined ? base : [...base.filter((f) => !d.missingFiles.includes(f)), ...d.extraFiles]);
    const set = opts.normalize ? new Set([...answered].map(normalizePath)) : answered;
    const key = new Set(target);
    const matched = [...set].filter((f) => key.has(f)).length;
    const missing = key.size - matched;
    const extra = set.size - matched;
    return { ...r, exact: missing === 0 && extra === 0, matched, missing, extra };
  });
}

export interface ScenarioSummary {
  r: Record<'A-ts' | 'A-reg', number>;
  correctness: Record<Cond, number>;
  exactSessions: Record<Cond, number>;
  sums: Record<Cond, { matched: number; missing: number; extra: number }>;
  billableMeanExactOnly: Record<Cond, number>;
  premise: Premise;
  classification: Classification;
}

/** Correctness, R and the outcome class of one scoring of the sessions, by the rules of `pilot-run-plan.md`. */
export function scenarioSummary(rows: readonly Row[], keysChanged: number, premiseOverride?: Premise): ScenarioSummary {
  const ids = [...new Set(rows.map((r) => r.questionId))].sort();
  const g = questionMeans(rows, 'G', ids);
  const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
  const r = { 'A-ts': bootstrapRatio(questionMeans(rows, 'A-ts', ids), g).r, 'A-reg': bootstrapRatio(questionMeans(rows, 'A-reg', ids), g).r };
  const of = (c: Cond): Row[] => rows.filter((x) => x.condition === c);
  const correctness = Object.fromEntries(CONDS.map((c) => [c, correctnessOf(of(c))])) as Record<Cond, number>;
  const adoption = { 'A-ts': adoptionOf(of('A-ts')), 'A-reg': adoptionOf(of('A-reg')) };
  const premise = premiseOverride ?? premiseOf(mean(g));
  const classification = classify({ premise, r, correctness, adoption, calledVsG: calledVsMatchedG([...rows]), keysChanged });
  const sums = Object.fromEntries(CONDS.map((c) => [c, { matched: of(c).reduce((a, x) => a + x.matched, 0), missing: of(c).reduce((a, x) => a + x.missing, 0), extra: of(c).reduce((a, x) => a + x.extra, 0) }])) as ScenarioSummary['sums'];
  const exactSessions = Object.fromEntries(CONDS.map((c) => [c, of(c).filter((x) => x.exact === true).length])) as Record<Cond, number>;
  const billableMeanExactOnly = Object.fromEntries(CONDS.map((c) => { const e = of(c).filter((x) => x.exact === true); return [c, e.length === 0 ? 0 : mean(e.map((x) => x.billable))]; })) as Record<Cond, number>;
  return { r, correctness, exactSessions, sums, billableMeanExactOnly, premise, classification };
}

export function verdictCounts(v: readonly VerdictEntry[]): Record<Verdict, number> {
  const out: Record<Verdict, number> = { a: 0, b: 0, c: 0, d: 0 };
  for (const e of v) out[e.verdict] += 1;
  return out;
}

/** Problems: every missing and extra file of the not-exact sessions needs a verdict (a prefix-less path is covered by its prefixed file). */
export function validateVerdicts(verdicts: readonly VerdictEntry[], notExact: readonly NotExact[]): string[] {
  const problems: string[] = [];
  const has = (q: string, f: string): boolean => verdicts.some((e) => e.questionId === q && (e.file === f || e.file === normalizePath(f)));
  const seen = new Set<string>();
  for (const n of notExact) {
    for (const [side, files] of [['missing', n.missingFiles], ['extra', n.extraFiles]] as const) {
      for (const f of files) {
        const k = `${n.questionId} ${side} ${f}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!has(n.questionId, f)) problems.push(`${k} has no verdict`);
      }
    }
  }
  return problems;
}
