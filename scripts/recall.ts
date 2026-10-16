import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import type { FileFacts } from '../src/facts/index.ts';
import { createGrammarEngine, extractFileFacts } from '../src/grammar-engine/index.ts';
import type { GrammarEngine, GrammarInput, LoadedGrammar, QueryKind } from '../src/grammar-engine/index.ts';
import { readModuleInputs } from '../src/lang/index.ts';
import { TRUTH_SUFFIX } from '../src/lang/test-runner.ts';

/**
 * node scripts/recall.ts [--module typescript|javascript] [--min 0.9]
 *
 * The per-construct recall gate of LNG-02 / D-05. For every language module it runs the real
 * Grammar Engine and extractor over the module's fixtures and compares what was found with the
 * hand-curated `<fixture>.truth.json` next to each fixture. Recall is reported once per construct
 * and never pooled: a weak construct is its own failing row, and a construct a language does not
 * have (no truth items at all) is `n/a`, not zero. The exit code is 1 when any applicable
 * construct is below the minimum.
 *
 * Truth is written by hand from the fixture text before the extractor is run on it. It is never
 * generated from the extractor's output (threat T-02-41).
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const defaultModuleRoot = path.join(repoRoot, 'modules');
const defaultModules: readonly string[] = ['typescript', 'javascript'];
export const DEFAULT_MIN_RECALL = 0.9;

/** The constructs LNG-02 / D-05 names. The order is the order of the printed table. */
export const CONSTRUCTS = [
  'function',
  'class',
  'interface',
  'type alias',
  'enum',
  'const/var',
  'method',
  'property',
  'containment',
  'ES import',
  'ES export',
  'CJS require',
  'CJS module.exports',
] as const;

export type Construct = (typeof CONSTRUCTS)[number];

/** What two items must share to be the same finding: name and 1-based line, plus the parent for containment. */
export interface MatchKey {
  readonly name: string;
  readonly line: number;
  readonly parent?: string;
  /** Keeps findings of different files apart when one construct is aggregated across files. */
  readonly file?: string;
}

export interface RecallItem extends MatchKey {
  readonly construct: Construct;
}

export interface ConstructRecall {
  readonly truth: number;
  readonly found: number;
  readonly matched: number;
  /** matched / truth, or null when the truth is empty (the construct is not applicable). */
  readonly recall: number | null;
}

function keyOf(item: MatchKey): string {
  return [item.file ?? '', item.parent ?? '', item.name, String(item.line)].join('\u0000');
}

/**
 * Compare found items with truth for one construct, as a multiset over (name, line, parent, file): a
 * duplicate in truth needs a duplicate in found, and extra found items never reduce recall.
 */
export function compareConstruct(truth: readonly MatchKey[], found: readonly MatchKey[]): ConstructRecall {
  const available = new Map<string, number>();
  for (const item of found) {
    const key = keyOf(item);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  let matched = 0;
  for (const item of truth) {
    const key = keyOf(item);
    const left = available.get(key) ?? 0;
    if (left > 0) {
      available.set(key, left - 1);
      matched += 1;
    }
  }
  return { truth: truth.length, found: found.length, matched, recall: truth.length === 0 ? null : matched / truth.length };
}

// ---------------------------------------------------------------------------------------------
// Extracted facts to constructs

const KIND_TO_CONSTRUCT: Readonly<Record<string, Construct | undefined>> = {
  function: 'function',
  class: 'class',
  interface: 'interface',
  type: 'type alias',
  enum: 'enum',
  constant: 'const/var',
  variable: 'const/var',
  method: 'method',
  property: 'property',
};

/** An export written as an assignment to module.exports or exports belongs to CommonJS; everything else to ES. */
const CJS_EXPORT_START = /^(module\.)?exports\b/;

function splitLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
}

function snippetAt(lines: readonly string[], line: number, column: number): string {
  return (lines[line] ?? '').slice(column, column + 24);
}

