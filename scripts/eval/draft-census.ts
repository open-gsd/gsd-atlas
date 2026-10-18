import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import ts from 'typescript';
import { z } from 'zod';

import {
  ORACLE_VERSION,
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
  CategorySchema,
  KeySpecSchema,
  type AnswerItem,
  type AnswerKey,
  type Category,
  type Granularity,
  type KeySpec,
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

/** Questions in the pilot set, one each from this many different categories (`eval.pilotQuestions`). */
export const PILOT_COUNT = 5;

/** The largest expected answer a scored question may have, after projection to its granularity. */
export const MAX_EXPECTED_ITEMS = 30;

export function pickPilotCategories(_seed: number, _count: number): Category[] {
  return [];
}

/** The number of expected answers a model has to give for `items` at `granularity`. */
export function projectedSize(_items: readonly AnswerItem[], _granularity: Granularity): number {
  return 0;
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

export function decide(_input: DecideInput): Decision {
  return { status: 'accepted' };
}

export interface DraftOptions {
  seed: number;
  corpusId: string;
  corpusSha: string;
  /** Identities already used by questions outside this set (the scan questions). */
  reserved?: readonly string[];
  mix?: Readonly<Partial<Record<Category, Readonly<Record<string, number>>>>>;
  pilotCount?: number;
}

export async function draftCandidates(_census: Census, _ctx: OracleContext, options: DraftOptions): Promise<CandidatesFile> {
  return { corpusId: options.corpusId, corpusSha: options.corpusSha, seed: options.seed, oracleVersion: ORACLE_VERSION, pilotCategories: [], categories: {} as CandidatesFile['categories'] };
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = `usage:
  node scripts/eval/draft-census.ts --repo <dir> --tsconfig <file> --seed <n> --out <candidates.json> [--corpus-id <id>]
`;

function repoHead(repoDir: string): string {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`cannot read the commit of ${repoDir}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function main(argv: readonly string[]): Promise<number> {
  let values: { repo?: string; tsconfig?: string; seed?: string; out?: string; 'corpus-id'?: string };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        tsconfig: { type: 'string' },
        seed: { type: 'string' },
        out: { type: 'string' },
        'corpus-id': { type: 'string' },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const seed = Number(values.seed);
  if (values.repo === undefined || values.tsconfig === undefined || values.out === undefined || !Number.isInteger(seed)) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const census = await buildCensus({ repoDir: values.repo, tsconfig: values.tsconfig });
    const file = skeletonCandidates(census, {
      corpusId: values['corpus-id'] ?? 'gsd-core',
      corpusSha: repoHead(values.repo),
      seed,
    });
    fs.writeFileSync(values.out, serializeCandidates(file));
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
