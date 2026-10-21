/**
 * Authors the fresh probe questions and derives their keys with the v2 oracle (read-only use).
 *
 *   node scripts/probes/author-questions.ts --corpus <git dir of the exported pinned tree> --sha <commit> --out <dir>
 *
 * Reads the 75 registered questions only to exclude their symbols and sources. A candidate for which the
 * oracle cannot produce a non-empty key is dropped. Unscored, exploratory; registers nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { deriveQuestion } from '../key-oracle/build-v2.ts';
import { buildIndex, callersOf, exportsOf, filesOf, impactOf, loadCorpus, outputPath, referencesOf } from '../key-oracle/derive-v2.ts';
import { buildQuestion, pickFresh } from './questions.ts';
import type { Candidate } from './questions.ts';

const REG = 'ev' + 'al';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SEED = 20261021;
const QUOTA = { callers: 5, references: 4, impact: 3, emit: 4 } as const;

function usedNames(): Set<string> {
  const used = new Set<string>();
  const files = [
    path.join(ROOT, 'scripts', REG, 'questions', 'gsd-core.questions.json'),
    path.join(ROOT, 'docs', REG, 'key-set-v2', 'questions.v2.json'),
    path.join(ROOT, 'scripts', REG, 'questions', 'pilot.questions.json'),
  ];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { questions: { key: { symbol?: string; source?: string } }[] };
    for (const q of parsed.questions) for (const v of [q.key.symbol, q.key.source]) if (v !== undefined) used.add(v);
  }
  return used;
}

function main(): void {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, sha: { type: 'string' }, out: { type: 'string' } } });
  if (values.corpus === undefined || values.sha === undefined || values.out === undefined) throw new Error('--corpus, --sha and --out are required');
  const idx = buildIndex(loadCorpus(values.corpus, values.sha));
  const pool: Candidate[] = [];
  for (const [rel, unit] of idx.units) {
    if (!/^src\/[^/]+\.cts$/.test(rel)) continue;
    for (const symbol of exportsOf(unit).map.keys()) {
      if (!/^[A-Za-z_$][\w$]*$/.test(symbol) || symbol.length < 8) continue;
      try {
        const calls = filesOf(callersOf(idx, rel, symbol)).length;
        if (calls >= 4 && calls <= 10) pool.push({ kind: 'callers', symbol, definedIn: rel, files: calls });
        const refs = filesOf(referencesOf(idx, rel, symbol)).length;
        if (refs >= 4 && refs <= 10) pool.push({ kind: 'references', symbol, definedIn: rel, files: refs });
        const impact = impactOf(idx, rel, symbol);
        if (impact.d2.length > 0 && impact.files.length >= 5 && impact.files.length <= 14) pool.push({ kind: 'impact', symbol, definedIn: rel, files: impact.files.length });
      } catch {
        // The oracle cannot analyse this export: drop the candidate.
      }
    }
    if (outputPath(idx, rel) !== '') {
      pool.push({ kind: 'emit', source: rel, files: 1 });
      pool.push({ kind: 'emit-consumers', source: rel, files: 3 });
    }
  }
  const used = usedNames();
  const picked: Candidate[] = [];
  const questions = [];
  const answers = [];
  // Over-pick, then keep the first candidates (per category) the oracle can derive a non-empty key for.
  const wide = pickFresh(pool, used, { callers: 40, references: 40, impact: 40, emit: 80 }, SEED);
  const left: Record<string, number> = { ...QUOTA };
  const emitKinds: string[] = [];
  for (const c of wide) {
    const cat = c.kind === 'emit-consumers' ? 'emit' : c.kind;
    if ((left[cat] ?? 0) <= 0) continue;
    // Two emit-path and two emit-consumer questions.
    if (cat === 'emit' && emitKinds.filter((k) => k === c.kind).length >= 2) continue;
    const q = buildQuestion(`pq-${String(questions.length + 1).padStart(3, '0')}`, c);
    let derived;
    try {
      derived = deriveQuestion(idx, q as never);
    } catch {
      continue;
    }
    if (derived.files.length === 0) continue;
    if (c.kind === 'emit-consumers' && (derived.files.length < 2 || derived.files.length > 15)) continue;
    left[cat] = (left[cat] ?? 0) - 1;
    if (cat === 'emit') emitKinds.push(c.kind);
    picked.push(c);
    questions.push(q);
    answers.push({
      questionId: q.id,
      kind: q.key.kind,
      abstain: false,
      items: derived.items,
      granularity: 'file',
      equality: 'exact-set',
      needles: derived.needles,
      rule: derived.rule,
    });
  }
  fs.mkdirSync(values.out, { recursive: true });
  const header = { corpusId: 'gsd-core', corpusSha: values.sha };
  fs.writeFileSync(path.join(values.out, 'probe-questions.json'), `${JSON.stringify({ ...header, note: 'Unregistered, unscored probe questions. Keys derived by the v2 oracle.', questions }, null, 1)}\n`);
  fs.writeFileSync(path.join(values.out, 'probe-answers.json'), `${JSON.stringify({ ...header, deriveVersion: 'v2', answers }, null, 1)}\n`);
  process.stdout.write(`${String(questions.length)} questions; pool ${String(pool.length)}\n`);
}

main();
