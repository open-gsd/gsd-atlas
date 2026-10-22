/**
 * Generates the 16 rule-v2 questions, their keys and the selection log (UNSCORED, UNREGISTERED). Reads the pinned
 * angular clone (never runs its code):
 *
 *   node scripts/angular-pilot/generate-v2.ts --repo <clone> --out docs/eval/angular-pilot/v2 [--exclusions <json>] [--roles <json>]
 *
 * Reads `<out>/census-v2.json` (see census-v2.ts). `--exclusions` is `[{ name, file, reason }]` (audit findings);
 * `--roles` maps `<name>@<declaring file>` to the hand-written role description. When a selected question has no role
 * the run writes `<out>/roles-needed.json` and stops with status 2: roles never influence the selection.
 * Writes `pilot-questions.json`, `pilot-answers.json` and `selection-log.md`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import { isPilotSource } from './census.ts';
import { createPilotOracle, type PilotOracle } from './oracle-lib.ts';
import { abstainNames, type CensusKind, type Evaluation, type Exclusion, type PilotCategory } from './select.ts';
import { PICK_ORDER_V2, QUOTA_V2, SEED_V2, buildFilesV2, keyBounds, pickQuestionsV2, tierRows, type CensusRowV2, type EntryV2, type Tier } from './select-v2.ts';
import type { AnswerItem } from '../eval/questions.ts';

export const ORACLE_VERSION = 'angular-pilot-1';

interface Evaluated {
  entry: Omit<EntryV2, 'id' | 'role'>;
  keySize: number;
  riskSites: number;
}

function isTestFile(rel: string): boolean {
  return rel.endsWith('.spec.ts') || rel.endsWith('_spec.ts') || /(^|\/)test\//.test(rel);
}

function needlesOf(name: string, texts: readonly string[]): string[] {
  return [name, ...new Set(texts.filter((t) => t !== '' && t !== name))].sort((a, b) => (a === name ? -1 : b === name ? 1 : a < b ? -1 : 1));
}

function sizeProblem(n: number, tier: Tier, category: PilotCategory): string | null {
  const b = keyBounds(tier, category);
  if (b === null) return null;
  return n >= b.min && n <= b.max ? null : `key size ${String(n)} outside ${String(b.min)}..${String(b.max)} (tier ${String(tier)})`;
}

/** The key by the oracle under the tier's bounds, then the any audit (run last; any package, a single flagged site skips the candidate). */
export function evaluateCandidateV2(oracle: PilotOracle, category: PilotCategory, row: CensusRowV2, tier: Tier): Evaluation<Evaluated> {
  const keyed = evaluateKey(oracle, category, row, tier);
  if (!keyed.ok) return keyed;
  const risk = oracle.anyRiskSites(row.file, row.name);
  if (risk.length > 0) return { ok: false, reason: `any audit: ${String(risk.length)} site(s) where the name is used through an unresolved type, first ${risk[0]!.file}:${String(risk[0]!.line)}` };
  keyed.value.entry.notes = { ...keyed.value.entry.notes, riskSites: 0, tier };
  return keyed;
}

