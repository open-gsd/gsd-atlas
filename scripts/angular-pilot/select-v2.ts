/**
 * Question selection and wording for rule v2 of the UNSCORED, UNREGISTERED angular pilot
 * (`docs/eval/angular-pilot/v2/rule-v2.md`, written and committed before any draw).
 *
 * Differences from v1 (`select.ts`, untouched): the wording identifies the target by package plus a hand-written role
 * and never names the declaring file; candidates come from the ambiguous tail in two tiers; keys are wider; the mix is
 * callers 4, references 4, heritage 2, impact 4, definition 1, abstain 1. Counting-rule text blocks are reused from v1.
 */
import type { AnswerItem } from '../eval/questions.ts';
import {
  FORM,
  SCOPE_RULE,
  USE_RULES,
  orderRows,
  poolFor,
  type AnyCategory,
  type CensusKind,
  type CensusRow,
  type Evaluation,
  type Exclusion,
  type PilotCategory,
  type Skipped,
} from './select.ts';

export const SEED_V2 = 20261022;
export const QUOTA_V2: Readonly<Record<PilotCategory, number>> = { callers: 4, references: 4, heritage: 2, impact: 4, definition: 1 };
/** Scarcest pool first, so that a name taken by a later category cannot starve an earlier one. */
export const PICK_ORDER_V2: readonly PilotCategory[] = ['heritage', 'callers', 'impact', 'references', 'definition'];

export type Tier = 1 | 2;
export interface CensusRowV2 extends CensusRow {
  /** Kinds of the declarations of the same name in other files. */
  otherKinds: string[];
}

const TIER_RULES: Readonly<Record<Tier, { minGrep: number; minOther: number; changedSince: string | null }>> = {
  1: { minGrep: 60, minOther: 2, changedSince: '2026-01-01' },
  2: { minGrep: 30, minOther: 1, changedSince: null },
};

const KEY_BOUNDS: Readonly<Record<Tier, Readonly<Record<'callers' | 'references' | 'impact' | 'heritage', { min: number; max: number }>>>> = {
  1: { callers: { min: 8, max: 60 }, references: { min: 8, max: 60 }, impact: { min: 10, max: 80 }, heritage: { min: 4, max: 30 } },
  2: { callers: { min: 4, max: 60 }, references: { min: 8, max: 60 }, impact: { min: 4, max: 80 }, heritage: { min: 2, max: 30 } },
};

/** Key-size bounds (files; named subtypes for heritage) of a category in a tier; `null` for definition and abstain. */
export function keyBounds(tier: Tier, category: PilotCategory): { min: number; max: number } | null {
  return category === 'definition' ? null : KEY_BOUNDS[tier][category];
}

/** Rows that qualify for a tier before the oracle looks at them (tier 2 includes every tier-1 row). */
export function tierRows<T extends CensusRow>(rows: readonly T[], tier: Tier): T[] {
  const t = TIER_RULES[tier];
  return rows.filter((r) => r.grepFiles >= t.minGrep && r.otherDeclFiles >= t.minOther && (t.changedSince === null || r.fileLastChanged >= t.changedSince));
}

export interface PickedV2<T> {
  category: PilotCategory;
  row: CensusRowV2;
  tier: Tier;
  value: T;
}
export interface SkippedV2 extends Skipped {
  tier: Tier;
}

/**
 * Per category: tier 1 candidates in seeded order, then tier 2 candidates in seeded order (a declaration rejected at
 * tier 1 for its key size is re-evaluated under the tier-2 bounds), until the quota is full. One question per distinct
 * name across categories. Every skip is logged once per reason. Throws when tier 2 cannot fill a category.
 */
