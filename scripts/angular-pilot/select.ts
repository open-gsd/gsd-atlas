/**
 * Question selection and wording for the UNSCORED, UNREGISTERED angular pilot (plan section 3).
 *
 * Pure pieces only: the seeded order, the window filter, the quota loop with a skip log, the question text with
 * the counting rules, abstain-name derivation and the writer of the two JSON files in the registered shapes
 * (`scripts/eval/questions.ts`, read-only use). `generate.ts` wires them to the oracle and to git.
 */
import { createHash } from 'node:crypto';

import type { AnswerItem } from '../eval/questions.ts';

export const SEED = 20261021;

export type PilotCategory = 'callers' | 'references' | 'heritage' | 'impact' | 'definition';
export type AnyCategory = PilotCategory | 'abstain';
export type CensusKind = 'class' | 'interface' | 'function' | 'type' | 'const' | 'enum';

/** Pilot quotas (plan section 3); abstain (1) is derived separately. */
export const QUOTA: Readonly<Record<PilotCategory, number>> = { callers: 5, references: 3, heritage: 3, impact: 2, definition: 2 };
/** Fixed processing order: a name taken by one category is gone for the later ones. */
export const PICK_ORDER: readonly PilotCategory[] = ['callers', 'heritage', 'impact', 'references', 'definition'];
export const WINDOW = { minGrep: 10, maxGrep: 150, minKey: 2, maxKey: 25, changedSince: '2026-01-01' } as const;

export interface CensusRow {
  name: string;
  kind: CensusKind;
  file: string;
  otherDeclFiles: number;
  grepFiles: number;
  callSiteFiles: number;
  directSubtypes: number;
  fileLastChanged: string;
}

export function candidateHash(seed: number, row: Pick<CensusRow, 'name' | 'file'>): string {
  return createHash('sha256').update(`${String(seed)}\0${row.name}@${row.file}`).digest('hex');
}

export function orderRows<T extends Pick<CensusRow, 'name' | 'file'>>(rows: readonly T[], seed: number): T[] {
  const keyed = rows.map((r) => ({ r, h: candidateHash(seed, r) }));
  keyed.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return keyed.map((k) => k.r);
}

/** Rule 1 of the selection rule that does not need the oracle: grep window, another declaration, recent declaring file. */
export function windowRows(rows: readonly CensusRow[]): CensusRow[] {
  return rows.filter(
    (r) => r.grepFiles >= WINDOW.minGrep && r.grepFiles <= WINDOW.maxGrep && r.otherDeclFiles >= 1 && r.fileLastChanged >= WINDOW.changedSince,
  );
}

/** A loose pre-filter by declaration kind and the census counts; the oracle then applies the exact key-size rule. */
export function poolFor(category: PilotCategory, rows: readonly CensusRow[]): CensusRow[] {
  const callable = (r: CensusRow): boolean => r.kind === 'function' || r.kind === 'const';
  switch (category) {
    case 'callers':
    case 'impact':
      return rows.filter((r) => callable(r) && r.callSiteFiles >= 1);
    case 'heritage':
      return rows.filter((r) => (r.kind === 'class' || r.kind === 'interface') && r.directSubtypes >= 1);
    case 'references':
    case 'definition':
      return [...rows];
  }
}

export type Evaluation<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface Exclusion {
  name: string;
  file: string;
  reason: string;
}
export interface Skipped {
  category: PilotCategory;
  name: string;
  file: string;
  reason: string;
}
export interface Picked<T> {
  category: PilotCategory;
  row: CensusRow;
  value: T;
}

/**
 * Takes candidates in seeded hash order per category until the quota is full, one question per distinct name
 * across all categories; a candidate the evaluator rejects or the audit excludes is skipped and logged.
 */
export function pickQuestions<T>(
  rows: readonly CensusRow[],
  evaluate: (category: PilotCategory, row: CensusRow) => Evaluation<T>,
  opts: { seed: number; quota: Readonly<Record<PilotCategory, number>>; exclusions: readonly Exclusion[] },
): { picked: Picked<T>[]; skipped: Skipped[] } {
  const inWindow = windowRows(rows);
  const taken = new Set<string>();
  const picked: Picked<T>[] = [];
  const skipped: Skipped[] = [];
  const excluded = new Map(opts.exclusions.map((e) => [`${e.name}@${e.file}`, e.reason] as const));
  for (const category of PICK_ORDER) {
    let left = opts.quota[category];
    for (const row of orderRows(poolFor(category, inWindow), opts.seed)) {
      if (left <= 0) break;
      if (taken.has(row.name)) continue;
      const why = excluded.get(`${row.name}@${row.file}`);
      if (why !== undefined) {
        skipped.push({ category, name: row.name, file: row.file, reason: why });
        continue;
      }
      const result = evaluate(category, row);
      if (!result.ok) {
        skipped.push({ category, name: row.name, file: row.file, reason: result.reason });
        continue;
      }
      taken.add(row.name);
      picked.push({ category, row, value: result.value });
      left -= 1;
    }
    if (left > 0) throw new Error(`category ${category} cannot fill its quota (${String(left)} missing)`);
  }
  return { picked, skipped };
}

