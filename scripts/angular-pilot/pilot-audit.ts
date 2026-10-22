/**
 * Supplementary audit of the 23 non-exact answers of the angular pilot (rule v2) against the keys. Unscored, unregistered.
 *
 *   node scripts/angular-pilot/pilot-audit.ts --docs <v2 docs dir>
 *       validates that every missing and extra file has a verdict, then prints the per-session table, the verdict counts
 *       and the re-scoring (original keys, corrected keys, with and without the leading `packages/`) as Markdown.
 *   node scripts/angular-pilot/pilot-audit.ts --docs <v2 docs dir> --evidence --repo <angular clone> --out <json>
 *       regenerates the audited keys with the oracle from the pinned clone and records, per audited file, the oracle's
 *       references (the file `pilot-audit-keys.json`). Slow (one TypeScript program over `packages/`); needs the clone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { Row } from './pilot-analysis.ts';
import { evidencePlan, instanceCounts, keyEntries, normalizePath, rescoreRows, scenarioSummary, validateVerdicts, verdictCounts, type Keys, type NotExact, type ScenarioSummary, type VerdictEntry } from './pilot-audit-lib.ts';

interface VerdictFile {
  pathFormatSessions: string[];
  verdicts: VerdictEntry[];
}
interface KeysFile {
  pin: string;
  defects: { questionId: string; file: string }[];
  keys: Record<string, { changed: boolean; files: string[] }>;
}
interface AnswerRec {
  questionId: string;
  granularity: string;
  items: { file?: string; line?: number; symbol?: string }[];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const short = (f: string): string => f.replace(/^packages\//, '');

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function load(docs: string): { rows: Row[]; notExact: NotExact[]; original: Keys; vf: VerdictFile; kf: KeysFile | null } {
  const rows = fs.readFileSync(path.join(docs, 'pilot', 'pilot-sessions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Row);
  const notExact = readJson<{ notExact: NotExact[] }>(path.join(docs, 'pilot', 'summary.json')).notExact;
  const answers = readJson<{ answers: AnswerRec[] }>(path.join(docs, 'pilot-answers.json')).answers;
  const original: Keys = Object.fromEntries(answers.map((a) => [a.questionId, keyEntries(a)]));
  const vf = readJson<VerdictFile>(path.join(docs, 'pilot-audit-verdicts.json'));
  const keysPath = path.join(docs, 'pilot-audit-keys.json');
  return { rows, notExact, original, vf, kf: fs.existsSync(keysPath) ? readJson<KeysFile>(keysPath) : null };
}

function correctedKeys(original: Keys, kf: KeysFile | null): { keys: Keys; changed: number } {
  const keys: Keys = { ...original };
  let changed = 0;
  for (const [q, k] of Object.entries(kf?.keys ?? {})) {
    if (!k.changed) continue;
    keys[q] = [...k.files].sort();
    changed += 1;
  }
  return { keys, changed };
}

function report(docs: string): string {
  const { rows, notExact, original, vf, kf } = load(docs);
  const problems = validateVerdicts(vf.verdicts, notExact, vf.pathFormatSessions);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const lines: string[] = [];
  const verdictOf = (q: string, f: string, side: 'missing' | 'extra'): string => vf.verdicts.find((e) => e.questionId === q && e.side === side && (e.file === f || e.file === normalizePath(f)))?.verdict ?? '?';

  lines.push('## Per-session table (23 non-exact sessions)', '', '| session | matched / missing / extra | files and verdicts |', '| --- | --- | --- |');
  const order = [...notExact].sort((a, b) => (a.questionId === b.questionId ? (a.jobId < b.jobId ? -1 : 1) : a.questionId < b.questionId ? -1 : 1));
  for (const n of order) {
    const row = rows.find((r) => r.jobId === n.jobId)!;
    const pf = vf.pathFormatSessions.includes(n.jobId);
    let text: string;
    if (pf) {
      const answered = new Set(n.extraFiles.map(normalizePath));
      const residual = n.missingFiles.filter((f) => !answered.has(f));
      text = `path format: ${String(n.extraFiles.length)} answered paths lack the leading \`packages/\` (d)${residual.length === 0 ? '; after restoring it the answer equals the key' : `; after restoring it ${String(residual.length)} key files are still missing: ${residual.map((f) => `${short(f)} (${verdictOf(n.questionId, f, 'missing')})`).join(', ')}`}`;
    } else {
      const parts = [...n.missingFiles.map((f) => `missing ${short(f)} (${verdictOf(n.questionId, f, 'missing')})`), ...n.extraFiles.map((f) => `extra ${short(f)} (${verdictOf(n.questionId, f, 'extra')})`)];
      text = parts.join('; ');
    }
    lines.push(`| ${n.jobId} | ${String(row.matched)} / ${String(row.missing)} / ${String(row.extra)} | ${text} |`);
  }

  const uniq = verdictCounts(vf.verdicts);
  const inst = instanceCounts(vf.verdicts, notExact, vf.pathFormatSessions);
  lines.push('', '## Verdict counts', '', '| basis | a: key right, session wrong | b: genuine hit the key lacks | c: session omitted a genuine key hit | d: path format or wording |', '| --- | ---: | ---: | ---: | ---: |');
  lines.push(`| per question and file (${String(vf.verdicts.length)}) | ${String(uniq.a)} | ${String(uniq.b)} | ${String(uniq.c)} | ${String(uniq.d)} |`);
  lines.push(`| per session instance (${String(inst.a + inst.b + inst.c + inst.d)}) | ${String(inst.a)} | ${String(inst.b)} | ${String(inst.c)} | ${String(inst.d)} |`);

  const cor = correctedKeys(original, kf);
  const scenarios: { label: string; keys: Keys; normalize: boolean; keysChanged: number }[] = [
    { label: 'original keys, as answered', keys: original, normalize: false, keysChanged: 1 },
    { label: 'original keys, leading packages/ restored', keys: original, normalize: true, keysChanged: 1 },
    { label: 'corrected keys, as answered', keys: cor.keys, normalize: false, keysChanged: 1 + cor.changed },
    { label: 'corrected keys, leading packages/ restored', keys: cor.keys, normalize: true, keysChanged: 1 + cor.changed },
  ];
  const results: { label: string; s: ScenarioSummary }[] = scenarios.map((sc) => ({ label: sc.label, s: scenarioSummary(rescoreRows(rows, notExact, original, { keys: sc.keys, normalize: sc.normalize }), sc.keysChanged) }));
  lines.push('', '## Re-scoring (tokens unchanged; class by the rules of pilot-run-plan.md)', '', '| scenario | correctness G | correctness A-ts | correctness A-reg | exact sessions G / A-ts / A-reg | matched / missing / extra G | A-ts | A-reg | R A-ts | R A-reg | class | flags |', '| --- | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | --- | --- |');
  for (const { label, s } of results) {
    const sum = (c: 'G' | 'A-ts' | 'A-reg'): string => `${String(s.sums[c].matched)} / ${String(s.sums[c].missing)} / ${String(s.sums[c].extra)}`;
    lines.push(`| ${label} | ${pct(s.correctness.G)} | ${pct(s.correctness['A-ts'])} | ${pct(s.correctness['A-reg'])} | ${String(s.exactSessions.G)} / ${String(s.exactSessions['A-ts'])} / ${String(s.exactSessions['A-reg'])} | ${sum('G')} | ${sum('A-ts')} | ${sum('A-reg')} | ${s.r['A-ts'].toFixed(3)} | ${s.r['A-reg'].toFixed(3)} | ${s.classification.class} | ${s.classification.flags.join('; ')} |`);
  }
  lines.push('', '| scenario | billable mean, exact-set sessions only: G | A-ts | A-reg |', '| --- | ---: | ---: | ---: |');
  for (const { label, s } of results) lines.push(`| ${label} | ${Math.round(s.billableMeanExactOnly.G).toLocaleString('en-US')} | ${Math.round(s.billableMeanExactOnly['A-ts']).toLocaleString('en-US')} | ${Math.round(s.billableMeanExactOnly['A-reg']).toLocaleString('en-US')} |`);
  return `${lines.join('\n')}\n`;
}

async function evidence(docs: string, repo: string, out: string): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const { createPilotOracle } = await import('./oracle-lib.ts');
  const { isPilotSource } = await import('./census.ts');
  const { original, vf } = load(docs);
  const questions = readJson<{ questions: { id: string; key: { kind: string; symbol: string; definedIn: string } }[] }>(path.join(docs, 'pilot-questions.json')).questions;
  const git = (args: string[]): string => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 29 }).stdout;
  const pin = git(['rev-parse', 'HEAD']).trim();
  const tracked = git(['ls-files', 'packages']).split('\n').filter((l) => isPilotSource(l, { tests: true }));
  const inScope = (r: string): boolean => isPilotSource(r, { tests: true });
  const oracle = createPilotOracle({ root: repo, tsconfig: 'packages/tsconfig.json', include: inScope, files: tracked });
  const plan = evidencePlan(vf.verdicts);
  const audited = [...new Set(plan.map((p) => p.questionId))].sort();
  const keys: KeysFile['keys'] = {};
  const evidenceRows: unknown[] = [];
  const defects: KeysFile['defects'] = [];
  for (const q of questions) {
    if (!audited.includes(q.id)) continue;
    const k = q.key;
    const sites = k.kind === 'callers' ? oracle.callSites(k.definedIn, k.symbol) : k.kind === 'references' ? oracle.referenceSites(k.definedIn, k.symbol) : [];
    const impact = k.kind === 'impact' ? oracle.impactDepthTwo(k.definedIn, k.symbol) : undefined;
    const regenerated = impact !== undefined ? [...impact.files].sort() : [...new Set(sites.map((s) => s.file))].sort();
    const keyFiles = original[q.id]!;
    const same = JSON.stringify(regenerated) === JSON.stringify(keyFiles);
    const bExtras = vf.verdicts.filter((v) => v.questionId === q.id && v.side === 'extra' && v.verdict === 'b').map((v) => normalizePath(v.file));
    for (const f of bExtras) defects.push({ questionId: q.id, file: f });
    keys[q.id] = { changed: bExtras.length > 0, files: bExtras.length > 0 ? [...new Set([...keyFiles, ...bExtras])].sort() : keyFiles };
    const refs = oracle.classifiedReferences(k.definedIn, k.symbol);
    evidenceRows.push({ questionId: q.id, symbol: k.symbol, kind: k.kind, regeneratedFileCount: regenerated.length, keyFileCount: keyFiles.length, regeneratedEqualsKey: same, ...(impact === undefined ? {} : { direct: impact.direct, viaCallers: impact.viaCallers }) });
    for (const p of plan.filter((x) => x.questionId === q.id)) {
      evidenceRows.push({
        questionId: q.id,
        file: p.file,
        verdicts: vf.verdicts.filter((v) => v.questionId === q.id && normalizePath(v.file) === p.file).map((v) => `${v.side}:${v.verdict}`),
        inTrackedScope: tracked.includes(p.file),
        inKey: keyFiles.includes(p.file),
        inOracleSet: regenerated.includes(p.file),
        references: refs.filter((r) => r.file === p.file).map((r) => ({ line: r.line, role: r.role, typeOnly: r.typeOnly, enclosing: r.enclosing, text: r.text })),
      });
    }
  }
  oracle.dispose();
  const doc = { note: 'Supplementary audit of the 23 non-exact pilot sessions. Unscored, unregistered. Proposed corrected keys: a key is changed only when a verdict b (a genuine hit the key lacks) exists; none does, so every audited key is unchanged. Evidence is the regeneration of each audited key with the oracle of the pinned clone and the oracle references of every audited file.', pin, defects, keys, evidence: evidenceRows };
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { docs: { type: 'string' }, evidence: { type: 'boolean', default: false }, repo: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (values.docs === undefined) throw new Error('usage: --docs <v2 docs dir> [--evidence --repo <clone> --out <json>]');
  if (values.evidence === true) {
    if (values.repo === undefined || values.out === undefined) throw new Error('--evidence needs --repo and --out');
    await evidence(values.docs, values.repo, values.out);
    return;
  }
  process.stdout.write(report(values.docs));
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
