import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';
import { z } from 'zod';

import {
  ORACLE_VERSION,
  OracleError,
  adrFilesOf,
  analyze,
  canon,
  commentCitations,
  computeAnswerKey,
  citationsIn,
  declName,
  declarationComments,
  exportedTargets,
  isLibraryFile,
  isTopOrMember,
  lineOfNode,
  requireCallsTo,
  resolveHeritageSymbol,
  stateOf,
  symbolAt,
  trackedCodeUnits,
  walk,
  type OracleContext,
  type State,
  type Unit,
} from './oracle.ts';
import {
  AnswerFileSchema,
  CategorySchema,
  KeySpecSchema,
  PreparedRecordCopySchema,
  loadQuestions,
  type AnswerFile,
  type AnswerItem,
  type AnswerKey,
  type Category,
  type Granularity,
  type KeySpec,
  type PreparedRecordCopy,
  type Question,
  type QuestionFile,
} from './questions.ts';

/**
 * Candidate census and seeded sampler for the pre-registered question set (EVL-02, D-01, plan 03-09).
 *
 * The question set must not drift toward what atlas answers well. Candidates for every question
 * category therefore come from one compiler-derived census of the prepared checkout (the oracle's
 * program and helpers, nothing of atlas), are ordered by a seeded shuffle (`eval.bootstrapSeed`
 * from the approved constants) over a list sorted by file and symbol, and are accepted or rejected
 * only by the closed rules in `decide`. The ordered list with every decision is committed.
 *
 * Eval files do not depend on each other beyond the shared shapes in `questions.ts`, so the
 * `mulberry32` recurrence is copied here (it is the published public-domain one-liner).
 */

// ---------------------------------------------------------------------------------------------
// The census

export type ExportKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';

/** An exported symbol of a program file; `nameCount` is how many declarations of the name the program has. */
export interface ExportEntry {
  symbol: string;
  file: string;
  line: number;
  kind: ExportKind;
  /** Call sites (a `new` expression counts) the oracle's callers rule finds. */
  calls: number;
  callerFiles: number;
  /** Every site that is not the declaration itself: imports, exports, calls, reads, bindings. */
  refs: number;
  nameCount: number;
}

/** A top-level class or interface declared in the program that at least one class or interface extends or implements. */
export interface TypeEntry {
  symbol: string;
  file: string;
  line: number;
  kind: 'class' | 'interface';
  subtypes: number;
  nameCount: number;
}

/** A library type (for example `Error`) that classes of the program extend. */
export interface LibTypeEntry {
  symbol: string;
  subtypes: number;
}

/** A root source file with its emitted outputs and the `require` calls that reach it. */
export interface EmitEntry {
  source: string;
  outputs: string[];
  requirers: number;
  requirerFiles: number;
}

/** An ADR number cited in a code comment, with the ADR files that carry the number. */
export interface AdrEntry {
  number: number;
  files: string[];
  citations: number;
  citingFiles: number;
}

/** A top-level declaration whose comments cite at least one ADR. */
export interface AdrOfEntry {
  symbol: string;
  file: string;
  line: number;
  adrs: number[];
  nameCount: number;
}

/** A real-looking name derived from an exported function by swapping one word; absence is checked by the oracle probe. */
export interface NearMiss {
  name: string;
  from: string;
  file: string;
}

/** Plain data only: arrays, numbers and strings, so a census can be written to JSON and compared. */
export interface Census {
  exports: ExportEntry[];
  types: TypeEntry[];
  libTypes: LibTypeEntry[];
  emits: EmitEntry[];
  adrs: AdrEntry[];
  adrOf: AdrOfEntry[];
  nearMisses: NearMiss[];
}

/** The file `prepare-corpus.ts` writes in a prepared checkout; read here, not imported. */
const RECORD_FILE = '.eval-prepared.json';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function distinct<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Top-level declaration nodes of a program file, one per declared name (variable statements are split). */
function topLevelDeclarations(unit: Unit): ts.Node[] {
  const nodes: ts.Node[] = [];
  for (const statement of unit.sf.statements) {
    if (ts.isVariableStatement(statement)) nodes.push(...statement.declarationList.declarations);
    else if (declName(statement) !== undefined) nodes.push(statement);
  }
  return nodes;
}

function exportKindOf(node: ts.Node): ExportKind | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'function' : 'const';
  }
  return undefined;
}

/** Word swaps (both directions) used to derive near-miss names; plausible in this codebase's style. */
const WORD_SWAPS: readonly (readonly [string, string])[] = [
  ['get', 'fetch'],
  ['read', 'load'],
  ['write', 'save'],
  ['parse', 'decode'],
  ['build', 'assemble'],
  ['create', 'make'],
  ['resolve', 'locate'],
  ['find', 'lookup'],
  ['validate', 'verify'],
  ['check', 'inspect'],
  ['list', 'enumerate'],
  ['compute', 'calculate'],
  ['merge', 'combine'],
  ['render', 'format'],
  ['collect', 'gather'],
  ['update', 'refresh'],
  ['normalize', 'canonicalize'],
  ['ensure', 'guarantee'],
];

function splitWords(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]+/g) ?? [name];
}

/** The near-miss spelling of `name`, or undefined when no word of it has a swap. */
function nearMissOf(name: string): string | undefined {
  const words = splitWords(name);
  for (let index = 0; index < words.length; index += 1) {
    const lower = words[index].toLowerCase();
    for (const [a, b] of WORD_SWAPS) {
      const replacement = lower === a ? b : lower === b ? a : undefined;
      if (replacement === undefined) continue;
      const swapped = words.map((word, position) => {
        if (position !== index) return word;
        return word[0] === word[0].toUpperCase() && position > 0 ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
      });
      const result = swapped.join('');
      return result === name ? undefined : result;
    }
  }
  return undefined;
}

function countNames(state: State): Map<string, number> {
  const counts = new Map<string, number>();
  for (const unit of state.units.values()) {
    walk(unit.sf, (node) => {
      const id = declName(node);
      if (id !== undefined && isTopOrMember(node)) counts.set(id.text, (counts.get(id.text) ?? 0) + 1);
    });
  }
  return counts;
}

function collectExports(state: State, nameCounts: Map<string, number>): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const unit of state.units.values()) {
    if (unit.checker === undefined) continue;
    for (const target of exportedTargets(state, unit, (declaration) => exportKindOf(declaration) !== undefined)) {
      if (target.name === 'default' || target.name === 'export=' || target.decls.length === 0) continue;
      const first = target.decls[0];
      const kind = exportKindOf(first.node);
      if (kind === undefined) continue;
      const sites = analyze(state, target).sites;
      const calls = sites.filter((site) => site.kind === 'call');
      entries.push({
        symbol: target.name,
        file: unit.rel,
        line: lineOfNode(unit, first.id),
        kind,
        calls: calls.length,
        callerFiles: distinct(calls.map((site) => site.unit.rel)).length,
        refs: sites.filter((site) => site.kind !== 'definition').length,
        nameCount: nameCounts.get(target.name) ?? 1,
      });
    }
  }
  return entries.sort((a, b) => compareText(a.file, b.file) || compareText(a.symbol, b.symbol));
}

