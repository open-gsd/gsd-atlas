/**
 * Generates the 16 pilot questions, their keys and the selection log from the census window and the compiler oracle.
 * UNSCORED, UNREGISTERED. Reads the pinned angular clone (never runs its code), writes three files:
 *
 *   node scripts/angular-pilot/generate.ts --repo <angular clone> --out docs/eval/angular-pilot [--exclusions <json>]
 *
 * Writes `pilot-questions.json`, `pilot-answers.json` and `selection-log.md` into `--out`. `--exclusions` is a JSON
 * array of `{ name, file, reason }` (audit findings); an excluded candidate is skipped and the next one in seeded
 * order is taken. The census window is read from `<out>/census-window.json`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import { createPilotOracle, type PilotOracle } from './oracle-lib.ts';
import { isPilotSource } from './census.ts';
import {
  QUOTA,
  SEED,
  WINDOW,
  abstainNames,
  buildFiles,
  pickQuestions,
  windowRows,
  type CensusKind,
  type CensusRow,
  type Entry,
  type Evaluation,
  type Exclusion,
  type PilotCategory,
} from './select.ts';
import type { AnswerItem } from '../eval/questions.ts';

export const ORACLE_VERSION = 'angular-pilot-1';
const RISK_PACKAGES = /^packages\/(compiler-cli|language-service)\//;

interface Picked {
  entry: Omit<Entry, 'id'>;
  keySize: number;
  riskSites: number;
}

function isTestFile(rel: string): boolean {
  return rel.endsWith('.spec.ts') || rel.endsWith('_spec.ts') || /(^|\/)test\//.test(rel);
}

function sizeProblem(n: number): string | null {
  return n >= WINDOW.minKey && n <= WINDOW.maxKey ? null : `key size ${String(n)} outside ${String(WINDOW.minKey)}..${String(WINDOW.maxKey)}`;
}

function needlesOf(name: string, texts: readonly string[]): string[] {
  return [name, ...new Set(texts.filter((t) => t !== '' && t !== name))].sort((a, b) => (a === name ? -1 : b === name ? 1 : a < b ? -1 : 1));
}

/** The key by the oracle, then the any audit (run last: it scans every file that spells the name). */
export function evaluateCandidate(oracle: PilotOracle, category: PilotCategory, row: CensusRow): Evaluation<Picked> {
  const keyed = evaluateKey(oracle, category, row);
  if (!keyed.ok) return keyed;
  const risk = oracle.anyRiskSites(row.file, row.name);
  if (RISK_PACKAGES.test(row.file) && risk.length > 0) {
    return { ok: false, reason: `any audit: ${String(risk.length)} site(s) where the name is used through an unresolved type, first ${risk[0]!.file}:${String(risk[0]!.line)}` };
  }
  keyed.value.entry.notes = { ...keyed.value.entry.notes, riskSites: risk.length };
  keyed.value.riskSites = risk.length;
  return keyed;
}