export function pickQuestionsV2<T>(
  rows: readonly CensusRowV2[],
  evaluate: (category: PilotCategory, row: CensusRowV2, tier: Tier) => Evaluation<T>,
  opts: { seed: number; quota: Readonly<Record<PilotCategory, number>>; exclusions: readonly Exclusion[] },
): { picked: PickedV2<T>[]; skipped: SkippedV2[] } {
  const taken = new Set<string>();
  const picked: PickedV2<T>[] = [];
  const skipped: SkippedV2[] = [];
  const logged = new Set<string>();
  const excluded = new Map(opts.exclusions.map((e) => [`${e.name}@${e.file}`, e.reason] as const));
  const log = (category: PilotCategory, tier: Tier, row: CensusRowV2, reason: string): void => {
    const key = `${category}|${row.name}@${row.file}|${reason}`;
    if (logged.has(key)) return;
    logged.add(key);
    skipped.push({ category, tier, name: row.name, file: row.file, reason });
  };
  for (const category of PICK_ORDER_V2) {
    let left = opts.quota[category];
    for (const tier of [1, 2] as const) {
      // poolFor returns a subset of the rows it is given, so the cast keeps the v2 fields
      const pool = poolFor(category, tierRows(rows, tier)) as CensusRowV2[];
      for (const row of orderRows(pool, opts.seed)) {
        if (left <= 0) break;
        if (taken.has(row.name)) continue;
        const why = excluded.get(`${row.name}@${row.file}`);
        if (why !== undefined) {
          log(category, tier, row, why);
          continue;
        }
        const result = evaluate(category, row, tier);
        if (!result.ok) {
          log(category, tier, row, result.reason);
          continue;
        }
        taken.add(row.name);
        picked.push({ category, row, tier, value: result.value });
        left -= 1;
      }
    }
    if (left > 0) throw Object.assign(new Error(`category ${category} cannot fill its quota (${String(left)} missing)`), { picked, skipped });
  }
  return { picked, skipped };
}

// ---------------------------------------------------------------------------------------------
// Wording

/** `@angular/<dir>` for a path under `packages/`; `zone.js` is published under its own name. */
export function packageLabel(file: string): string {
  const dir = file.split('/')[1] ?? '';
  return dir === 'zone.js' ? 'zone.js' : `@angular/${dir}`;
}

const KIND_WORD: Readonly<Record<CensusKind, string>> = { function: 'function', const: 'constant', class: 'class', interface: 'interface', type: 'type alias', enum: 'enum' };

const CLASS_FIELD_SENTENCE = 'a call in a class field initializer counts for the class';
/** The nested-call clause; `classFieldRule` inserts the class-field sentence (wording-log.md), asked for per question. */
function nestedCallRule(classFieldRule: boolean): string {
  return `plus files that call any named function, method or class (by \`new\`) in whose body a direct call to it appears; a call inside a nested function, a callback or an unnamed arrow function counts for the nearest enclosing declaration that has a name, ${classFieldRule ? `${CLASS_FIELD_SENTENCE}, ` : ''}and a function that is only passed as a value has no callers`;
}
const LINE_RULE = 'Give the line that holds the declared name (for a function the `export function` line, for a class the `export class` line, for an enum the `export enum` line).';

/** Throws when a role description would hand over the declaring file, or does not read as one line of the form the rule asks for. */
export function assertRoleDoesNotLeak(role: string, kind: CensusKind, file: string): void {
  const word = KIND_WORD[kind];
  if (!new RegExp(`^the (\\w+ ){0,2}${word} `).test(role)) throw new Error(`role must begin with "the ${word} " (up to two adjectives allowed before the kind): ${role}`);
  if (role.split(/\s+/).filter((w) => w !== '').length > 30) throw new Error(`role is longer than 30 words: ${role}`);
  if (/[\\/]/.test(role)) throw new Error(`role contains a path separator: ${role}`);
  if (/\.(ts|d\.ts|js)\b/.test(role)) throw new Error(`role contains a file name: ${role}`);
  const basename = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  if (basename.length >= 3 && new RegExp(`\\b${basename.replace(/[^\w]/g, '\\$&')}\\b`, 'i').test(role)) throw new Error(`role contains the basename "${basename}" of the declaring file: ${role}`);
  if (/\bline\s+\d+/i.test(role)) throw new Error(`role contains a line number: ${role}`);
}

export interface TextSpecV2 {
  category: AnyCategory;
  name: string;
  kind: CensusKind;
  file: string;
  role?: string;
  otherDeclFiles: number;
  otherKinds: readonly string[];
  useSite?: { file: string; line: number };
  /** Impact only: add the class-field-initializer sentence to the nested-call clause. */
  classFieldRule?: boolean;
}

function tellApart(spec: TextSpecV2): string {
  const n = spec.otherDeclFiles;
  const kinds = [...new Set(spec.otherKinds)].sort().join(', ');
  return `Other declarations named \`${spec.name}\` exist elsewhere in the tree (in ${String(n)} other ${n === 1 ? 'file' : 'files'}; kinds: ${kinds}); they are different symbols. A declaration is the target only if it is in the named package and fits the description; the uses, calls or subtypes of any other declaration of the name must not be listed.`;
}

