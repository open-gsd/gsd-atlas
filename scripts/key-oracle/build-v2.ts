/**
 * Builds the v2 proposal files from the key oracle (derive-v2.ts). Read-only on the corpus and on
 * the registered files; writes only under docs/<registered-dir>/key-set-v2/.
 *
 * The registered question loader and answer schema are imported (never edited) to validate the output.
 * The directory name of the registered material is assembled at runtime so that this file does not
 * hard-code a path into it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CORPUS_SHA,
  DERIVE_VERSION,
  adrCiters,
  adrOf,
  aliasesOf,
  buildIndex,
  callersOf,
  cmp,
  consumersOf,
  declarationsNamed,
  filesOf,
  fullyDynamicRequires,
  globalUnresolvedStats,
  heritageSubtypes,
  impactOf,
  loadCorpus,
  outputPath,
  referencesOf,
  sitesOf,
  stringMentions,
  stringSpellings,
  symbolAbsent,
  unresolvedNear,
} from './derive-v2.ts';
import type { ConsumerMode, Index } from './derive-v2.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REGISTERED = 'ev' + 'al';
export const FROZEN_DIR = path.join(ROOT, 'scripts', REGISTERED, 'questions');
export const OUT_DIR = path.join(ROOT, 'docs', REGISTERED, 'key-set-v2');
export const DEFAULT_STREAMS =
  '/private/tmp/claude-501/-Users-trekkie-projects-gsd-atlas/5a2ac1d7-b4df-4469-8d0c-4ad3173eae03/scratchpad/fetch-cleanroom/cleanroom-run/streams';

// ---------------------------------------------------------------------------------------------------
// Shapes (the frozen zod schema is the authority; these are for readability only)
// ---------------------------------------------------------------------------------------------------

export interface Item {
  file?: string;
  line?: number;
  symbol?: string;
  adr?: number;
  resolved?: boolean;
  detail?: string;
}
export interface Question {
  id: string;
  category: string;
  text: string;
  key: Record<string, unknown> & { kind: string; granularity: string; symbol?: string; definedIn?: string; source?: string; number?: number; depth?: number; probe?: Record<string, unknown>; lib?: boolean; direction?: string };
}
export interface Answer {
  questionId: string;
  kind: string;
  abstain: boolean;
  items: Item[];
  granularity: string;
  equality: string;
  needles: string[];
  unexplained: unknown[];
  notes: Record<string, number | string>;
  oracleVersion: string;
}

/** Classes from docs/<registered>/key-audit.md. The 61 ids not listed are `consistent`. */
export const AUDIT_CLASS: Readonly<Record<string, string>> = {
  'q-001': 'key-likely-incomplete',
  'q-008': 'key-likely-incomplete',
  'q-010': 'key-likely-incomplete',
  'q-011': 'key-likely-incomplete',
  'q-014': 'key-likely-incomplete',
  'q-024': 'key-likely-incomplete',
  'q-028': 'key-likely-incomplete',
  'q-036': 'key-likely-incomplete',
  'q-065': 'key-likely-incomplete',
  'q-069': 'key-likely-incomplete',
  'q-012': 'ambiguous-wording',
  'q-022': 'ambiguous-wording',
  'q-030': 'ambiguous-wording',
  'q-067': 'ambiguous-wording',
};
export const NON_CONSISTENT: readonly string[] = Object.keys(AUDIT_CLASS).sort(cmp);

export type Status = 'corrected' | 'reworded+corrected' | 'needs-decision' | 'carried';

/** Wording added to a question text, before the closing "Give your answer ..." sentence. */
const REWORD: Readonly<Record<string, string>> = {
  'q-012':
    'A string literal that merely spells the name, such as a key in a data table or an index into an object, is not a use; only identifiers bound to the export count.',
  'q-022':
    'Count a `require(...)` call expression whose path resolves statically, including a `path.join` of string literals and `const` strings. An `import x = require(\'./m.cjs\')` declaration does not count as a call to `require`, and text inside a string handed to a child process does not count.',
  'q-024':
    "An `import x = require('./m.cjs')` declaration in a `.cts` file counts as loading the module with `require`, and so does a `require(...)` call whose path resolves statically (a string literal, or a `path.join` of string literals and `const` strings). ES `import` statements, `import()` and text inside strings do not count.",
  'q-028':
    "An `import x = require('./m.cjs')` declaration in a `.cts` file counts as loading the module with `require`, and so does a `require(...)` call whose path resolves statically (a string literal, or a `path.join` of string literals and `const` strings). ES `import` statements, `import()` and text inside strings do not count.",
  'q-065':
    "An `import x = require('./m.cjs')` declaration in a `.cts` file counts as loading the module with `require`, and so does a `require(...)` call whose path resolves statically (a string literal, or a `path.join` of string literals and `const` strings). ES `import` statements, `import()` and text inside strings do not count.",
  'q-030':
    'A comment is on the symbol only when it is attached: the contiguous block of comments directly above the declaration with no blank line between the block and the declaration, or a comment inside its body. A comment separated from the declaration by a blank line is not attached.',
  'q-067':
    'A zero-padded spelling such as `ADR-0005` counts as ADR-5.',
};