function evaluateKey(oracle: PilotOracle, category: PilotCategory, row: CensusRow): Evaluation<Picked> {
  const base = { name: row.name, kind: row.kind as CensusKind, file: row.file };
  const risk: unknown[] = [];
  const notes: Record<string, number | string> = {};
  if (category === 'callers' || category === 'references' || category === 'definition') {
    const sites = category === 'callers' ? oracle.callSites(row.file, row.name) : oracle.referenceSites(row.file, row.name);
    const files = [...new Set(sites.map((s) => s.file))].sort();
    if (category === 'definition') {
      const use = sites.find((s) => s.file !== row.file && s.text === row.name && !isTestFile(s.file));
      if (use === undefined) return { ok: false, reason: 'no plain use site outside the declaring file and the tests' };
      const def = oracle.definitionOf(row.file, row.name);
      const items: AnswerItem[] = [{ file: def.file, line: def.line, symbol: row.name }];
      return { ok: true, value: { entry: { ...base, category, items, needles: [row.name], notes: { ...notes, useSites: sites.length }, useSite: { file: use.file, line: use.line } }, keySize: 1, riskSites: risk.length } };
    }
    const bad = sizeProblem(files.length);
    if (bad !== null) return { ok: false, reason: bad };
    const items: AnswerItem[] = sites.map((s) => ({ file: s.file, line: s.line, symbol: s.enclosing }));
    return { ok: true, value: { entry: { ...base, category, items, needles: needlesOf(row.name, sites.map((s) => s.text)), notes: { ...notes, sites: sites.length }, }, keySize: files.length, riskSites: risk.length } };
  }
  if (category === 'heritage') {
    const rows = oracle.directSubtypes(row.file, row.name).filter((r) => r.cls !== '(anonymous)');
    const bad = sizeProblem(rows.length);
    if (bad !== null) return { ok: false, reason: bad };
    const items: AnswerItem[] = rows.map((r) => ({ file: r.file, line: r.line, symbol: r.cls }));
    return { ok: true, value: { entry: { ...base, category, items, needles: needlesOf(row.name, [...rows.map((r) => r.cls), ...rows.flatMap((r) => [...r.extends, ...r.implements])]), notes: { ...notes, subtypes: rows.length } }, keySize: rows.length, riskSites: risk.length } };
  }
  const impact = oracle.impactDepthTwo(row.file, row.name);
  const bad = sizeProblem(impact.files.length);
  if (bad !== null) return { ok: false, reason: bad };
  if (impact.viaCallers.length === 0) return { ok: false, reason: 'depth two adds no file beyond the direct callers' };
  const items: AnswerItem[] = impact.files.map((f) => ({ file: f }));
  return { ok: true, value: { entry: { ...base, category, items, needles: [row.name], notes: { ...notes, depth: 2, direct: impact.direct.length, viaCallers: impact.viaCallers.length } }, keySize: impact.files.length, riskSites: risk.length } };
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args[0] ?? ''} failed`);
  return r.stdout;
}

function treeHits(repo: string, name: string): number {
  const r = spawnSync('git', ['-C', repo, 'grep', '-l', '-w', '-F', '-e', name], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 1) return 0;
  if (r.status !== 0) throw new Error('git grep failed');
  return r.stdout.split('\n').filter((l) => l !== '').length;
}

const CATEGORY_ORDER: readonly (PilotCategory | 'abstain')[] = ['callers', 'references', 'heritage', 'impact', 'definition', 'abstain'];

function main(): void {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' }, exclusions: { type: 'string' } } });
  if (values.repo === undefined || values.out === undefined) throw new Error('usage: --repo <angular clone> --out <dir> [--exclusions <json>]');
  const repo = values.repo;
  const out = values.out;
  const census = JSON.parse(fs.readFileSync(path.join(out, 'census-window.json'), 'utf8')) as { pin: string; rows: CensusRow[] };
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  if (head !== census.pin) throw new Error(`the clone is at ${head}, the census pin is ${census.pin}`);
  const exclusions: Exclusion[] = values.exclusions === undefined ? [] : (JSON.parse(fs.readFileSync(values.exclusions, 'utf8')) as Exclusion[]);

  const inScope = (r: string): boolean => isPilotSource(r, { tests: true });
  const tracked = git(repo, ['ls-files', 'packages']).split('\n').filter(inScope);
  const oracle = createPilotOracle({ root: repo, tsconfig: 'packages/tsconfig.json', include: inScope, files: tracked });
  const { picked, skipped } = pickQuestions(census.rows, (category, row) => evaluateCandidate(oracle, category, row), { seed: SEED, quota: QUOTA, exclusions });

  const entries: Entry[] = [];
  const meta: { id: string; category: string; name: string; file: string; keySize: number; grep: number; changed: string; risk: number }[] = [];
  let n = 201;
  for (const category of CATEGORY_ORDER) {
    if (category === 'abstain') continue;
    for (const p of picked.filter((x) => x.category === category)) {
      const id = `p-${String(n)}`;
      n += 1;
      entries.push({ id, ...p.value.entry });
      meta.push({ id, category, name: p.row.name, file: p.row.file, keySize: p.value.keySize, grep: p.row.grepFiles, changed: p.row.fileLastChanged, risk: p.value.riskSites });
    }
  }
  const realNames = census.rows.filter((r) => r.kind === 'function').map((r) => r.name);
  const absent = abstainNames(realNames, SEED, 1, (name) => treeHits(repo, name));
  if (absent.length !== 1) throw new Error('no abstain name found');
  const abstainId = `p-${String(n)}`;
  entries.push({ id: abstainId, category: 'abstain', name: absent[0]!, kind: 'function', file: '', items: [], needles: [], notes: { treeWholeWordHits: 0 } });
  meta.push({ id: abstainId, category: 'abstain', name: absent[0]!, file: '(none)', keySize: 0, grep: 0, changed: '', risk: 0 });

  const files = buildFiles({ sha: census.pin, oracleVersion: ORACLE_VERSION, typescriptVersion: ts.version, entries });
  fs.writeFileSync(path.join(out, 'pilot-questions.json'), `${JSON.stringify(files.questions, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'pilot-answers.json'), `${JSON.stringify(files.answers, null, 2)}\n`);

  const win = windowRows(census.rows);
  const lines: string[] = [
    '# Selection log for the 16 angular pilot questions',
    '',
    '**Unscored, unregistered.** Generated by `node scripts/angular-pilot/generate.ts`; do not edit by hand.',
    '',
    `Seed ${String(SEED)}; pin \`${census.pin}\`; oracle \`${ORACLE_VERSION}\` (TypeScript ${ts.version}), spec and test files in scope.`,
    `Rule: candidates are rows of \`census-window.json\` with grep files ${String(WINDOW.minGrep)}..${String(WINDOW.maxGrep)}, another declaration of the name in a different non-test file and a declaring file last changed on or after ${WINDOW.changedSince} (${String(win.length)} of ${String(census.rows.length)} rows). Per category, candidates are taken in ascending sha256("${String(SEED)}\\0<name>@<declaring file>") order, one question per distinct name across categories, categories processed in the order callers, heritage, impact, references, definition. A candidate is skipped (and listed below) when the oracle's key has fewer than ${String(WINDOW.minKey)} or more than ${String(WINDOW.maxKey)} files (items for heritage), when it has no other file at depth two (impact), when it has no plain use site (definition), when a compiler-cli or language-service target has any identifier of that name the compiler could not bind (any audit), or when the key audit excluded it.`,
    '',
    '## Selected',
    '',
    '| id | category | name | declaring file | key size | grep files | file last changed | any-risk sites |',
    '| --- | --- | --- | --- | ---: | ---: | --- | ---: |',
    ...meta.map((m) => `| ${m.id} | ${m.category} | \`${m.name}\` | \`${m.file}\` | ${String(m.keySize)} | ${String(m.grep)} | ${m.changed} | ${String(m.risk)} |`),
    '',
    `The abstain name \`${absent[0]!}\` is a real function name with its last camel-case word replaced by a seeded suffix; \`git grep -w -F\` finds it in no tracked file of the tree.`,
    '',
    `## Skipped candidates (${String(skipped.length)})`,
    '',
    '| category | name | declaring file | reason |',
    '| --- | --- | --- | --- |',
    ...skipped.map((s) => `| ${s.category} | \`${s.name}\` | \`${s.file}\` | ${s.reason} |`),
    '',
  ];
  fs.writeFileSync(path.join(out, 'selection-log.md'), lines.join('\n'));
  oracle.dispose();
  process.stdout.write(`wrote ${String(entries.length)} questions, ${String(skipped.length)} skipped\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