function collectTypes(state: State, nameCounts: Map<string, number>): { types: TypeEntry[]; libTypes: LibTypeEntry[] } {
  const subtypeCounts = new Map<ts.Symbol, number>();
  const libCounts = new Map<string, number>();
  for (const unit of state.units.values()) {
    walk(unit.sf, (node) => {
      if ((!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) || node.name === undefined) return;
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) {
          const resolved = resolveHeritageSymbol(state, type);
          if (resolved === undefined) continue;
          const inLibrary = (resolved.declarations ?? []).some((declaration) => isLibraryFile(state, declaration.getSourceFile()));
          if (inLibrary) libCounts.set(resolved.name, (libCounts.get(resolved.name) ?? 0) + 1);
          else subtypeCounts.set(resolved, (subtypeCounts.get(resolved) ?? 0) + 1);
        }
      }
    });
  }
  const types: TypeEntry[] = [];
  for (const unit of state.units.values()) {
    const checker = unit.checker;
    if (checker === undefined) continue;
    for (const statement of unit.sf.statements) {
      if ((!ts.isClassDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) || statement.name === undefined) continue;
      const raw = symbolAt(checker, statement.name);
      const count = raw === undefined ? undefined : subtypeCounts.get(canon(checker, raw));
      if (count === undefined) continue;
      types.push({
        symbol: statement.name.text,
        file: unit.rel,
        line: lineOfNode(unit, statement.name),
        kind: ts.isClassDeclaration(statement) ? 'class' : 'interface',
        subtypes: count,
        nameCount: nameCounts.get(statement.name.text) ?? 1,
      });
    }
  }
  types.sort((a, b) => compareText(a.file, b.file) || compareText(a.symbol, b.symbol));
  const libTypes = [...libCounts.entries()]
    .map(([symbol, subtypes]) => ({ symbol, subtypes }))
    .sort((a, b) => compareText(a.symbol, b.symbol));
  return { types, libTypes };
}

async function collectEmits(state: State, ctx: OracleContext): Promise<EmitEntry[]> {
  const entries: EmitEntry[] = [];
  const roots = [...state.rootNames.keys()].filter((rel) => !/\.d\.[cm]?ts$/.test(rel)).sort(compareText);
  for (const source of roots) {
    const answer = await computeAnswerKey({ kind: 'emit', source, granularity: 'file', equality: 'exact-set' }, ctx);
    const requires = requireCallsTo(state, source);
    entries.push({
      source,
      outputs: answer.items.flatMap((item) => (item.file === undefined ? [] : [item.file])),
      requirers: requires.length,
      requirerFiles: distinct(requires.map(({ unit }) => unit.rel)).length,
    });
  }
  return entries;
}

function collectAdrs(state: State): AdrEntry[] {
  const tally = new Map<number, { citations: number; files: Set<string> }>();
  for (const unit of trackedCodeUnits(state)) {
    for (const citation of commentCitations(unit)) {
      const entry = tally.get(citation.number) ?? { citations: 0, files: new Set<string>() };
      entry.citations += 1;
      entry.files.add(unit.rel);
      tally.set(citation.number, entry);
    }
  }
  const files = adrFilesOf(state);
  return [...tally.entries()]
    .map(([number, entry]) => ({
      number,
      files: [...(files.get(number) ?? [])],
      citations: entry.citations,
      citingFiles: entry.files.size,
    }))
    .sort((a, b) => a.number - b.number);
}

function collectAdrOf(state: State, nameCounts: Map<string, number>): AdrOfEntry[] {
  const entries: AdrOfEntry[] = [];
  for (const unit of state.units.values()) {
    for (const node of topLevelDeclarations(unit)) {
      const id = declName(node);
      if (id === undefined) continue;
      const numbers = new Set<number>();
      for (const range of declarationComments(unit, node)) {
        for (const citation of citationsIn(unit.sf.text.slice(range.pos, range.end), range.pos)) numbers.add(citation.number);
      }
      if (numbers.size === 0) continue;
      entries.push({
        symbol: id.text,
        file: unit.rel,
        line: lineOfNode(unit, id),
        adrs: [...numbers].sort((a, b) => a - b),
        nameCount: nameCounts.get(id.text) ?? 1,
      });
    }
  }
  return entries.sort((a, b) => compareText(a.file, b.file) || compareText(a.symbol, b.symbol));
}

function deriveNearMisses(exportsList: readonly ExportEntry[], nameCounts: ReadonlyMap<string, number>): NearMiss[] {
  const known = new Set(exportsList.map((entry) => entry.symbol));
  const seen = new Set<string>();
  const out: NearMiss[] = [];
  for (const entry of exportsList) {
    if (entry.kind !== 'function') continue;
    const name = nearMissOf(entry.symbol);
    if (name === undefined || known.has(name) || nameCounts.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, from: entry.symbol, file: entry.file });
  }
  return out.sort((a, b) => compareText(a.file, b.file) || compareText(a.name, b.name));
}

/**
 * Builds the census of a prepared checkout from the oracle's program: exported symbols with their
 * call and reference counts, subtyped classes and interfaces, emit outputs with their requirers, ADR
 * numbers cited in comments with their files, declarations that cite ADRs, and near-miss names.
 * Strings and anything that is not a comment never count as an ADR citation.
 */
export async function buildCensus(ctx: OracleContext): Promise<Census> {
  const state = stateOf(ctx);
  const nameCounts = countNames(state);
  const exportsList = collectExports(state, nameCounts);
  const { types, libTypes } = collectTypes(state, nameCounts);
  return {
    exports: exportsList,
    types,
    libTypes,
    emits: await collectEmits(state, ctx),
    adrs: collectAdrs(state),
    adrOf: collectAdrOf(state, nameCounts),
    nearMisses: deriveNearMisses(exportsList, nameCounts),
  };
}

// ---------------------------------------------------------------------------------------------
// Candidates and the seeded order

/** One thing a question could be about, with the key spec ready for `computeAnswerKey`. */
export interface Candidate {
  category: Category;
  /** The sub-list inside the category (a category may mix two key kinds). */
  group: string;
  /** What "already used" compares: `sym:<name>`, `path:<source>` or `adr:<number>`. */
  identity: string;
  name: string;
  /** Repository-relative file used as the first sort key; empty when there is none. */
  file: string;
  key: KeySpec;
  facts: Record<string, number | string>;
}

const FILE_EXACT = { granularity: 'file', equality: 'exact-set' } as const;