/** The constructs one file's facts contribute to, with 1-based lines. `text` classifies exports as ES or CommonJS. */
export function itemsFromFacts(facts: FileFacts, text: string): RecallItem[] {
  const items: RecallItem[] = [];
  const lines = splitLines(text);
  facts.symbols.forEach((symbol) => {
    const construct = KIND_TO_CONSTRUCT[symbol.kind];
    const line = symbol.span.startLine + 1;
    if (construct !== undefined) {
      items.push({ construct, name: symbol.name, line });
    }
    if (symbol.parent !== undefined) {
      const parent = facts.symbols[symbol.parent];
      if (parent !== undefined) {
        items.push({ construct: 'containment', name: symbol.name, parent: parent.name, line });
      }
    }
  });
  for (const site of facts.imports) {
    const line = site.span.startLine + 1;
    if (site.style === 'cjs') {
      items.push({ construct: 'CJS require', name: site.path, line });
    } else if (site.style === 'es' || site.style === 'side-effect') {
      items.push({ construct: 'ES import', name: site.path, line });
    }
  }
  for (const site of facts.exports ?? []) {
    const cjs = CJS_EXPORT_START.test(snippetAt(lines, site.span.startLine, site.span.startColumn));
    items.push({ construct: cjs ? 'CJS module.exports' : 'ES export', name: site.name, line: site.span.startLine + 1 });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Truth files

export class RecallTruthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallTruthError';
  }
}

export interface Truth {
  readonly fixture: string;
  readonly items: readonly RecallItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asLine(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RecallTruthError(`${where}: line must be a 1-based integer`);
  }
  return value;
}

function asName(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new RecallTruthError(`${where}: name must be a non-empty string`);
  }
  return value;
}

/** Parse one `.truth.json`. Items are `{construct, name, line}`; `parents` are `{child, parent, line}` containment pairs. */
export function parseTruth(json: unknown, where: string): Truth {
  if (!isRecord(json) || json['schema'] !== 1 || typeof json['fixture'] !== 'string' || !Array.isArray(json['items'])) {
    throw new RecallTruthError(`${where}: expected {schema: 1, fixture, items: [...], parents?: [...]}`);
  }
  const items: RecallItem[] = [];
  json['items'].forEach((raw: unknown, index) => {
    const at = `${where} items[${String(index)}]`;
    if (!isRecord(raw)) {
      throw new RecallTruthError(`${at}: not an object`);
    }
    const construct = raw['construct'];
    if (typeof construct !== 'string' || !(CONSTRUCTS as readonly string[]).includes(construct) || construct === 'containment') {
      throw new RecallTruthError(`${at}: unknown construct ${String(construct)}`);
    }
    items.push({ construct: construct as Construct, name: asName(raw['name'], at), line: asLine(raw['line'], at) });
  });
  const parents: unknown = json['parents'] ?? [];
  if (!Array.isArray(parents)) {
    throw new RecallTruthError(`${where}: parents must be an array`);
  }
  parents.forEach((raw: unknown, index) => {
    const at = `${where} parents[${String(index)}]`;
    if (!isRecord(raw)) {
      throw new RecallTruthError(`${at}: not an object`);
    }
    items.push({
      construct: 'containment',
      name: asName(raw['child'], at),
      parent: asName(raw['parent'], at),
      line: asLine(raw['line'], at),
    });
  });
  return { fixture: json['fixture'], items };
}

/** The truth files of a module's fixtures folder, in name order. */
export function readTruths(moduleDir: string): Truth[] {
  const fixtures = path.join(moduleDir, 'fixtures');
  if (!fs.existsSync(fixtures)) {
    return [];
  }
  return fs
    .readdirSync(fixtures)
    .filter((name) => name.endsWith(TRUTH_SUFFIX))
    .sort()
    .map((name) => {
      const file = path.join(fixtures, name);
      const truth = parseTruth(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, name);
      if (!fs.existsSync(path.join(fixtures, truth.fixture))) {
        throw new RecallTruthError(`${name}: fixture ${truth.fixture} does not exist`);
      }
      return truth;
    });
}