export const STATUS: Readonly<Record<string, Status>> = {
  'q-001': 'corrected',
  'q-008': 'corrected',
  'q-010': 'corrected',
  'q-011': 'corrected',
  'q-014': 'corrected',
  'q-036': 'corrected',
  'q-069': 'corrected',
  'q-024': 'reworded+corrected',
  'q-028': 'reworded+corrected',
  'q-065': 'reworded+corrected',
  'q-012': 'needs-decision',
  'q-022': 'needs-decision',
  'q-030': 'needs-decision',
  'q-067': 'needs-decision',
};

const TRAILER = ' Give your answer in the required JSON form.';

export function reword(id: string, text: string): string {
  const add = REWORD[id];
  if (add === undefined) return text;
  if (!text.endsWith(TRAILER)) throw new Error(`${id}: unexpected question text ending`);
  return text.slice(0, text.length - TRAILER.length) + ' ' + add + TRAILER;
}

// ---------------------------------------------------------------------------------------------------
// Derivation per question
// ---------------------------------------------------------------------------------------------------

export interface Derived {
  id: string;
  kind: string;
  granularity: string;
  rule: string;
  files: string[];
  items: Item[];
  evidence: Map<string, string>;
  needles: string[];
  notes: string[];
  alt?: { label: string; files: string[]; evidence: Map<string, string> };
  excluded?: string[];
}

function itemsFromSites(sites: { file: string; line: number; symbol?: string }[]): Item[] {
  return sites.map((s) => ({ file: s.file, line: s.line, symbol: s.symbol as string }));
}

function evidenceFromSites(sites: { file: string; line: number }[], what: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sites) if (!m.has(s.file)) m.set(s.file, `${s.file}:${s.line} ${what}`);
  return m;
}

function emitMode(q: Question): ConsumerMode {
  return q.text.includes('call `require`') ? 'calls' : 'load';
}