// ---------------------------------------------------------------------------------------------
// Wording (plan section 3, counting rules; style of the v2 probe questions)

export const FORM = 'Give your answer in the required JSON form.';

export const SCOPE_RULE =
  'Scope: tracked `.ts` files under `packages/`, including spec and test files, but not `.d.ts` files and nothing under a `schematics/`, `examples/` or `integrationtest/` directory. Angular HTML templates and inline `template:` strings are not searched and do not count.';

export const USE_RULES =
  'Import specifiers, export specifiers and `export ... from` re-exports are not uses, and a file that only imports or re-exports the name does not count. A use through an alias (`import {X as Y}` followed by a use of `Y`, or a name re-exported as `export {X as Y}` and used under the new name) counts as a use of `X`. A mention in a comment, a JSDoc `{@link}`, a string literal or a property key that merely spells the name is not a use. Dependency-injection tokens are ordinary references: `inject(TOKEN)` and `@Inject(TOKEN)` use `TOKEN`, a token spelled as a string does not.';

/**
 * Wording changes after the second reader (2026-10-21), applied only to the questions the audit named; keys unchanged.
 * Keyed by `<name>@<declaring file>`.
 */
const NESTED_CALL_RULE_FOR = new Set(['isFunction@packages/zone.js/lib/common/utils.ts']);
const OTHER_DECLARATION_KIND: Readonly<Record<string, string>> = { 'CanDeactivate@packages/router/src/utils/preactivation.ts': 'an interface' };

const NESTED_CALL_RULE =
  'plus files that call any named function, method or class (by `new`) in whose body a direct call to it appears; a call inside a nested function, a callback or an unnamed arrow function counts for the nearest enclosing declaration that has a name, and a function that is only passed as a value has no callers';
const LINE_RULE = 'Give the line that holds the declared name (for a function the `export function` line, for a class the `export class` line, for an enum the `export enum` line).';

const KIND_WORD: Readonly<Record<CensusKind, string>> = {
  function: 'function',
  const: 'constant',
  class: 'class',
  interface: 'interface',
  type: 'type alias',
  enum: 'enum',
};

export interface TextSpec {
  category: AnyCategory;
  name: string;
  kind: CensusKind;
  file: string;
  useSite?: { file: string; line: number };
}