export function questionTextV2(spec: TextSpecV2): string {
  const { name } = spec;
  const word = KIND_WORD[spec.kind];
  if (spec.category === 'abstain') return `Where is the function \`${name}\` defined, and which files call it? If this repository has no such function, say so. ${FORM}`;
  if (spec.category === 'definition') {
    const use = spec.useSite;
    if (use === undefined) throw new Error('a definition question needs a use site');
    const kinds = [...new Set(spec.otherKinds)].sort().join(', ');
    return `In \`${use.file}\`, line ${String(use.line)}, the ${word} \`${name}\` is used. Which file and which line declare that ${word}? ${LINE_RULE} Other declarations named \`${name}\` exist elsewhere in the tree (in ${String(spec.otherDeclFiles)} other ${spec.otherDeclFiles === 1 ? 'file' : 'files'}; kinds: ${kinds}); they are different symbols, and only the one used at that line counts. ${SCOPE_RULE} ${FORM}`;
  }
  if (spec.role === undefined) throw new Error(`a ${spec.category} question needs a role`);
  const target = `\`${name}\`, ${spec.role}, declared in the package \`${packageLabel(spec.file)}\``;
  const tell = tellApart(spec);
  switch (spec.category) {
    case 'callers':
      return `Which files call ${target}? A call is a call expression, a \`new\` expression, a tagged template or a decorator use such as \`@${name}()\`; a type position, a reference that is not called, an import or a re-export is not a call. Calls inside the declaring file itself count. ${tell} ${USE_RULES} ${SCOPE_RULE} List each file once. ${FORM}`;
    case 'references':
      return `Which files use ${target}? Count every use in executable or type position (calls, \`new\`, reads, type annotations, generic arguments, \`extends\` and \`implements\` clauses, \`typeof\`), including uses inside the declaring file itself, but not the declaration. ${tell} ${USE_RULES} ${SCOPE_RULE} List each file once. ${FORM}`;
    case 'heritage':
      return `Which interfaces or classes directly extend or implement ${target}? Give the file and the name of each. Only direct subtypes count, not a subtype of a subtype, and only named classes and interfaces (an anonymous class expression does not count); a heritage clause that names it through an alias counts, and declarations in spec and test files count. A subtype counts even when it has the same name as the target, as long as its heritage clause refers to the target. ${tell} ${SCOPE_RULE} ${FORM}`;
    case 'impact':
      return `List the files affected if the signature of ${target} changed, to depth two: files that call it directly, ${nestedCallRule(spec.classFieldRule === true)}, with calls resolved to the exact declaration through aliases and re-exports. A call is a call expression, a \`new\` expression, a tagged template or a decorator use. Include spec and test files; leave out the declaring file of the target. ${tell} ${USE_RULES} ${SCOPE_RULE} List each file once. ${FORM}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The two JSON files, in the registered shapes

export interface EntryV2 {
  id: string;
  category: AnyCategory;
  name: string;
  kind: CensusKind;
  file: string;
  role: string;
  otherDeclFiles: number;
  otherKinds: string[];
  items: AnswerItem[];
  needles: string[];
  notes: Record<string, number | string>;
  useSite?: { file: string; line: number };
  /** Impact only: the question text carries the class-field-initializer sentence. Not part of any key or answer. */
  classFieldRule?: boolean;
}

const GRANULARITY: Readonly<Record<AnyCategory, 'file' | 'file+symbol' | 'file+line'>> = {
  callers: 'file',
  references: 'file',
  heritage: 'file+symbol',
  impact: 'file',
  definition: 'file+line',
  abstain: 'file',
};

function keyOf(entry: EntryV2): Record<string, unknown> {
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

function textOf(e: EntryV2): string {
  if (e.category !== 'abstain' && e.category !== 'definition') assertRoleDoesNotLeak(e.role, e.kind, e.file);
  const text = questionTextV2({ category: e.category, name: e.name, kind: e.kind, file: e.file, role: e.role, otherDeclFiles: e.otherDeclFiles, otherKinds: e.otherKinds, ...(e.useSite === undefined ? {} : { useSite: e.useSite }), ...(e.classFieldRule === true ? { classFieldRule: true } : {}) });
  if (e.file !== '' && text.includes(e.file)) throw new Error(`question ${e.id} names the declaring file`);
  return text;
}

export function buildFilesV2(input: { sha: string; oracleVersion: string; typescriptVersion: string; entries: readonly EntryV2[] }): { questions: unknown; answers: unknown } {
  const questions = input.entries.map((e) => ({ id: e.id, category: e.category, text: textOf(e), key: keyOf(e) }));
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