function evaluateKey(oracle: PilotOracle, category: PilotCategory, row: CensusRowV2, tier: Tier): Evaluation<Evaluated> {
  const base = { name: row.name, kind: row.kind as CensusKind, file: row.file, otherDeclFiles: row.otherDeclFiles, otherKinds: row.otherKinds };
  if (category === 'callers' || category === 'references' || category === 'definition') {
    const sites = category === 'callers' ? oracle.callSites(row.file, row.name) : oracle.referenceSites(row.file, row.name);
    const files = [...new Set(sites.map((s) => s.file))].sort();
    if (category === 'definition') {
      const use = sites.find((s) => s.file !== row.file && s.text === row.name && !isTestFile(s.file));
      if (use === undefined) return { ok: false, reason: 'no plain use site outside the declaring file and the tests' };
      const def = oracle.definitionOf(row.file, row.name);
      const items: AnswerItem[] = [{ file: def.file, line: def.line, symbol: row.name }];
      return { ok: true, value: { entry: { ...base, category, items, needles: [row.name], notes: { useSites: sites.length }, useSite: { file: use.file, line: use.line } }, keySize: 1, riskSites: 0 } };
    }
    const bad = sizeProblem(files.length, tier, category);
    if (bad !== null) return { ok: false, reason: bad };
    const items: AnswerItem[] = sites.map((s) => ({ file: s.file, line: s.line, symbol: s.enclosing }));
    return { ok: true, value: { entry: { ...base, category, items, needles: needlesOf(row.name, sites.map((s) => s.text)), notes: { sites: sites.length } }, keySize: files.length, riskSites: 0 } };
  }
  if (category === 'heritage') {
    const rows = oracle.directSubtypes(row.file, row.name).filter((r) => r.cls !== '(anonymous)');
    const bad = sizeProblem(rows.length, tier, category);
    if (bad !== null) return { ok: false, reason: bad };
    const items: AnswerItem[] = rows.map((r) => ({ file: r.file, line: r.line, symbol: r.cls }));
    return { ok: true, value: { entry: { ...base, category, items, needles: needlesOf(row.name, [...rows.map((r) => r.cls), ...rows.flatMap((r) => [...r.extends, ...r.implements])]), notes: { subtypes: rows.length } }, keySize: rows.length, riskSites: 0 } };
  }
  const impact = oracle.impactDepthTwo(row.file, row.name);
  const bad = sizeProblem(impact.files.length, tier, category);
  if (bad !== null) return { ok: false, reason: bad };
  if (impact.viaCallers.length === 0) return { ok: false, reason: 'depth two adds no file beyond the direct callers' };
  const items: AnswerItem[] = impact.files.map((f) => ({ file: f }));
  return { ok: true, value: { entry: { ...base, category, items, needles: [row.name], notes: { depth: 2, direct: impact.direct.length, viaCallers: impact.viaCallers.length } }, keySize: impact.files.length, riskSites: 0 } };
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

const CATEGORY_ORDER: readonly PilotCategory[] = ['callers', 'references', 'heritage', 'impact', 'definition'];

function main(): void {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' }, exclusions: { type: 'string' }, roles: { type: 'string' } } });
  if (values.repo === undefined || values.out === undefined) throw new Error('usage: --repo <clone> --out <dir> [--exclusions <json>] [--roles <json>]');
  const repo = values.repo;
  const out = values.out;
  const census = JSON.parse(fs.readFileSync(path.join(out, 'census-v2.json'), 'utf8')) as { pin: string; rows: CensusRowV2[] };
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  if (head !== census.pin) throw new Error(`the clone is at ${head}, the census pin is ${census.pin}`);
  const exclusions: Exclusion[] = values.exclusions === undefined ? [] : (JSON.parse(fs.readFileSync(values.exclusions, 'utf8')) as Exclusion[]);
  const roles: Record<string, string> = values.roles === undefined ? {} : (JSON.parse(fs.readFileSync(values.roles, 'utf8')) as Record<string, string>);

  const inScope = (r: string): boolean => isPilotSource(r, { tests: true });
  const tracked = git(repo, ['ls-files', 'packages']).split('\n').filter(inScope);
  const oracle = createPilotOracle({ root: repo, tsconfig: 'packages/tsconfig.json', include: inScope, files: tracked });
  let result: ReturnType<typeof pickQuestionsV2<Evaluated>>;
  try {
    result = pickQuestionsV2(census.rows, (category, row, tier) => evaluateCandidateV2(oracle, category, row, tier), { seed: SEED_V2, quota: QUOTA_V2, exclusions });
  } catch (error) {
    const partial = error as { skipped?: { category: string; tier: number; name: string; file: string; reason: string }[] };
    for (const s of partial.skipped ?? []) process.stderr.write(`skip ${s.category} tier ${String(s.tier)} ${s.name}@${s.file}: ${s.reason}\n`);
    throw error;
  }
  const { picked, skipped } = result;

  const entries: EntryV2[] = [];
  const meta: { id: string; category: string; tier: number; name: string; file: string; keySize: number; grep: number; other: number; changed: string }[] = [];
  const needed: { key: string; category: string; kind: string; otherKinds: string[]; keySize: number }[] = [];
  let n = 301;
  for (const category of CATEGORY_ORDER) {
    for (const p of picked.filter((x) => x.category === category)) {
      const id = `p-${String(n)}`;
      n += 1;
      const key = `${p.row.name}@${p.row.file}`;
      const role = roles[key] ?? '';
      if (role === '' && category !== 'definition') needed.push({ key, category, kind: p.row.kind, otherKinds: p.row.otherKinds, keySize: p.value.keySize });
      entries.push({ id, ...p.value.entry, role });
      meta.push({ id, category, tier: p.tier, name: p.row.name, file: p.row.file, keySize: p.value.keySize, grep: p.row.grepFiles, other: p.row.otherDeclFiles, changed: p.row.fileLastChanged });
    }
  }
  const realNames = census.rows.filter((r) => r.kind === 'function').map((r) => r.name);
  const absent = abstainNames(realNames, SEED_V2, 1, (name) => treeHits(repo, name));
  if (absent.length !== 1) throw new Error('no abstain name found');
  const abstainId = `p-${String(n)}`;
  entries.push({ id: abstainId, category: 'abstain', name: absent[0]!, kind: 'function', file: '', role: '', otherDeclFiles: 0, otherKinds: [], items: [], needles: [], notes: { treeWholeWordHits: 0 } });
  meta.push({ id: abstainId, category: 'abstain', tier: 0, name: absent[0]!, file: '(none)', keySize: 0, grep: 0, other: 0, changed: '' });

  const selected = [`## Selected`, '', '| id | category | tier | name | declaring file | key size | grep files (whole tree) | other same-named declaring files | grep files per key file | file last changed |', '| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...meta.map((m) => `| ${m.id} | ${m.category} | ${m.tier === 0 ? '-' : String(m.tier)} | \`${m.name}\` | \`${m.file}\` | ${String(m.keySize)} | ${String(m.grep)} | ${String(m.other)} | ${m.keySize > 0 ? (m.grep / m.keySize).toFixed(1) : '-'} | ${m.changed} |`)];
  const win1 = tierRows(census.rows, 1).length;
  const win2 = tierRows(census.rows, 2).length;
  const lines: string[] = [
    '# Selection log for the 16 rule-v2 angular pilot questions',
    '',
    '**Unscored, unregistered.** Generated by `node scripts/angular-pilot/generate-v2.ts`; do not edit by hand. Rule: `rule-v2.md` (with Amendment 1).',
    '',
    `Seed ${String(SEED_V2)}; pin \`${census.pin}\`; oracle \`${ORACLE_VERSION}\` (TypeScript ${ts.version}), spec and test files in scope. Census rows: ${String(census.rows.length)}; tier-1 rows ${String(win1)}, tier-2 rows ${String(win2)}. Candidates are taken per category in the order ${PICK_ORDER_V2.join(', ')}, tier 1 first then tier 2, each in ascending sha256("${String(SEED_V2)}\\0<name>@<declaring file>") order, one question per distinct name across categories. A candidate is skipped when its key size is outside the tier's bounds, depth two adds no file (impact), there is no plain use site (definition), the any audit flags at least one site (any package), or the key audit excluded it.`,
    '',
    ...selected,
    '',
    `The abstain name \`${absent[0]!}\` is a real function name with its last camel-case word replaced by a seeded suffix; \`git grep -w -F\` finds it in no tracked file of the tree.`,
    '',
    `## Skipped candidates (${String(skipped.length)})`,
    '',
    '| category | tier | name | declaring file | reason |',
    '| --- | ---: | --- | --- | --- |',
    ...skipped.map((s) => `| ${s.category} | ${String(s.tier)} | \`${s.name}\` | \`${s.file}\` | ${s.reason} |`),
    '',
  ];
  fs.writeFileSync(path.join(out, 'selection-log.md'), lines.join('\n'));
  oracle.dispose();
  if (needed.length > 0) {
    // the oracle's selected keys, for the first reader, before any role exists (not a registered file)
    fs.writeFileSync(path.join(out, 'keys-draft.json'), `${JSON.stringify(entries.map((e) => ({ id: e.id, category: e.category, name: e.name, file: e.file, notes: e.notes, items: e.items, useSite: e.useSite })), null, 1)}\n`);
    fs.writeFileSync(path.join(out, 'roles-needed.json'), `${JSON.stringify(needed, null, 2)}\n`);
    process.stdout.write(`selection done (${String(picked.length)} picked, ${String(skipped.length)} skipped); ${String(needed.length)} role(s) missing, see roles-needed.json\n`);
    process.exit(2);
  }
  const files = buildFilesV2({ sha: census.pin, oracleVersion: ORACLE_VERSION, typescriptVersion: ts.version, entries });
  fs.writeFileSync(path.join(out, 'pilot-questions.json'), `${JSON.stringify(files.questions, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'pilot-answers.json'), `${JSON.stringify(files.answers, null, 2)}\n`);
  process.stdout.write(`wrote ${String(entries.length)} questions, ${String(skipped.length)} skipped\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