export function questionText(spec: TextSpec): string {
  const { name, file } = spec;
  const word = KIND_WORD[spec.kind];
  const different = `Another ${word} named \`${name}\` is declared elsewhere in the tree; it is a different symbol, and its uses must not be listed.`;
  switch (spec.category) {
    case 'callers':
      return `Which files call \`${name}\`, the ${word} exported from \`${file}\`? A call is a call expression, a \`new\` expression, a tagged template or a decorator use such as \`@${name}()\`; a type position, a reference that is not called, an import or a re-export is not a call. Calls inside \`${file}\` itself count. ${different} ${USE_RULES} ${SCOPE_RULE} List each file once. ${FORM}`;
    case 'references':
      return `Which files use \`${name}\`, the ${word} declared in \`${file}\`? Count every use in executable or type position (calls, \`new\`, reads, type annotations, generic arguments, \`extends\` and \`implements\` clauses, \`typeof\`), including uses inside \`${file}\` itself, but not the declaration. ${different} ${USE_RULES} ${SCOPE_RULE} List each file once. ${FORM}`;
    case 'heritage':
      return `Which interfaces or classes directly extend or implement \`${name}\`, the ${word} declared in \`${file}\`? Give the file and the name of each. Only direct subtypes count, not a subtype of a subtype, and only named classes and interfaces (an anonymous class expression does not count); a heritage clause that names it through an alias counts, and declarations in spec and test files count. Another ${word} named \`${name}\` is declared elsewhere in the tree; it is a different symbol, and its subtypes do not count. ${SCOPE_RULE} ${FORM}`;
    case 'impact':
      const reach = NESTED_CALL_RULE_FOR.has(`${name}@${file}`) ? NESTED_CALL_RULE : 'plus files that call any function, method or class (by `new`) that contains a direct call to it';
      return `List the files affected if the signature of \`${name}\` in \`${file}\` changed, to depth two: files that call it directly, ${reach}, with calls resolved to the exact declaration through aliases and re-exports. A call is a call expression, a \`new\` expression, a tagged template or a decorator use. Include spec and test files; leave out \`${file}\` itself. ${different} ${USE_RULES} ${SCOPE_RULE} List each file once. ${FORM}`;
    case 'definition': {
      const use = spec.useSite;
      if (use === undefined) throw new Error('a definition question needs a use site');
      const otherKind = OTHER_DECLARATION_KIND[`${name}@${file}`];
      const other = otherKind === undefined ? `Another ${word} named \`${name}\`` : `Another declaration named \`${name}\` (${otherKind})`;
      return `In \`${use.file}\`, line ${String(use.line)}, the ${word} \`${name}\` is used. Which file and which line declare that ${word}? ${LINE_RULE} ${other} is declared elsewhere in the tree; it is a different symbol, and only the one used at that line counts. ${SCOPE_RULE} ${FORM}`;
    }
    case 'abstain':
      return `Where is the function \`${name}\` defined, and which files call it? If this repository has no such function, say so. ${FORM}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Abstain names

const SUFFIXES = ['Registry', 'Resolver', 'Factory', 'Provider', 'Handler', 'Collector', 'Planner'] as const;

/**
 * Plausible names that do not exist: a real exported function name with its last camel-case word replaced by a
 * seeded suffix, kept only when `hitsOf` (whole-word hits in the whole tree) is zero.
 */
export function abstainNames(realNames: readonly string[], seed: number, count: number, hitsOf: (name: string) => number): string[] {
  const unique = [...new Set(realNames)].sort();
  const real = new Set(unique);
  const keyed = unique.map((n) => ({ n, h: createHash('sha256').update(`${String(seed)}\0abstain\0${n}`).digest('hex') }));
  keyed.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const out: string[] = [];
  for (const { n, h } of keyed) {
    if (out.length >= count) break;
    const parts = n.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
    if (parts === null || parts.length < 2 || parts.join('') !== n) continue;
    const suffix = SUFFIXES[parseInt(h.slice(0, 8), 16) % SUFFIXES.length]!;
    const name = `${parts.slice(0, -1).join('')}${suffix}`;
    if (!/^[a-z][A-Za-z]+$/.test(name) || real.has(name) || out.includes(name) || hitsOf(name) > 0) continue;
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The two JSON files, in the registered shapes

export interface Entry {
  id: string;
  category: AnyCategory;
  name: string;
  kind: CensusKind;
  file: string;
  items: AnswerItem[];
  needles: string[];
  notes: Record<string, number | string>;
  useSite?: { file: string; line: number };
}

const GRANULARITY: Readonly<Record<AnyCategory, 'file' | 'file+symbol' | 'file+line'>> = {
  callers: 'file',
  references: 'file',
  heritage: 'file+symbol',
  impact: 'file',
  definition: 'file+line',
  abstain: 'file',
};

function keyOf(entry: Entry): Record<string, unknown> {
  const common = { granularity: GRANULARITY[entry.category], equality: 'exact-set' };
  switch (entry.category) {
    case 'callers':
    case 'references':
      return { kind: entry.category, symbol: entry.name, definedIn: entry.file, ...common };
    case 'heritage':
      return { kind: 'heritage', symbol: entry.name, definedIn: entry.file, direction: 'subtypes', ...common };
    case 'impact':
      return { kind: 'impact', symbol: entry.name, definedIn: entry.file, depth: 2, ...common };
    case 'definition':
      return { kind: 'definition', symbol: entry.name, definedIn: entry.file, ...common };
    case 'abstain':
      return { kind: 'abstain', probe: { symbol: entry.name }, ...common };
  }
}

export function buildFiles(input: { sha: string; oracleVersion: string; typescriptVersion: string; entries: readonly Entry[] }): { questions: unknown; answers: unknown } {
  const questions = input.entries.map((e) => ({
    id: e.id,
    category: e.category,
    text: questionText({ category: e.category, name: e.name, kind: e.kind, file: e.file, ...(e.useSite === undefined ? {} : { useSite: e.useSite }) }),
    key: keyOf(e),
  }));
  const answers = input.entries.map((e) => ({
    questionId: e.id,
    kind: e.category,
    abstain: e.category === 'abstain',
    items: e.items,
    granularity: GRANULARITY[e.category],
    equality: 'exact-set',
    needles: e.needles,
    unexplained: [],
    notes: e.notes,
    oracleVersion: input.oracleVersion,
  }));
  return {
    questions: { corpusId: 'angular', corpusSha: input.sha, questions },
    answers: {
      oracleVersion: input.oracleVersion,
      repoSha: input.sha,
      preparedRecord: { corpusId: 'angular', sha: input.sha, npmCi: false, typescriptVersion: input.typescriptVersion, lockSha256: null },
      answers,
    },
  };
}