function candidate(
  category: Category,
  group: string,
  name: string,
  file: string,
  key: KeySpec,
  facts: Record<string, number | string>,
): Candidate {
  const parsed = KeySpecSchema.parse(key);
  return { category, group, identity: identityOfKey(parsed), name, file, key: parsed, facts };
}

/**
 * What "already used" compares for a key: the symbol (`sym:`), the source path of an emit key
 * (`path:`) or the ADR number (`adr:`). One question per identity, across all categories.
 */
export function identityOfKey(key: KeySpec): string {
  switch (key.kind) {
    case 'emit':
    case 'emit-consumers':
      return `path:${key.source}`;
    case 'adr-citers':
      return `adr:${key.number}`;
    case 'abstain':
      return 'adrNoFile' in key.probe ? `adr:${key.probe.adrNoFile}` : `sym:${key.probe.symbol}`;
    default:
      return `sym:${key.symbol}`;
  }
}

/** Every candidate the census offers for a category, in no particular order. */
export function candidatesOf(census: Census, category: Category): Candidate[] {
  const out: Candidate[] = [];
  switch (category) {
    case 'callers':
      for (const entry of census.exports) {
        if (entry.kind !== 'function' || entry.calls < 1) continue;
        out.push(
          candidate('callers', 'callers', entry.symbol, entry.file,
            { kind: 'callers', symbol: entry.symbol, definedIn: entry.file, ...FILE_EXACT },
            { calls: entry.calls, callerFiles: entry.callerFiles, nameCount: entry.nameCount }),
        );
      }
      break;
    case 'references':
      for (const entry of census.exports) {
        if (entry.refs < 1) continue;
        out.push(
          candidate('references', 'references', entry.symbol, entry.file,
            { kind: 'references', symbol: entry.symbol, definedIn: entry.file, ...FILE_EXACT },
            { refs: entry.refs, exportKind: entry.kind, nameCount: entry.nameCount }),
        );
      }
      break;
    case 'heritage':
      for (const entry of census.types) {
        out.push(
          candidate('heritage', 'heritage', entry.symbol, entry.file,
            { kind: 'heritage', symbol: entry.symbol, definedIn: entry.file, direction: 'subtypes', granularity: 'file+symbol', equality: 'exact-set' },
            { subtypes: entry.subtypes, typeKind: entry.kind, nameCount: entry.nameCount }),
        );
      }
      for (const entry of census.libTypes) {
        out.push(
          candidate('heritage', 'heritage', entry.symbol, '',
            { kind: 'heritage', symbol: entry.symbol, lib: true, direction: 'subtypes', granularity: 'file+symbol', equality: 'exact-set' },
            { subtypes: entry.subtypes, typeKind: 'library', nameCount: 1 }),
        );
      }
      break;
    case 'emit':
      for (const entry of census.emits) {
        if (entry.outputs.length > 0) {
          out.push(
            candidate('emit', 'emit-outputs', entry.source, entry.source,
              { kind: 'emit', source: entry.source, ...FILE_EXACT },
              { outputs: entry.outputs.length }),
          );
        }
        if (entry.requirers > 0) {
          out.push(
            candidate('emit', 'emit-consumers', entry.source, entry.source,
              { kind: 'emit-consumers', source: entry.source, ...FILE_EXACT },
              { requirers: entry.requirers, requirerFiles: entry.requirerFiles }),
          );
        }
      }
      break;
    case 'adr':
      for (const entry of census.adrs) {
        if (entry.files.length === 0) continue;
        out.push(
          candidate('adr', 'adr-citers', String(entry.number), '',
            { kind: 'adr-citers', number: entry.number, ...FILE_EXACT },
            { citations: entry.citations, citingFiles: entry.citingFiles, adrFiles: entry.files.length }),
        );
      }
      for (const entry of census.adrOf) {
        out.push(
          candidate('adr', 'adr-of', entry.symbol, entry.file,
            { kind: 'adr-of', symbol: entry.symbol, definedIn: entry.file, ...FILE_EXACT },
            { adrs: entry.adrs.join(','), nameCount: entry.nameCount }),
        );
      }
      break;
    case 'impact':
      for (const entry of census.exports) {
        if (entry.kind !== 'function' || entry.calls < 1) continue;
        out.push(
          candidate('impact', 'impact', entry.symbol, entry.file,
            { kind: 'impact', symbol: entry.symbol, definedIn: entry.file, depth: 2, ...FILE_EXACT },
            { calls: entry.calls, callerFiles: entry.callerFiles, nameCount: entry.nameCount }),
        );
      }
      break;
    case 'definition':
      for (const entry of census.exports) {
        out.push(
          candidate('definition', 'definition', entry.symbol, entry.file,
            { kind: 'definition', symbol: entry.symbol, granularity: 'file+line', equality: 'exact-set' },
            { exportKind: entry.kind, nameCount: entry.nameCount }),
        );
      }
      break;
    case 'abstain':
      for (const entry of census.nearMisses) {
        out.push(
          candidate('abstain', 'abstain-symbol', entry.name, entry.file,
            { kind: 'abstain', probe: { symbol: entry.name }, ...FILE_EXACT },
            { from: entry.from, nameCount: 0 }),
        );
      }
      for (const entry of census.adrs) {
        if (entry.files.length > 0) continue;
        out.push(
          candidate('abstain', 'abstain-adr', String(entry.number), '',
            { kind: 'abstain', probe: { adrNoFile: entry.number }, ...FILE_EXACT },
            { citations: entry.citations, citingFiles: entry.citingFiles, nameCount: 0 }),
        );
      }
      break;
  }
  return out;
}

/** The published mulberry32 recurrence: a 32-bit seed in, a function of floats in [0, 1) out. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over UTF-16 code units: the per-category salt, so categories do not share one permutation pattern. */
function salt(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The candidates of a category in the sampler's order: sorted by file, then name, then group (so
 * the starting list does not depend on the order the census was built or serialized in), then
 * shuffled with Fisher-Yates driven by `mulberry32(seed xor salt(category))`.
 */
export function orderCandidates(census: Census, category: Category, seed: number): Candidate[] {
  const list = candidatesOf(census, category).sort(
    (a, b) => compareText(a.file, b.file) || compareText(a.name, b.name) || compareText(a.group, b.group),
  );
  const next = mulberry32((seed ^ salt(category)) >>> 0);
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}

export interface SampleOptions {
  seed: number;
  /** How many candidates of the ordered list to pass over first (a continuation, OQ7). */
  skip: number;
}

/** `count` candidates of the ordered list after `skip`; a larger `skip` continues the same list. */
export function sample(census: Census, category: Category, count: number, options: SampleOptions): Candidate[] {
  return orderCandidates(census, category, options.seed).slice(options.skip, options.skip + count);
}

// ---------------------------------------------------------------------------------------------
// The candidates file