// ---------------------------------------------------------------------------------------------
// Running a module

export type QueryTransform = (module: string, kind: QueryKind, text: string) => string;

export interface OpenedModule {
  readonly name: string;
  readonly extensions: readonly string[];
  /** Run the grammar and the extractor over `text`; the facts' lines are 0-based, `items` use 1-based lines. */
  measure(filePath: string, text: string): Promise<{ readonly facts: FileFacts; readonly items: RecallItem[] }>;
}

/** Load a module's grammar with its own queries (optionally transformed) into `engine`. */
export async function openModule(moduleDir: string, engine: GrammarEngine, transform?: QueryTransform): Promise<OpenedModule> {
  const inputs = readModuleInputs(moduleDir);
  if (!inputs.ok) {
    throw new Error(`cannot read the module ${moduleDir}: ${inputs.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
  }
  const name = inputs.manifest.name;
  const queries: { tags?: string; refs?: string; imports?: string } = {};
  for (const kind of ['tags', 'refs', 'imports'] as const) {
    const text = inputs.input.queries[kind];
    if (text !== undefined) {
      queries[kind] = transform === undefined ? text : transform(name, kind, text);
    }
  }
  const input: GrammarInput = { ...inputs.input, queries };
  const grammar: LoadedGrammar = await engine.load(input);
  const version = inputs.manifest.version ?? 'unversioned';
  return {
    name,
    extensions: inputs.manifest.extensions,
    async measure(filePath, text) {
      const run = await grammar.run(text);
      const { facts } = extractFileFacts({
        path: filePath,
        contentHash: '0'.repeat(40),
        module: name,
        grammarVersion: version,
        run,
      });
      return { facts, items: itemsFromFacts(facts, text) };
    },
  };
}

/** Decode file bytes the way the engine expects: UTF-8, with the BOM kept so the engine can report it. */
export function decodeSource(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
}

export type RowStatus = 'ok' | 'fail' | 'n/a';

export interface RecallRow extends ConstructRecall {
  readonly construct: Construct;
  readonly status: RowStatus;
}

export interface ModuleReport {
  readonly module: string;
  readonly mode: 'fixtures' | 'corpus';
  /** What was measured: fixture names, or the number of sample files. */
  readonly sources: readonly string[];
  readonly rows: readonly RecallRow[];
  /** Files the engine could not run (counted per file, never fatal). */
  readonly failures: readonly string[];
}

export interface RecallReport {
  readonly ok: boolean;
  readonly min: number;
  readonly modules: readonly ModuleReport[];
}

export interface RecallOptions {
  /** Folder that holds the module folders. Default `<repo>/modules`. */
  readonly moduleRoot?: string;
  /** Module folder names. Default: every built-in module that has at least one truth file. */
  readonly modules?: readonly string[];
  /** Lowest acceptable recall of an applicable construct. Default 0.9. */
  readonly min?: number;
  /** Rewrites a module's query text before it is loaded. Tests use it to delete a pattern. */
  readonly queryTransform?: QueryTransform;
  /** Where the table goes. Default stdout. */
  readonly out?: (line: string) => void;
}

function rowsFrom(truth: readonly RecallItem[], found: readonly RecallItem[], min: number): RecallRow[] {
  return CONSTRUCTS.map((construct): RecallRow => {
    const compared = compareConstruct(
      truth.filter((item) => item.construct === construct),
      found.filter((item) => item.construct === construct),
    );
    const status: RowStatus = compared.recall === null ? 'n/a' : compared.recall >= min ? 'ok' : 'fail';
    return { construct, status, ...compared };
  });
}

/** Per-construct recall of one module over its fixtures. Throws when the module has no truth file. */
export async function measureFixtures(
  moduleDir: string,
  engine: GrammarEngine,
  min: number,
  transform?: QueryTransform,
): Promise<ModuleReport> {
  const truths = readTruths(moduleDir);
  if (truths.length === 0) {
    throw new RecallTruthError(`${moduleDir}: no ${TRUTH_SUFFIX} file in fixtures/`);
  }
  const opened = await openModule(moduleDir, engine, transform);
  const truth: RecallItem[] = [];
  const found: RecallItem[] = [];
  const failures: string[] = [];
  for (const entry of truths) {
    const text = decodeSource(fs.readFileSync(path.join(moduleDir, 'fixtures', entry.fixture)));
    for (const item of entry.items) {
      truth.push({ ...item, file: entry.fixture });
    }
    try {
      const measured = await opened.measure(entry.fixture, text);
      for (const item of measured.items) {
        found.push({ ...item, file: entry.fixture });
      }
    } catch (error) {
      failures.push(`${entry.fixture}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    module: opened.name,
    mode: 'fixtures',
    sources: truths.map((entry) => entry.fixture),
    rows: rowsFrom(truth, found, min),
    failures,
  };
}

function percent(recall: number | null): string {
  return recall === null ? 'n/a' : `${(recall * 100).toFixed(1)}%`;
}

/** One table per module: a row per construct, never a pooled total. */
export function renderReport(report: ModuleReport, min: number): string[] {
  const lines = [`module ${report.module} (${report.mode}: ${report.sources.length === 0 ? 'no sources' : report.sources.join(', ')}), minimum ${percent(min)}`];
  const widest = Math.max(...CONSTRUCTS.map((construct) => construct.length));
  lines.push(`${'construct'.padEnd(widest)}  ${'truth'.padStart(6)}  ${'found'.padStart(6)}  ${'matched'.padStart(7)}  ${'recall'.padStart(7)}  status`);
  for (const row of report.rows) {
    lines.push(
      `${row.construct.padEnd(widest)}  ${String(row.truth).padStart(6)}  ${String(row.found).padStart(6)}  ${String(row.matched).padStart(7)}  ${percent(row.recall).padStart(7)}  ${row.status}`,
    );
  }
  for (const failure of report.failures) {
    lines.push(`FAILED ${failure}`);
  }
  return lines;
}

function moduleHasTruth(moduleDir: string): boolean {
  return fs.existsSync(moduleDir) && readTruths(moduleDir).length > 0;
}

export function recallExitCode(report: RecallReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

/** Measure the requested modules, print one table per module, and say whether every applicable construct passed. */
export async function runRecall(options: RecallOptions = {}): Promise<RecallReport> {
  const min = options.min ?? DEFAULT_MIN_RECALL;
  const moduleRoot = options.moduleRoot ?? defaultModuleRoot;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const names = options.modules ?? defaultModules.filter((name) => moduleHasTruth(path.join(moduleRoot, name)));
  const engine = createGrammarEngine();
  const modules: ModuleReport[] = [];
  try {
    for (const name of names) {
      const report = await measureFixtures(path.join(moduleRoot, name), engine, min, options.queryTransform);
      modules.push(report);
      for (const line of renderReport(report, min)) {
        out(line);
      }
    }
  } finally {
    await engine.dispose();
  }
  const ok = modules.length > 0 && modules.every((report) => report.failures.length === 0 && report.rows.every((row) => row.status !== 'fail'));
  return { ok, min, modules };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  try {
    const { values } = parseArgs({
      options: { module: { type: 'string', multiple: true }, min: { type: 'string' } },
      strict: true,
    });
    const min = values.min === undefined ? DEFAULT_MIN_RECALL : Number(values.min);
    if (!Number.isFinite(min) || min < 0 || min > 1) {
      throw new Error(`--min must be a number from 0 to 1, got ${String(values.min)}`);
    }
    const report = await runRecall({
      min,
      ...(values.module === undefined ? {} : { modules: values.module }),
    });
    process.exitCode = recallExitCode(report);
  } catch (error) {
    process.stderr.write(`recall: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