function sortedItems(items: Item[]): Item[] {
  return items.sort((a, b) => cmp(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || (a.adr ?? 0) - (b.adr ?? 0));
}

export function deriveQuestion(idx: Index, q: Question): Derived {
  const k = q.key;
  const base = { id: q.id, kind: k.kind, granularity: k.granularity, notes: [] as string[], needles: [] as string[] };
  switch (k.kind) {
    case 'callers': {
      const uses = callersOf(idx, k.definedIn as string, k.symbol as string);
      const sites = sitesOf(uses);
      return {
        ...base,
        rule: 'R1',
        files: filesOf(uses),
        items: itemsFromSites(sites),
        evidence: evidenceFromSites(sites, 'call'),
        needles: [k.symbol as string, ...aliasesOf(uses, k.symbol as string)],
      };
    }
    case 'references': {
      const uses = referencesOf(idx, k.definedIn as string, k.symbol as string);
      const sites = sitesOf(uses);
      const files = filesOf(uses);
      const d: Derived = {
        ...base,
        rule: 'R2',
        files,
        items: itemsFromSites(sites),
        evidence: evidenceFromSites(sites, 'use'),
        needles: [k.symbol as string, ...aliasesOf(uses, k.symbol as string)],
      };
      const strings = stringSpellings(idx, k.definedIn as string, k.symbol as string).filter((s) => !files.includes(s.file));
      if (strings.length > 0) {
        d.alt = {
          label: 'string literals that spell the name count as references',
          files: [...files, ...new Set(strings.map((s) => s.file))].sort(cmp),
          evidence: evidenceFromSites(strings, 'string literal'),
        };
      }
      return d;
    }
    case 'emit': {
      const out = outputPath(idx, k.source as string);
      return { ...base, rule: 'R3', files: [out], items: [{ file: out }], evidence: new Map([[out, 'outDir + rootDir mapping of tsconfig.build.json']]), needles: [path.posix.basename(out)] };
    }
    case 'emit-consumers': {
      const mode = emitMode(q);
      const r = consumersOf(idx, k.source as string, mode);
      const other = consumersOf(idx, k.source as string, mode === 'calls' ? 'load' : 'calls');
      const files = [...new Set(r.hits.map((h) => h.file))].sort(cmp);
      const d: Derived = {
        ...base,
        rule: `R4-${mode}`,
        files,
        items: r.hits.map((h) => ({ file: h.file, line: h.line })),
        evidence: new Map(r.hits.map((h) => [h.file, `${h.file}:${h.line} ${h.form}${h.match === 'exact' ? '' : ' (' + h.match + ')'}`] as const).reverse()),
        needles: [path.posix.basename(outputPath(idx, k.source as string)), 'require'],
        excluded: r.excluded.map((e) => `${e.file}:${e.line} ${e.form}`),
      };
      const otherFiles = [...new Set(other.hits.map((h) => h.file))].sort(cmp);
      if (otherFiles.join('|') !== files.join('|')) {
        d.alt = {
          label: mode === 'calls' ? '`import x = require()` declarations count as `require`' : 'only `require(...)` calls count',
          files: otherFiles,
          evidence: new Map(other.hits.map((h) => [h.file, `${h.file}:${h.line} ${h.form}`] as const).reverse()),
        };
      }
      return d;
    }
    case 'impact': {
      const r = impactOf(idx, k.definedIn as string, k.symbol as string);
      const evidence = new Map<string, string>();
      for (const f of r.d1) if (f !== k.definedIn) evidence.set(f, `${f} direct call`);
      for (const [f, v] of r.via) if (!evidence.has(f)) evidence.set(f, `${f}:${v.line} ${v.name} (exported by ${v.intermediate})`);
      return {
        ...base,
        rule: 'R5',
        files: r.files,
        items: r.files.map((file) => ({ file })),
        evidence,
        needles: [k.symbol as string],
        notes: r.spreadWarnings.length > 0 ? [`intermediate modules with spread exports (not followed): ${r.spreadWarnings.join(', ')}`] : [],
      };
    }
    case 'adr-citers': {
      const n = k.number as number;
      const lit = adrCiters(idx, n, true);
      const padded = adrCiters(idx, n, false);
      // Rule R6: digits as written in the question. When that gives an empty key the zero-padded reading is
      // the only one a positive key can express (q-067), and the question wording says so.
      const usePadded = lit.length === 0;
      const sites = usePadded ? padded : lit;
      const d: Derived = {
        ...base,
        rule: 'R6',
        files: [...new Set(sites.map((s) => s.file))].sort(cmp),
        items: sites.map((s) => ({ file: s.file, line: s.line })),
        evidence: evidenceFromSites(sites, `ADR-${n} comment${usePadded ? ' (zero padded)' : ''}`),
        needles: ['ADR'],
      };
      const litFiles = [...new Set(lit.map((s) => s.file))].sort(cmp);
      const padFiles = [...new Set(padded.map((s) => s.file))].sort(cmp);
      if (litFiles.join('|') !== padFiles.join('|')) {
        d.notes.push(`digits exactly as asked: ${litFiles.length} files; with zero padding accepted: ${padFiles.length} files`);
        d.alt = usePadded
          ? { label: 'digits exactly as written in the question (no zero padding): empty key', files: litFiles, evidence: new Map() }
          : { label: 'zero-padded spellings also count', files: padFiles, evidence: evidenceFromSites(padded, 'padded comment') };
      }
      return d;
    }
    case 'adr-of': {
      const res = adrOf(idx, k.definedIn as string, k.symbol as string, 'attached');
      const trivia = adrOf(idx, k.definedIn as string, k.symbol as string, 'trivia');
      const toItems = (rs: typeof res): Item[] => {
        const out: Item[] = [];
        for (const r of rs) {
          if (r.files.length === 0) out.push({ adr: r.number, resolved: false, ...(r.detail ? { detail: r.detail } : {}) });
          for (const f of r.files) out.push({ file: f, adr: r.number, resolved: true, ...(r.detail ? { detail: r.detail } : {}) });
        }
        return out;
      };
      const items = toItems(res);
      const files = items.filter((i) => i.file !== undefined).map((i) => i.file as string).sort(cmp);
      const tfiles = toItems(trivia).filter((i) => i.file !== undefined).map((i) => i.file as string).sort(cmp);
      const d: Derived = { ...base, rule: 'R7', files, items, evidence: new Map(files.map((f) => [f, `comment attached to ${k.symbol} cites it`] as const)), needles: ['ADR'] };
      if (files.join('|') !== tfiles.join('|')) {
        d.alt = { label: 'any comment in the leading trivia of the declaration counts (banner comment above a blank line)', files: tfiles, evidence: new Map(tfiles.map((f) => [f, 'leading trivia comment'] as const)) };
      }
      return d;
    }
    case 'heritage': {
      const found = heritageSubtypes(idx, k.symbol as string);
      return { ...base, rule: 'check-heritage', files: [...new Set(found.map((f) => f.file))].sort(cmp), items: found.map((f) => ({ file: f.file, line: f.line, symbol: f.symbol })), evidence: new Map(), needles: [k.symbol as string] };
    }
    case 'definition': {
      const found = declarationsNamed(idx, k.symbol as string, (k.definedIn as string | undefined)?.replace(/[^/]*$/, '') ?? 'src/');
      return { ...base, rule: 'check-definition', files: [...new Set(found.map((f) => f.file))].sort(cmp), items: found.map((f) => ({ file: f.file, line: f.line, symbol: k.symbol as string })), evidence: new Map(), needles: [k.symbol as string] };
    }
    case 'abstain': {
      const probe = k.probe as { symbol?: string; adrNoFile?: number };
      const absent = probe.symbol !== undefined ? symbolAbsent(idx, probe.symbol) : !idx.adrFiles.has(probe.adrNoFile as number);
      return { ...base, rule: 'check-abstain', files: absent ? [] : ['<present>'], items: [], evidence: new Map(), needles: [] };
    }
    default:
      throw new Error(`unknown kind ${k.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Comparison with a frozen key
// ---------------------------------------------------------------------------------------------------

export function frozenFiles(a: Answer): string[] {
  return [...new Set(a.items.filter((i) => i.file !== undefined).map((i) => i.file as string))].sort(cmp);
}

export interface Comparison {
  agree: boolean;
  added: string[];
  removed: string[];
}

export function compare(q: Question, d: Derived, a: Answer): Comparison {
  const g = q.key.granularity;
  if (q.key.kind === 'abstain') {
    return { agree: d.files.length === 0 && a.items.length === 0, added: d.files, removed: [] };
  }
  if (g === 'file+symbol') {
    const mine = new Set(d.items.map((i) => `${i.file}|${i.symbol}`));
    const theirs = new Set(a.items.map((i) => `${i.file}|${i.symbol}`));
    const added = [...mine].filter((x) => !theirs.has(x)).sort(cmp);
    const removed = [...theirs].filter((x) => !mine.has(x)).sort(cmp);
    return { agree: added.length === 0 && removed.length === 0, added, removed };
  }
  if (g === 'file+line') {
    const added: string[] = [];
    const removed: string[] = [];
    const rest = [...a.items];
    for (const m of d.items) {
      const j = rest.findIndex((t) => t.file === m.file && Math.abs((t.line ?? 0) - (m.line ?? 0)) <= 2);
      if (j < 0) added.push(`${m.file}:${m.line}`);
      else rest.splice(j, 1);
    }
    for (const t of rest) removed.push(`${t.file}:${t.line}`);
    return { agree: added.length === 0 && removed.length === 0, added, removed };
  }
  const mine = d.files;
  const theirs = frozenFiles(a);
  const added = mine.filter((f) => !theirs.includes(f));
  const removed = theirs.filter((f) => !mine.includes(f));
  return { agree: added.length === 0 && removed.length === 0, added, removed };
}

// ---------------------------------------------------------------------------------------------------
// Sessions (exploratory)
// ---------------------------------------------------------------------------------------------------

export interface SessionAnswer {
  arm: string;
  run: number;
  answer: string;
  files: string[];
}

export function readSessionAnswer(file: string): { answer: string; files: string[] } | undefined {
  let last: { answer?: string; items?: { file?: string }[] } | undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let m: { message?: { content?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as { type?: string; name?: string; input?: unknown }[]) {
      if (b.type === 'tool_use' && b.name === 'StructuredOutput') last = b.input as typeof last;
    }
  }
  if (last === undefined) return undefined;
  const files = [...new Set((last.items ?? []).map((i) => i.file).filter((f): f is string => typeof f === 'string'))].sort(cmp);
  return { answer: last.answer ?? 'unknown', files };
}

export function sessionsFor(dir: string, id: string): SessionAnswer[] {
  const out: SessionAnswer[] = [];
  for (const arm of ['atlas', 'grep']) {
    for (const run of [1, 2, 3]) {
      const f = path.join(dir, `${id}.${arm}.${run}.a1.jsonl`);
      if (!fs.existsSync(f)) continue;
      const a = readSessionAnswer(f);
      if (a !== undefined) out.push({ arm, run, ...a });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The whole computation
// ---------------------------------------------------------------------------------------------------

export interface V2 {
  index: Index;
  frozenQuestions: { corpusId: string; corpusSha: string; questions: Question[] };
  frozenAnswers: { oracleVersion: string; repoSha: string; preparedRecord?: unknown; answers: Answer[] };
  questionsV2: { corpusId: string; corpusSha: string; questions: Question[] };
  answersV2: { oracleVersion: string; repoSha: string; preparedRecord?: unknown; answers: Answer[] };
  derived: Map<string, Derived>;
  comparisons: Map<string, Comparison>;
  status: Map<string, Status>;
}

export async function loadFrozenValidated(): Promise<{
  questions: V2['frozenQuestions'];
  answers: V2['frozenAnswers'];
  schemas: { QuestionFileSchema: { parse(x: unknown): unknown }; AnswerFileSchema: { parse(x: unknown): unknown } };
}> {
  const mod = (await import(pathToFileURL(path.join(ROOT, 'scripts', REGISTERED, 'questions.ts')).href)) as {
    QuestionFileSchema: { parse(x: unknown): unknown };
    AnswerFileSchema: { parse(x: unknown): unknown };
  };
  const q = JSON.parse(fs.readFileSync(path.join(FROZEN_DIR, 'gsd-core.questions.json'), 'utf8').replace(/^﻿/, ''));
  const a = JSON.parse(fs.readFileSync(path.join(FROZEN_DIR, 'gsd-core.answers.json'), 'utf8').replace(/^﻿/, ''));
  mod.QuestionFileSchema.parse(q);
  mod.AnswerFileSchema.parse(a);
  return { questions: q, answers: a, schemas: mod };
}

export async function computeV2(repo?: string): Promise<V2> {
  const { questions: fq, answers: fa, schemas } = await loadFrozenValidated();
  const corpus = loadCorpus(repo);
  if (corpus.sha !== fq.corpusSha || corpus.sha !== CORPUS_SHA) throw new Error('corpus sha mismatch');
  const index = buildIndex(corpus);
  const frozenById = new Map(fa.answers.map((a) => [a.questionId, a] as const));
  const derived = new Map<string, Derived>();
  const comparisons = new Map<string, Comparison>();
  const status = new Map<string, Status>();
  const qv2: Question[] = [];
  const av2: Answer[] = [];
  for (const q of fq.questions) {
    const frozen = frozenById.get(q.id) as Answer;
    const d = deriveQuestion(index, q);
    derived.set(q.id, d);
    const cmpResult = compare(q, d, frozen);
    comparisons.set(q.id, cmpResult);
    const st: Status = STATUS[q.id] ?? 'carried';
    status.set(q.id, st);
    if (st === 'carried') {
      qv2.push(q);
      av2.push(frozen);
      continue;
    }
    qv2.push({ ...q, text: reword(q.id, q.text) });
    const needles = [...new Set([...frozen.needles, ...d.needles])];
    av2.push({
      ...frozen,
      items: sortedItems(d.items.map((i) => ({ ...i }))),
      needles,
      notes: { ...frozen.notes, v2Rule: d.rule, v2Status: st },
      oracleVersion: DERIVE_VERSION,
    });
  }
  const questionsV2 = { corpusId: fq.corpusId, corpusSha: fq.corpusSha, questions: qv2 };
  const answersV2: V2['answersV2'] = { oracleVersion: DERIVE_VERSION, repoSha: fa.repoSha, answers: av2 };
  if (fa.preparedRecord !== undefined) answersV2.preparedRecord = fa.preparedRecord;
  schemas.QuestionFileSchema.parse(questionsV2);
  schemas.AnswerFileSchema.parse(answersV2);
  return { index, frozenQuestions: fq, frozenAnswers: fa, questionsV2, answersV2, derived, comparisons, status };
}

// ---------------------------------------------------------------------------------------------------
// changes.md
// ---------------------------------------------------------------------------------------------------

const RULES_TEXT = `- **M (module reference).** A file refers to module M (a \`.cts\` source, compiled to a \`.cjs\`) when it has a module reference whose specifier resolves, by static string evaluation, to M. Forms: F1 \`require(<spec>)\` call; F2 \`import x = require(<spec>)\`; F3 ES \`import ... from\` / \`export ... from\`; F4 \`import()\`; F5 \`require.resolve()\`; F6 \`import type\` and \`import('..').T\`. Specifier evaluation executes nothing: literals, templates, \`+\`, \`__dirname\`, \`__filename\`, the nearest enclosing \`const\`/\`let\`/\`var\` initializer of an identifier, \`require.resolve('./x')\` of a literal, and \`path.join/resolve/normalize/dirname\`. A value with an unknown prefix keeps its known tail; the tail matches M when it is a path suffix of \`src/x\` or \`gsd-core/bin/lib/x\` (a bare basename matches only if no other tracked code file has it). M matches its source path or its emit path (rootDir/outDir from \`tsconfig.build.json\`) with extension \`.cts\`, \`.cjs\`, \`.js\` or none.
- **B (binding).** \`const m = require(M)\`, \`import m = require(M)\`, default/namespace import (namespace alias m); \`const { f, g: h } = <ref or alias>\` and \`({ f } = require(M))\` (named bindings); \`require(M).f\`, \`m.f\`, \`m['f']\`; \`const h = f\` / \`const h = m.f\` (alias, three levels); \`as\`, \`satisfies\`, \`!\`, \`<T>\` and parentheses are transparent. B7: a parameter, variable or property whose annotation is \`typeof NS\`, \`typeof import(M)\` or an alias \`type A = typeof NS\` is a namespace alias of M. Tracking is by name inside the file (no scope analysis for bindings).
- **C (call).** A use is a call when it is the callee of a call expression, \`new\`, or a tagged template, through the transparent wrappers, \`(0, f)(x)\` and \`f.call/apply(...)\`.
- **R1 callers(F in M).** Files with a call to F by rule B, plus a call by its own name inside M itself (self-call and recursion count). A same-named function not bound to M is not a call.
- **R2 references(F in M).** Files with any use of F other than its declaration: import or destructuring element, call, read, type position, member access, \`export { F }\`, shorthand \`{ F }\`. A string literal that spells the name is not a use.
- **R3 emit(S).** outDir + (S relative to rootDir), \`.cts\` replaced by \`.cjs\`.
- **R4 emit-consumers(S).** Two readings, chosen by the question wording. \`calls\` (wording ".cts sources that call \`require\`"): F1 only. \`load\` (wording "load that module with \`require\`, by compiled path or sibling \`.cjs\` specifier"): F1 and F2. F3 to F6 and strings that contain \`require('...')\` text never count.
- **R5 impact(F in M, depth two).** D1 = R1 callers. D2 = for each \`.cts\` file I in D1 (M itself included when it calls F, because it is a \`.cts\` file that calls it directly), the files that call any name exported by I (\`export function/const\`, \`export { a as b }\`, \`export = { a, b: c, d() {} }\`). Result = D1 + D2 minus M.
- **R6 adr-citers(N).** Files with a code comment matching \`ADR-N\`, \`ADR N\` or \`ADR #N\`; strings and Markdown do not count. The digits are matched as written in the question; when that gives an empty key (q-067) the zero-padded reading is used and the question says so.
- **R7 adr-of(S).** ADR files for the numbers cited in the comments attached to S: the contiguous comment block directly above the declaration with no blank line before the declaration, plus every comment inside it. A banner separated by a blank line is not attached.`;

function fmtList(xs: readonly string[]): string {
  return xs.length === 0 ? '(none)' : xs.map((x) => `\`${x}\``).join(', ');
}

export interface ReportInput {
  v2: V2;
  streamsDir?: string;
}

export function buildChangesMd(input: ReportInput): string {
  const { v2 } = input;
  const idx = v2.index;
  const qById = new Map(v2.frozenQuestions.questions.map((q) => [q.id, q] as const));
  const fById = new Map(v2.frozenAnswers.answers.map((a) => [a.questionId, a] as const));
  const counts: Record<Status, number> = { corrected: 0, 'reworded+corrected': 0, 'needs-decision': 0, carried: 0 };
  for (const s of v2.status.values()) counts[s]++;
  const lines: string[] = [];
  const w = (s = ''): void => void lines.push(s);

  w('# Key set v2: changes against the registered keys');
  w();
  w('Status: PROPOSAL. Not registered, not ratified. Generated by `node scripts/key-oracle/derive-v2.ts` (rules in `scripts/key-oracle/derive-v2.ts`). The registered keys and the registered verdict stand. Nothing here rescored anything.');
  w();
  w(`Corpus: gsd-core at \`${CORPUS_SHA}\`, read with read-only git. Derivation code version \`${DERIVE_VERSION}\`. Keys were derived from the corpus and the question wording only; no session answer was used to derive any key.`);
  w();
  w('## Status counts');
  w();
  w(`corrected ${counts.corrected}, reworded+corrected ${counts['reworded+corrected']}, needs-decision ${counts['needs-decision']}, carried ${counts.carried}. Total ${v2.status.size}.`);
  w();
  w('## Per-question table (the 14 non-consistent questions)');
  w();
  w('Old and new size are distinct files in the key. Evidence is a `git grep -n` pattern against the pinned commit plus file:line of the first added hit.');
  w();
  w('| id | category | audit class | old | new | added | removed | rule | status |');
  w('|---|---|---|---|---|---|---|---|---|');
  for (const id of NON_CONSISTENT) {
    const d = v2.derived.get(id) as Derived;
    const c = v2.comparisons.get(id) as Comparison;
    const q = qById.get(id) as Question;
    const old = frozenFiles(fById.get(id) as Answer);
    w(`| ${id} | ${q.category} | ${AUDIT_CLASS[id]} | ${old.length} | ${d.files.length} | ${c.added.length} | ${c.removed.length} | ${d.rule} | ${v2.status.get(id)} |`);
  }
  w();
  w('## Evidence and diff of file sets for the 14 questions');
  w();
  for (const id of NON_CONSISTENT) {
    const d = v2.derived.get(id) as Derived;
    const c = v2.comparisons.get(id) as Comparison;
    const q = qById.get(id) as Question;
    const old = frozenFiles(fById.get(id) as Answer);
    w(`### ${id} (${q.category}, ${AUDIT_CLASS[id]}, ${v2.status.get(id)})`);
    w();
    w(`- Rule ${d.rule}. Old key ${old.length} files, v2 key ${d.files.length} files.`);
    const pat =
      q.key.kind === 'emit-consumers'
        ? `git -C <gsd-core> grep -n -E '${path.posix.basename(q.key.source as string, '.cts')}' ${CORPUS_SHA} -- 'src/*.cts' 'tests/*.cjs' 'pi/*.cjs'`
        : q.key.kind === 'adr-citers'
          ? `git -C <gsd-core> grep -n -i -E 'ADR[- #]*0*${q.key.number}\\b' ${CORPUS_SHA} -- '*.cjs' '*.cts' '*.js'`
          : q.key.kind === 'adr-of'
            ? `git -C <gsd-core> show ${CORPUS_SHA}:${q.key.definedIn} (comments above \`${q.key.symbol}\`)`
            : `git -C <gsd-core> grep -n -E '\\b${q.key.symbol}\\b' ${CORPUS_SHA}`;
    w(`- Pattern: \`${pat}\``);
    w(`- Added to the key (${c.added.length}): ${c.added.length === 0 ? '(none)' : ''}`);
    for (const f of c.added) w(`  - \`${f}\`: ${d.evidence.get(f) ?? ''}`);
    w(`- Removed from the key (${c.removed.length}): ${fmtList(c.removed)}`);
    if (d.alt !== undefined) {
      const extra = d.alt.files.filter((f) => !d.files.includes(f));
      const missing = d.files.filter((f) => !d.alt!.files.includes(f));
      w(`- ALTERNATIVE READING (${d.alt.label}): key would be ${d.alt.files.length} files; adds ${fmtList(extra)}; drops ${fmtList(missing)}.`);
      for (const f of extra) w(`  - \`${f}\`: ${d.alt.evidence.get(f) ?? ''}`);
    }
    if (d.excluded !== undefined && d.excluded.length > 0) w(`- Matching references excluded by the reading: ${d.excluded.map((e) => '`' + e + '`').join(', ')}`);
    for (const n of d.notes) w(`- Note: ${n}`);
    if (REWORD[id] !== undefined) w(`- Wording change: appended "${REWORD[id]}"`);
    w();
  }
  w('## Decisions needed (needs-decision)');
  w();
  w('- **q-012** (references to `PHASE_COMMAND_ALIASES`). Literal reading chosen: a use is an identifier bound to the export (the question says "imports, calls, reads"). Key unchanged: `src/command-aliases.cts`. Alternative: a string literal naming the symbol as a table key counts; adds `scripts/lib/alias-drift-families.cjs:24` and `tests/commands.test.cjs:4549`.');
  w('- **q-022** (requirers of compiled `runtime-artifact-layout`). Literal reading chosen: the wording says ".cts sources that call `require`", and an `import x = require()` declaration is not a call expression. Key equals the registered key (24 files; the two `path.join(ROOT, ...)` tests are resolved statically and were already in it). Alternative: declarations count as `require`; adds `src/install-engine.cts:27`, `src/surface.cts:66`, `src/install-shadow-report.cts:115`, `src/installed-surface-resolver.cts:62`. Text inside the child-process string in `tests/release-tarball-smoke.install.test.cjs:475,500,529` is excluded under both readings.');
  w('- **q-030** (ADR files cited by comments on `StateTransactionKind`). Literal reading chosen: a comment "on" the symbol is attached to it. The ADR-3473 banner (`src/state-transition.cts:399-407`) is separated from the doc comment by a blank line, so the key is ADR-3408 only. Alternative: any comment in the leading trivia of the declaration counts; adds `docs/adr/3473-enforcement-by-construction.md`.');
  w('- **q-067** (files citing ADR-5). The registered wording lists `ADR-5`, `ADR 5`, `ADR #5`; no comment in the corpus spells it unpadded, so the literal reading is an EMPTY key, which cannot be scored as a positive question and has no abstain form in the frozen schema (the abstain probe supports only a symbol or an ADR file number). v2 therefore states that zero-padded `ADR-0005` counts, and the key is `scripts/gen-adr-index.cjs` (unchanged). Alternative: keep the literal wording and turn the question into a different kind of abstain probe (needs a schema change in a new registration).');
  w();
  w('## Rule definitions');
  w();
  w(RULES_TEXT);
  w();
  w('Judgment calls made by the oracle (each can be argued the other way):');
  w();
  w('- A `.cts` file that calls F in its own defining module counts as an intermediate for depth two (q-038 and q-070 registered keys require it).');
  w('- A call through a name whose type is the module namespace type (`git: typeof GitBaseBranchModule`) counts (needed for q-007 `src/refactor-trigger-command-router.cts:731`).');
  w('- A require specifier with an unknown prefix and a known tail of at least two segments (for example `path.join(GSD_CORE, "bin", "lib", "model-resolver.cjs")` at `pi/gsd.cjs:265`) counts as the module when the tail is a path suffix of the source or emit path.');
  w('- `f.call(...)` and `f.apply(...)` count as calls; `f.bind(...)` does not.');
  w('- A call counts when the name is bound anywhere in the file by name (no scope analysis); the validation below checks this against the registered keys.');
  w();
  w('## Forms the oracle could not resolve');
  w();
  const stats = globalUnresolvedStats(idx);
  w(`- Corpus-wide: ${stats.requireCalls} \`require(...)\` calls; ${stats.repo} resolve to a repository path, ${stats.tail} have only a known tail, ${stats.bare} are bare package or builtin names, ${stats.none} have a specifier the oracle cannot evaluate at all.`);
  const dyn = fullyDynamicRequires(idx);
  w(`- The ${dyn.length} fully unresolvable \`require\` calls (file:line: argument text). A key for a module could miss a consumer here:`);
  for (const d of dyn) w(`  - \`${d.file}:${d.line}\`: \`${d.text.replace(/\s+/g, ' ').slice(0, 90)}\``);
  w('- Not followed at all: re-exports (`export { f } from`), `module.exports = require(...)`, aliasing through function parameters or object properties, calls via `bind`, `Object.assign`, spread exports (`export = { ...x }`), and `require` text inside strings handed to child processes.');
  w('- Per emit question, requires in files that spell the module basename but whose path could not be evaluated, and string mentions (checked by name only; files already in the key are not repeated):');
  for (const id of NON_CONSISTENT) {
    const q = qById.get(id) as Question;
    if (q.key.kind !== 'emit-consumers') continue;
    const d = v2.derived.get(id) as Derived;
    const near = unresolvedNear(idx, q.key.source as string).filter((n) => !d.files.includes(n.file));
    const strs = stringMentions(idx, q.key.source as string).filter((n) => !d.files.includes(n.file));
    w(`  - ${id}: unevaluable requires in other files ${near.length === 0 ? '(none)' : near.map((n) => `\`${n.file}:${n.line}\``).join(', ')}; strings ${strs.length === 0 ? '(none)' : strs.map((n) => `\`${n.file}:${n.line}\``).join(', ')}`);
  }
  w('- Checked by hand with `git show` / `git grep` at the pinned commit: `gsd-core/bin/gsd-tools.cjs:462` and `:546` are a manifest-driven capability loader (`require(resolved)` of a module name read at run time), so which modules it loads is not statically known; its only mention of `model-resolver` is a comment (line 2653). `src/command-roster.cts:36` requires `scripts/fix-slash-commands.cjs`; it names the other modules only in comments. None of these was added to a key.');
  w();
  // independent re-derivation
  w('## Independent re-derivation of all other keys (new findings)');
  w();
  const agreeBy: Record<string, [number, number]> = {};
  const disagreements: string[] = [];
  for (const q of v2.frozenQuestions.questions) {
    const c = v2.comparisons.get(q.id) as Comparison;
    const cat = q.key.kind;
    agreeBy[cat] ??= [0, 0];
    (agreeBy[cat] as [number, number])[1]++;
    if (c.agree) (agreeBy[cat] as [number, number])[0]++;
    else if (!NON_CONSISTENT.includes(q.id)) disagreements.push(`${q.id} (${cat}): added ${fmtList(c.added)}; removed ${fmtList(c.removed)}`);
  }
  w('Agreement of the oracle with the registered key, by key kind, over all 75 questions (non-consistent questions included in the denominator):');
  w();
  w('| key kind | agree | total |');
  w('|---|---|---|');
  for (const [k, [a, t]] of Object.entries(agreeBy).sort((x, y) => cmp(x[0], y[0]))) w(`| ${k} | ${a} | ${t} |`);
  w();
  w(`Disagreements with the 61 audit-consistent questions: ${disagreements.length === 0 ? 'none. There is therefore no new key problem and no oracle limitation left to classify among them.' : ''}`);
  for (const d of disagreements) w(`- ${d}`);
  w();
  w('Independence caveat. Three registered keys that the audit calls consistent were NOT reproduced by the first version of the oracle, and each was an oracle limitation, not a key problem: q-007 (a call through a parameter typed `typeof` the module namespace, `src/refactor-trigger-command-router.cts:731`), and q-038 and q-070 (depth two through the defining `.cts` file itself, which calls the symbol). Rules B7 and the self-intermediate clause of R5 were added after seeing those disagreements, so agreement on those three questions is calibrated, not independent. Everything else agreed on the first run. The `export = { ... }` closure, destructuring, cast, renamed-import and variable-path rules were written from the question wording before any comparison.');
  w();
  w('What was checked: callers, references, emit and impact by the oracle rules above for every such question; emit paths from tsconfig.build.json; heritage (declarations whose `extends`/`implements` clause names the symbol, by name only, in `.cts` files); definition (top-level declaration of the name in `src/**/*.cts`, line within the registered slack of 2); ADR citers (comment scan) and ADR-of (attached comments); abstain (symbol identifier absent from every code file, or no `docs/adr/<n>-*.md`).');
  w('What was not checked: heritage and ADR-of resolve by name, not by type; ADR citers count comments in code files only, as the registered wording asks; definitions in files outside `src/**/*.cts` were not searched; no key was checked against a running build of the corpus.');
  w();
  // sanity
  w('## EXPLORATORY sanity check (not a rescore, not a result)');
  w();
  w('For the 14 changed questions only: how many of the 6 replication sessions per question (3 atlas, 3 grep; answer = input of the last StructuredOutput tool call, files only) give an answer set equal to the v2 key. This only shows whether v2 matches a literal reading. v2 was not tuned to it, and an item the sessions list that the rule does not support was left out of the key.');
  w();
  if (input.streamsDir !== undefined && fs.existsSync(input.streamsDir)) {
    w('| id | status | v2 key equal | registered key equal | alternative reading equal |');
    w('|---|---|---|---|---|');
    for (const id of NON_CONSISTENT) {
      const d = v2.derived.get(id) as Derived;
      const sessions = sessionsFor(input.streamsDir, id);
      const eq = (keyFiles: readonly string[]): number =>
        sessions.filter((s) =>
          keyFiles.length === 0
            ? s.answer !== 'found' && s.files.length === 0
            : s.answer === 'found' && s.files.length === keyFiles.length && s.files.every((f, i) => f === [...keyFiles].sort(cmp)[i]),
        ).length;
      const old = frozenFiles(fById.get(id) as Answer);
      const altCell = d.alt === undefined ? 'n/a' : `${eq(d.alt.files)}/${sessions.length}`;
      w(`| ${id} | ${v2.status.get(id)} | ${eq(d.files)}/${sessions.length} | ${eq(old)}/${sessions.length} | ${altCell} |`);
    }
  } else {
    w('(streams directory not available when this file was generated)');
  }
  w();
  w('## The 61 carried questions');
  w();
  const carried = [...v2.status.entries()].filter(([, s]) => s === 'carried').map(([id]) => id).sort(cmp);
  w(`Carried unchanged (question text, key and answer record identical to the registered files): ${carried.join(', ')}.`);
  w();
  return lines.join('\n') + '\n';
}

export const README_TEXT = `# Key set v2 (proposal)

This directory is a PROPOSAL for a corrected key set. It is not registered and replaces nothing: the registered questions, keys, scorer and the verdict \`OVERALL: MVP not met\` stand unchanged and nothing here rescored any result.

- Files: \`questions.v2.json\` and \`answers.v2.json\` (75 questions, same schema as the registered files, validated with the registered loader), \`changes.md\` (per-question diff, rules, evidence, unresolved forms, checks).
- 61 questions are carried unchanged. 14 differ: 7 corrected, 3 reworded and corrected, 4 need a decision (the wording admits two readings; v2 takes the literal one and records the other).
- Question wording changed for 7 questions (q-012, q-022, q-024, q-028, q-030, q-065, q-067) to state the counting rule explicitly.
- A new registration would need: a new document version, a freeze with its own hashes, approvals, and fresh sessions.
- v2 keys were derived AFTER the registered results and the replication were seen, so any accuracy measured under v2 is not a blind test. The sanity table in \`changes.md\` is exploratory and was not used to tune any key.
- Regenerate with \`node scripts/key-oracle/derive-v2.ts\` (reads the pinned gsd-core commit from a local clone with read-only git; set \`GSD_CORE_REPO\` to the clone path; add \`--streams <dir>\` for the sanity table).
`;

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

export async function mainAsync(args: string[]): Promise<void> {
  let streams: string | undefined;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--streams') streams = args[++i];
    else if (args[i] === '--check') check = true;
  }
  const v2 = await computeV2();
  const md = buildChangesMd({ v2, streamsDir: streams ?? DEFAULT_STREAMS });
  if (check) {
    process.stdout.write(`checked ${v2.questionsV2.questions.length} questions, nothing written\n`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'questions.v2.json'), JSON.stringify(v2.questionsV2, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'answers.v2.json'), JSON.stringify(v2.answersV2, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'changes.md'), md);
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), README_TEXT);
  process.stdout.write(`wrote ${OUT_DIR}\n`);
}

export function main(args: string[]): void {
  mainAsync(args).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