export const CANDIDATE_REASONS = ['unexplained', 'too-large', 'empty', 'duplicate-symbol', 'used-by-pilot', 'ambiguous-name'] as const;
export type CandidateReason = (typeof CANDIDATE_REASONS)[number];

export const CandidateRecordSchema = z.strictObject({
  rank: z.number().int().positive(),
  group: z.string().min(1),
  identity: z.string().min(1),
  key: KeySpecSchema,
  status: z.enum(['accepted', 'rejected', 'unused']),
  slot: z.enum(['scored', 'pilot']).optional(),
  questionId: z.string().min(1).optional(),
  reason: z.enum(CANDIDATE_REASONS).optional(),
  detail: z.string().optional(),
  /** Size of the expected answer after projecting to the key's granularity, when it was computed. */
  size: z.number().int().nonnegative().optional(),
  /** The census numbers behind the candidate, kept for the candidates that were looked at. */
  facts: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

export const CandidatesFileSchema = z.strictObject({
  corpusId: z.string().min(1),
  corpusSha: z.string().min(1),
  seed: z.number().int(),
  oracleVersion: z.string().min(1),
  /** Categories whose first acceptable candidate went to the pilot set, in category order. */
  pilotCategories: z.array(CategorySchema),
  categories: z.record(CategorySchema, z.array(CandidateRecordSchema)),
});
export type CandidatesFile = z.infer<typeof CandidatesFileSchema>;

/** One record per line inside each category list: readable in review and stable under diff. */
export function serializeCandidates(file: CandidatesFile): string {
  const lines: string[] = ['{'];
  const head = {
    corpusId: file.corpusId,
    corpusSha: file.corpusSha,
    seed: file.seed,
    oracleVersion: file.oracleVersion,
    pilotCategories: file.pilotCategories,
  };
  for (const [name, value] of Object.entries(head)) lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(value)},`);
  lines.push('  "categories": {');
  const categories = CategorySchema.options.filter((category) => file.categories[category] !== undefined);
  categories.forEach((category, position) => {
    lines.push(`    ${JSON.stringify(category)}: [`);
    const records = file.categories[category] ?? [];
    records.forEach((record, index) => {
      lines.push(`      ${JSON.stringify(record)}${index < records.length - 1 ? ',' : ''}`);
    });
    lines.push(`    ]${position < categories.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}');
  return `${lines.join('\n')}\n`;
}

/** A candidates file in which every ordered candidate is `unused` (the output of the plain command). */
export function skeletonCandidates(
  census: Census,
  options: { corpusId: string; corpusSha: string; seed: number },
): CandidatesFile {
  const categories: CandidatesFile['categories'] = {} as CandidatesFile['categories'];
  for (const category of CategorySchema.options) {
    categories[category] = orderCandidates(census, category, options.seed).map((entry, index) => ({
      rank: index + 1,
      group: entry.group,
      identity: entry.identity,
      key: entry.key,
      status: 'unused' as const,
    }));
  }
  return {
    corpusId: options.corpusId,
    corpusSha: options.corpusSha,
    seed: options.seed,
    oracleVersion: ORACLE_VERSION,
    pilotCategories: [],
    categories,
  };
}

// ---------------------------------------------------------------------------------------------
// Drafting: the closed acceptance rules and the single pass over the ordered candidates

/** How many scored questions each group of a category gets; the sum is the registered 50. */
export const SCORED_MIX: Readonly<Record<Category, Readonly<Record<string, number>>>> = {
  callers: { callers: 11 },
  references: { references: 5 },
  heritage: { heritage: 5 },
  emit: { 'emit-outputs': 3, 'emit-consumers': 4 },
  adr: { 'adr-citers': 4, 'adr-of': 3 },
  impact: { impact: 4 },
  definition: { definition: 5 },
  abstain: { 'abstain-symbol': 4, 'abstain-adr': 2 },
};

type Mix = Record<string, Record<string, number>>;

/** Largest-remainder apportionment of `total` over `weights`; ties go to the earlier entry. */
function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => (weight * total) / sum);
  const counts = exact.map((value) => Math.floor(value + 1e-9));
  let left = total - counts.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - counts[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    counts[index] += 1;
    left -= 1;
  }
  return counts;
}

/**
 * The scored mix for `total` questions: abstain is 12 percent of the total, rounded half up, and the
 * rest is the 50 mix scaled to what is left, group by group, by largest remainder (ties to the
 * earlier group). `scaledMix(50)` is `SCORED_MIX`; a larger total never gives a group fewer questions
 * than the 50 mix, so the first 50 questions stay a prefix.
 */
export function scaledMix(total: number): Mix {
  if (!Number.isInteger(total) || total < 50) throw new Error(`a scored set has at least 50 questions, not ${total}`);
  const abstainTotal = Math.floor((total * 12 + 50) / 100);
  const entries = Object.entries(SCORED_MIX).flatMap(([category, groups]) =>
    Object.entries(groups).map(([group, count]) => ({ category, group, count })),
  );
  const plain = entries.filter((entry) => entry.category !== 'abstain');
  const abstain = entries.filter((entry) => entry.category === 'abstain');
  const counts = [
    ...apportion(plain.map((entry) => entry.count), total - abstainTotal),
    ...apportion(abstain.map((entry) => entry.count), abstainTotal),
  ];
  const mix: Mix = {};
  [...plain, ...abstain].forEach((entry, index) => {
    mix[entry.category] ??= {};
    mix[entry.category][entry.group] = counts[index];
  });
  return Object.fromEntries(CategorySchema.options.filter((category) => mix[category] !== undefined).map((category) => [category, mix[category]]));
}

/** Questions in the pilot set, one each from this many different categories (`eval.pilotQuestions`). */
export const PILOT_COUNT = 5;

/** The largest expected answer a scored question may have, after projection to its granularity. */
export const MAX_EXPECTED_ITEMS = 30;

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const list = [...items];
  const next = mulberry32(seed >>> 0);
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}

/**
 * The categories whose first acceptable candidate goes to the pilot set: `count` different
 * categories chosen by a seeded shuffle, returned in category order. No person chooses them.
 */
export function pickPilotCategories(seed: number, count: number): Category[] {
  const options = CategorySchema.options;
  if (!Number.isInteger(count) || count < 0 || count > options.length) {
    throw new Error(`the pilot takes between 0 and ${options.length} categories, not ${count}`);
  }
  const chosen = new Set(shuffled(options, (seed ^ salt('pilot')) >>> 0).slice(0, count));
  return options.filter((category) => chosen.has(category));
}

/** What makes two expected items the same answer at a granularity; undefined for an item without a file. */
function projectionId(item: AnswerItem, granularity: Granularity): string | undefined {
  if (item.file === undefined) return undefined;
  if (granularity === 'file') return item.file;
  if (granularity === 'file+symbol') return `${item.file}\0${item.symbol ?? ''}`;
  return `${item.file}\0${item.line ?? ''}`;
}

/** The first item of each distinct answer at `granularity`, in key order. */
function distinctAnswers(items: readonly AnswerItem[], granularity: Granularity): AnswerItem[] {
  const seen = new Set<string>();
  const out: AnswerItem[] = [];
  for (const item of items) {
    const id = projectionId(item, granularity);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** The number of expected answers a model has to give for `items` at `granularity`. */
export function projectedSize(items: readonly AnswerItem[], granularity: Granularity): number {
  return distinctAnswers(items, granularity).length;
}

export type Decision = { status: 'accepted' } | { status: 'rejected'; reason: CandidateReason; detail: string };

export interface DecideInput {
  candidate: Candidate;
  /** The oracle's key, or undefined when computing it threw. */
  answer?: AnswerKey;
  /** The OracleError (code and message) when computing the key threw. */
  error?: { code: string; message: string };
  /** Identity to who holds it: `scored`, `pilot` or `reserved`. */
  used: ReadonlyMap<string, 'scored' | 'pilot' | 'reserved'>;
}

function reject(reason: CandidateReason, detail: string): Decision {
  return { status: 'rejected', reason, detail };
}

/**
 * The closed list of reasons a candidate may be passed over, applied in this order and nowhere
 * else: the subject is already used (`used-by-pilot`, `duplicate-symbol`); the name is declared more
 * than once in the program or the oracle refuses it as ambiguous (`ambiguous-name`); the key has a
 * mention neither included nor classified, or an `adr-of` citation without an ADR file
 * (`unexplained`); a non-abstain expected answer is empty or larger than 30 after projection to
 * its granularity (`empty`, `too-large`). Any other oracle error is a bug in the draft and throws.
 */
export function decide(input: DecideInput): Decision {
  const { candidate, answer, error, used } = input;
  const holder = used.get(candidate.identity);
  if (holder === 'pilot') return reject('used-by-pilot', `${candidate.identity} is the subject of a pilot question`);
  if (holder !== undefined) return reject('duplicate-symbol', `${candidate.identity} is already used (${holder})`);
  const nameCount = Number(candidate.facts.nameCount ?? 1);
  if (nameCount > 1) return reject('ambiguous-name', `the name is declared ${nameCount} times in the program`);
  if (error !== undefined) {
    if (error.code === 'SYMBOL_AMBIGUOUS' || error.code === 'ABSTAIN_PROBE_MATCHES') {
      return reject('ambiguous-name', `${error.code}: ${error.message}`);
    }
    throw new Error(`${error.code}: ${error.message}`);
  }
  if (answer === undefined) throw new Error('decide needs the oracle key or the error it threw');
  if (answer.unexplained.length > 0) {
    const first = answer.unexplained[0];
    return reject('unexplained', `${answer.unexplained.length} mention(s) neither included nor classified, first ${first.file}:${first.line}`);
  }
  if (candidate.key.kind === 'adr-of' && answer.items.some((item) => item.resolved === false)) {
    return reject('unexplained', 'a cited ADR number has no ADR file, so the citation cannot be answered with a file');
  }
  if (candidate.key.kind === 'abstain') {
    if (!answer.abstain || answer.items.length > 0) throw new Error(`${candidate.identity}: an abstain key must abstain with no items`);
    return { status: 'accepted' };
  }
  const size = projectedSize(answer.items, answer.granularity);
  if (size === 0) return reject('empty', 'the expected answer is empty');
  if (size > MAX_EXPECTED_ITEMS) return reject('too-large', `the expected answer has ${size} items at granularity ${answer.granularity}; the limit is ${MAX_EXPECTED_ITEMS}`);
  return { status: 'accepted' };
}

export interface DraftOptions {
  seed: number;
  corpusId: string;
  corpusSha: string;
  /** Identities already used by questions outside this set (the scan questions). */
  reserved?: readonly string[];
  /** Scored questions per category and group; the registered `SCORED_MIX` by default. */
  mix?: Readonly<Partial<Record<Category, Readonly<Record<string, number>>>>>;
  /** How many categories supply a pilot question; `PILOT_COUNT` by default. */
  pilotCount?: number;
  /** The pilot categories themselves, instead of the seeded pick (for tests on a small fixture). */
  pilotCategories?: readonly Category[];
  /**
   * A committed candidates file to continue (a larger N, or the oracle was fixed). Its order is
   * kept as it is (the census is not shuffled again), a rejection on record stays a rejection, an
   * accepted candidate is decided again with the current oracle and keeps its question id when it is
   * still acceptable, and an `unused` candidate is looked at only while its group has an open slot.
   * An id freed by a dropped candidate goes to the next newly accepted one; further ids continue
   * after the highest id on record. The pilot categories are the file's.
   */
  previous?: CandidatesFile;
}

/**
 * One pass per category over its ordered candidates. Each candidate that could still fill a slot
 * (its group's scored quota, or the category's pilot slot) has its key computed by the oracle and
 * is decided by `decide`; the first acceptable candidate of the first group of a pilot category goes
 * to the pilot, the next ones fill the scored quotas, and everything after the last needed
 * candidate stays `unused`.
 * Nothing here looks at what any tool answers. Question ids follow category then rank order.
 */
export async function draftCandidates(census: Census, ctx: OracleContext, options: DraftOptions): Promise<CandidatesFile> {
  const mix = options.mix ?? SCORED_MIX;
  const pilotCategories =
    options.previous !== undefined
      ? options.previous.pilotCategories
      : options.pilotCategories === undefined
        ? pickPilotCategories(options.seed, options.pilotCount ?? PILOT_COUNT)
        : CategorySchema.options.filter((category) => options.pilotCategories?.includes(category) === true);
  const used = new Map<string, 'scored' | 'pilot' | 'reserved'>();
  for (const identity of options.reserved ?? []) used.set(identity, 'reserved');

  const categories = {} as CandidatesFile['categories'];
  for (const category of CategorySchema.options) {
    const quota: Record<string, number> = { ...(mix[category] ?? {}) };
    // The pilot question comes from the category's first group, so it can never use up a scarcer group's scored quota.
    const pilotGroup = Object.keys(quota)[0];
    let pilotOpen = pilotCategories.includes(category);
    const records: CandidateRecord[] = [];
    const prior = options.previous?.categories[category];
    let ordered: Candidate[];
    if (prior === undefined) {
      ordered = orderCandidates(census, category, options.seed);
    } else {
      // The recorded order is kept; the current census only supplies the facts of candidates never looked at.
      const fresh = new Map(orderCandidates(census, category, options.seed).map((entry) => [entry.identity, entry]));
      ordered = prior.map((record) => ({
        category,
        group: record.group,
        identity: record.identity,
        name: record.identity,
        file: '',
        key: record.key,
        facts: record.facts ?? fresh.get(record.identity)?.facts ?? {},
      }));
    }
    for (const [index, entry] of ordered.entries()) {
      const record: CandidateRecord = {
        rank: index + 1,
        group: entry.group,
        identity: entry.identity,
        key: entry.key,
        status: 'unused',
      };
      records.push(record);
      const before = prior?.[index];
      if (before?.status === 'rejected') {
        // A decision on record is history: it stays, with the reason and the numbers it was made on.
        record.status = 'rejected';
        if (before.reason !== undefined) record.reason = before.reason;
        if (before.detail !== undefined) record.detail = before.detail;
        if (before.size !== undefined) record.size = before.size;
        if (before.facts !== undefined) record.facts = before.facts;
        continue;
      }
      const pilotEligible = pilotOpen && (pilotGroup === undefined || entry.group === pilotGroup);
      if ((quota[entry.group] ?? 0) <= 0 && !pilotEligible) continue;

      let answer: AnswerKey | undefined;
      let error: { code: string; message: string } | undefined;
      try {
        answer = await computeAnswerKey(entry.key, ctx);
      } catch (thrown) {
        if (!(thrown instanceof OracleError)) throw thrown;
        error = { code: thrown.code, message: thrown.message };
      }
      record.facts = entry.facts;
      if (answer !== undefined) record.size = projectedSize(answer.items, answer.granularity);
      const decision = decide({ candidate: entry, answer, error, used });
      if (decision.status === 'rejected') {
        record.status = 'rejected';
        record.reason = decision.reason;
        record.detail = decision.detail;
        continue;
      }
      record.status = 'accepted';
      if (pilotEligible) {
        pilotOpen = false;
        record.slot = 'pilot';
        used.set(entry.identity, 'pilot');
      } else {
        record.slot = 'scored';
        quota[entry.group] -= 1;
        used.set(entry.identity, 'scored');
      }
    }
    if (pilotOpen) throw new Error(`not enough ${category} candidates for the pilot question`);
    for (const [group, remaining] of Object.entries(quota)) {
      if (remaining > 0) throw new Error(`not enough ${category}/${group} candidates: ${remaining} more scored question(s) needed`);
    }
    categories[category] = records;
  }

  // Ids: a continued candidate keeps the id it had; ids freed by dropped candidates are reused first (lowest
  // first), then numbering continues after the highest id on record. Without a previous file, ids follow
  // category then rank order.
  const number = (prefix: 'q' | 'p', value: number): string => `${prefix}-${String(value).padStart(3, '0')}`;
  const recorded = new Map<string, string>();
  const highest = { q: 0, p: 0 };
  for (const records of Object.values(options.previous?.categories ?? {})) {
    for (const record of records) {
      if (record.status !== 'accepted' || record.questionId === undefined) continue;
      recorded.set(record.identity, record.questionId);
      const prefix = record.questionId.startsWith('p-') ? 'p' : 'q';
      highest[prefix] = Math.max(highest[prefix], Number(record.questionId.slice(2)));
    }
  }
  const kept = new Set<string>();
  for (const category of CategorySchema.options) {
    for (const record of categories[category]) {
      const id = recorded.get(record.identity);
      if (record.status !== 'accepted' || id === undefined || id.startsWith('p-') !== (record.slot === 'pilot')) continue;
      record.questionId = id;
      kept.add(id);
    }
  }
  const freed = (['q', 'p'] as const).map((prefix) =>
    [...recorded.values()].filter((id) => id.startsWith(`${prefix}-`) && !kept.has(id)).sort(),
  );
  const nextFreed = { q: freed[0], p: freed[1] };
  for (const category of CategorySchema.options) {
    for (const record of categories[category]) {
      if (record.status !== 'accepted' || record.questionId !== undefined) continue;
      const prefix = record.slot === 'pilot' ? 'p' : 'q';
      const reused = nextFreed[prefix].shift();
      if (reused !== undefined) {
        record.questionId = reused;
      } else {
        highest[prefix] += 1;
        record.questionId = number(prefix, highest[prefix]);
      }
    }
  }
  return {
    corpusId: options.corpusId,
    corpusSha: options.corpusSha,
    seed: options.seed,
    oracleVersion: ORACLE_VERSION,
    pilotCategories,
    categories,
  };
}

// ---------------------------------------------------------------------------------------------
// Question files from accepted candidates

/** The one sentence that closes every question text, so the answer format is the only shared instruction. */
export const CLOSING_SENTENCE = 'Give your answer in the required JSON form.';

/** The accepted candidates of one slot as questions, in id order; texts of existing questions with the same id and key are kept. */
export function scaffoldQuestions(
  candidates: CandidatesFile,
  slot: 'scored' | 'pilot',
  existing: QuestionFile | undefined,
): QuestionFile {
  const kept = new Map((existing?.questions ?? []).map((question) => [question.id, question]));
  const questions: Question[] = [];
  for (const category of CategorySchema.options) {
    for (const record of candidates.categories[category]) {
      if (record.status !== 'accepted' || record.slot !== slot || record.questionId === undefined) continue;
      const previous = kept.get(record.questionId);
      const same = previous !== undefined && JSON.stringify(previous.key) === JSON.stringify(record.key);
      questions.push({
        id: record.questionId,
        category,
        text: same ? previous.text : `TODO write the question text for ${record.identity}`,
        key: record.key,
      });
    }
  }
  questions.sort((a, b) => compareText(a.id, b.id));
  return { corpusId: candidates.corpusId, corpusSha: candidates.corpusSha, questions };
}

// ---------------------------------------------------------------------------------------------
// Answers files

const PreparedFileSchema = PreparedRecordCopySchema.extend({ dir: z.string() });

/** Adds the preparation record of the checkout (without its machine-specific `dir`) to an answers file. */
export function stampAnswers(answers: AnswerFile, record: PreparedRecordCopy): AnswerFile {
  if (answers.repoSha !== record.sha) {
    throw new Error(`the answers were computed at ${answers.repoSha} but the checkout was prepared at ${record.sha}`);
  }
  return { oracleVersion: answers.oracleVersion, repoSha: answers.repoSha, preparedRecord: record, answers: answers.answers };
}

// ---------------------------------------------------------------------------------------------
// The review document

export interface ReviewInput {
  questions: QuestionFile;
  answers: AnswerFile;
  pilotQuestions?: QuestionFile;
  pilotAnswers?: AnswerFile;
  candidates: CandidatesFile;
}

/** `file:line symbol` of an expected item; an item without a file (an unresolved citation) has none. */
function describeItem(item: AnswerItem): string | undefined {
  if (item.file === undefined) return undefined;
  const where = item.line === undefined ? item.file : `${item.file}:${item.line}`;
  return item.symbol === undefined ? where : `${where} ${item.symbol}`;
}

function percent(count: number, total: number): string {
  return `${total === 0 ? 0 : Math.round((100 * count) / total)}%`;
}

function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function describeProbe(key: KeySpec): string {
  if (key.kind !== 'abstain') return '';
  return 'adrNoFile' in key.probe
    ? `- Probe: ADR number ${key.probe.adrNoFile}, which no ADR file carries`
    : `- Probe: the name \`${key.probe.symbol}\`, which no tracked file mentions`;
}

function questionBlocks(heading: string, questions: QuestionFile, answers: AnswerFile): string[] {
  const lines: string[] = [`## ${heading}`, ''];
  const keys = new Map(answers.answers.map((answer) => [answer.questionId, answer]));
  for (const question of questions.questions) {
    const key = keys.get(question.id);
    if (key === undefined) throw new Error(`the answers file has no key for ${question.id}`);
    lines.push(`### ${question.id} (${question.category})`, '', `> ${question.text}`, '');
    lines.push(`- Key kind: ${question.key.kind}`);
    lines.push(`- Granularity: ${key.granularity}; equality: ${key.equality}`);
    if (key.abstain) {
      lines.push('- Expected answer: not found (abstain)');
      lines.push(describeProbe(question.key));
    } else {
      lines.push(`- Expected answers: ${projectedSize(key.items, key.granularity)} at granularity ${key.granularity} (${key.items.length} key items)`);
      const first = distinctAnswers(key.items, key.granularity).flatMap((item) => {
        const text = describeItem(item);
        return text === undefined ? [] : [`\`${text}\``];
      });
      lines.push(`- First expected: ${first.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * The document the user reads before approving the set (D-01): a pure function of the committed
 * question, answer and candidate files, with fixed ordering and no timestamp or machine path, so
 * running it twice gives the same bytes and a test can prove the committed copy is current.
 */
export function renderReview(input: ReviewInput): string {
  const { questions, answers, pilotQuestions, pilotAnswers, candidates } = input;
  const record = answers.preparedRecord;
  if (record === undefined) throw new Error('the answers file has no preparedRecord; run the stamp command');
  const scoredTotal = questions.questions.length;
  const pilotList = pilotQuestions?.questions ?? [];
  const lines: string[] = [];
  lines.push('# Question set review (plan 03-09)', '');
  lines.push('Drafted without running atlas: yes', '');
  lines.push(
    `Attestation. The ${scoredTotal} scored questions and the ${pilotList.length} pilot questions were drafted from the gsd-core source and ADRs. ` +
      'The candidates come from a compiler-derived census of the prepared checkout (the oracle\'s TypeScript program), ordered by a seeded shuffle; ' +
      'the texts were written by reading files and `git grep` on the checkout; the expected answers come from the oracle. ' +
      'No atlas command, no atlas MCP tool and no code-intelligence server was run or read while choosing or writing a question.',
    '',
  );
  lines.push('## Corpus and preparation', '');
  lines.push(`- Corpus: \`${questions.corpusId}\` at \`${questions.corpusSha}\``);
  lines.push(
    record.npmCi
      ? '- Prepared checkout: `npm ci --ignore-scripts`: yes'
      : '- Prepared checkout: `npm ci --ignore-scripts`: no (the bundled compiler is used)',
  );
  lines.push(`- Compiler used for the keys: ${record.typescriptVersion === null ? 'the bundled one' : `TypeScript ${record.typescriptVersion}`}`);
  lines.push(`- package-lock.json sha256 (CRLF read as LF): ${record.lockSha256 === null ? 'none' : `\`${record.lockSha256}\``}`);
  lines.push(`- Oracle version: \`${answers.oracleVersion}\``);
  lines.push(`- Candidate order seed: ${candidates.seed} (\`eval.bootstrapSeed\`)`);
  lines.push(`- Pilot categories (picked by the seed): ${candidates.pilotCategories.join(', ')}`);
  lines.push('');

  lines.push('## Summary', '', '| Category | Scored | Share | Pilot |', '| --- | --- | --- | --- |');
  for (const category of CategorySchema.options) {
    const scored = questions.questions.filter((question) => question.category === category).length;
    const pilot = pilotList.filter((question) => question.category === category).length;
    lines.push(`| ${category} | ${scored} | ${percent(scored, scoredTotal)} | ${pilot} |`);
  }
  lines.push(`| total | ${scoredTotal} | ${percent(scoredTotal, scoredTotal)} | ${pilotList.length} |`, '');

  lines.push('## How the questions were chosen', '');
  lines.push(
    'Candidates of each category were ordered by a seeded shuffle of the census (sorted by file and name first). ' +
      'One pass over that order looked at a candidate only while a slot was open for it, and passed over a candidate only for one of these rules:',
    '',
    '- `used-by-pilot`: its subject belongs to a pilot question.',
    '- `duplicate-symbol`: its subject is already used by an earlier question or by a free-alternatives scan question.',
    '- `ambiguous-name`: the name is declared more than once in the program, or the oracle refuses it as ambiguous (an abstain probe that matches something is the same case).',
    '- `unexplained`: the key has a textual mention the compiler result neither includes nor classifies, or an ADR citation without an ADR file.',
    `- \`empty\` and \`too-large\`: a non-abstain expected answer is empty, or larger than ${MAX_EXPECTED_ITEMS} entries at the key's granularity.`,
    '',
    'Candidates after the last one needed stay `unused`: they were never looked at, and a larger N continues the same order.',
    '',
  );

  lines.push(...questionBlocks('Scored questions', questions, answers));
  if (pilotQuestions !== undefined && pilotAnswers !== undefined) {
    lines.push(...questionBlocks('Pilot questions', pilotQuestions, pilotAnswers));
  }

  lines.push('## Rejected candidates', '');
  const all = CategorySchema.options.flatMap((category) => candidates.categories[category].map((entry) => ({ category, entry })));
  const rejected = all.filter(({ entry }) => entry.status === 'rejected');
  lines.push('| Reason | Count |', '| --- | --- |');
  for (const reason of CANDIDATE_REASONS) {
    lines.push(`| ${reason} | ${rejected.filter(({ entry }) => entry.reason === reason).length} |`);
  }
  lines.push(`| total | ${rejected.length} |`, '');
  lines.push('| Category | Candidates | Accepted | Rejected | Unused |', '| --- | --- | --- | --- | --- |');
  for (const category of CategorySchema.options) {
    const entries = candidates.categories[category];
    const count = (status: string): number => entries.filter((entry) => entry.status === status).length;
    lines.push(`| ${category} | ${entries.length} | ${count('accepted')} | ${count('rejected')} | ${count('unused')} |`);
  }
  lines.push('');
  for (const reason of CANDIDATE_REASONS) {
    const group = rejected.filter(({ entry }) => entry.reason === reason);
    if (group.length === 0) continue;
    lines.push(`### ${reason}`, '');
    for (const { category, entry } of group) {
      lines.push(`- ${category} rank ${entry.rank}, \`${entry.identity}\` (${entry.group}): ${tableCell(entry.detail ?? '')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = `usage:
  node scripts/eval/draft-census.ts --repo <dir> --tsconfig <file> --seed <n> --out <candidates.json> [--corpus-id <id>]
      census of the checkout and every ordered candidate as unused
  node scripts/eval/draft-census.ts draft --repo <dir> --tsconfig <file> --seed <n> --out <candidates.json> [--corpus-id <id>] [--scan <scan-questions.json>]
      the single drafting pass: decide candidates by the closed rules and assign question ids
      [--total <N>]: the scored mix for N questions (default 50)
      [--previous <candidates.json>]: continue that file: same order, rejections on record kept, accepted ones decided again
  node scripts/eval/draft-census.ts list --candidates <candidates.json>
      the accepted candidates (question id, key, facts) for the person writing the texts
  node scripts/eval/draft-census.ts scaffold --candidates <candidates.json> --questions-out <file> --pilot-out <file>
      question files from the accepted candidates; texts already written for the same id and key are kept
  node scripts/eval/draft-census.ts stamp --answers <answers.json> --checkout <dir>
      add the preparation record of the checkout to an answers file written by oracle.ts keys
  node scripts/eval/draft-census.ts review --questions <file> --answers <file> --candidates <file> --out <review.md> [--pilot-questions <file> --pilot-answers <file>]
      write the human review document from the committed files (byte-identical on every run)
`;

function repoHead(repoDir: string): string {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`cannot read the commit of ${repoDir}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
}

function writeJsonFile(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Identities of the free-alternatives scan questions, which the scored set must not repeat. */
function scanIdentities(file: string): string[] {
  const scan = z.object({ questions: z.array(z.object({ key: KeySpecSchema })) }).parse(readJsonFile(file));
  return scan.questions.map((question) => identityOfKey(question.key));
}

const OPTIONS = {
  repo: { type: 'string' },
  tsconfig: { type: 'string' },
  seed: { type: 'string' },
  out: { type: 'string' },
  'corpus-id': { type: 'string' },
  scan: { type: 'string' },
  total: { type: 'string' },
  previous: { type: 'string' },
  candidates: { type: 'string' },
  'questions-out': { type: 'string' },
  'pilot-out': { type: 'string' },
  answers: { type: 'string' },
  checkout: { type: 'string' },
  questions: { type: 'string' },
  'pilot-questions': { type: 'string' },
  'pilot-answers': { type: 'string' },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: string };

const DEFAULT_SCAN = path.join(import.meta.dirname, 'scan-questions.json');

async function runCensusCommand(command: 'skeleton' | 'draft', values: Values): Promise<number> {
  const seed = Number(values.seed);
  if (values.repo === undefined || values.tsconfig === undefined || values.out === undefined || !Number.isInteger(seed)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const ctx: OracleContext = { repoDir: values.repo, tsconfig: values.tsconfig };
  const census = await buildCensus(ctx);
  const base = { corpusId: values['corpus-id'] ?? 'gsd-core', corpusSha: repoHead(values.repo), seed };
  const total = values.total === undefined ? undefined : Number(values.total);
  if (total !== undefined && !Number.isInteger(total)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const file =
    command === 'skeleton'
      ? skeletonCandidates(census, base)
      : await draftCandidates(census, ctx, {
          ...base,
          reserved: scanIdentities(values.scan ?? DEFAULT_SCAN),
          ...(total === undefined ? {} : { mix: scaledMix(total) }),
          ...(values.previous === undefined ? {} : { previous: CandidatesFileSchema.parse(readJsonFile(values.previous)) }),
        });
  fs.writeFileSync(values.out, serializeCandidates(file));
  return 0;
}

function runList(values: Values): number {
  if (values.candidates === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const candidates = CandidatesFileSchema.parse(readJsonFile(values.candidates));
  const lines: string[] = [];
  for (const category of CategorySchema.options) {
    for (const record of candidates.categories[category]) {
      if (record.status !== 'accepted') continue;
      lines.push(`${record.questionId ?? '?'} ${category} ${record.group} size=${record.size ?? '-'} ${JSON.stringify(record.key)} ${JSON.stringify(record.facts ?? {})}`);
    }
  }
  process.stdout.write(`${lines.sort().join('\n')}\n`);
  return 0;
}

function runScaffold(values: Values): number {
  if (values.candidates === undefined || values['questions-out'] === undefined || values['pilot-out'] === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const candidates = CandidatesFileSchema.parse(readJsonFile(values.candidates));
  const previous = (file: string): QuestionFile | undefined => (fs.existsSync(file) ? loadQuestions(file) : undefined);
  writeJsonFile(values['questions-out'], scaffoldQuestions(candidates, 'scored', previous(values['questions-out'])));
  writeJsonFile(values['pilot-out'], scaffoldQuestions(candidates, 'pilot', previous(values['pilot-out'])));
  return 0;
}

function runReview(values: Values): number {
  if (
    values.questions === undefined ||
    values.answers === undefined ||
    values.candidates === undefined ||
    values.out === undefined ||
    (values['pilot-questions'] === undefined) !== (values['pilot-answers'] === undefined)
  ) {
    process.stderr.write(USAGE);
    return 2;
  }
  const input: ReviewInput = {
    questions: loadQuestions(values.questions),
    answers: AnswerFileSchema.parse(readJsonFile(values.answers)),
    candidates: CandidatesFileSchema.parse(readJsonFile(values.candidates)),
  };
  if (values['pilot-questions'] !== undefined && values['pilot-answers'] !== undefined) {
    input.pilotQuestions = loadQuestions(values['pilot-questions']);
    input.pilotAnswers = AnswerFileSchema.parse(readJsonFile(values['pilot-answers']));
  }
  fs.writeFileSync(values.out, renderReview(input));
  return 0;
}

function runStamp(values: Values): number {
  if (values.answers === undefined || values.checkout === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const { dir: _dir, ...record } = PreparedFileSchema.parse(readJsonFile(path.join(values.checkout, RECORD_FILE)));
  const stamped = stampAnswers(AnswerFileSchema.parse(readJsonFile(values.answers)), record);
  writeJsonFile(values.answers, stamped);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const subcommand = argv[0] !== undefined && !argv[0].startsWith('-') ? argv[0] : undefined;
  let values: Values;
  try {
    values = parseArgs({
      args: subcommand === undefined ? [...argv] : argv.slice(1),
      options: OPTIONS,
      allowPositionals: false,
    }).values;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    switch (subcommand) {
      case undefined:
        return await runCensusCommand('skeleton', values);
      case 'draft':
        return await runCensusCommand('draft', values);
      case 'list':
        return runList(values);
      case 'scaffold':
        return runScaffold(values);
      case 'stamp':
        return runStamp(values);
      case 'review':
        return runReview(values);
      default:
        process.stderr.write(`unknown command ${subcommand}\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
