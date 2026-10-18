/**
 * node scripts/edge-sample.ts --dir <prepared checkout> --seed <seed> [--n 100] [--out docs/eval/edge-sample.md]
 *                             [--store <facts.db or a store root>] [--tsconfig tsconfig.json] [--prepared]
 *
 * The precision of atlas's EXTRACTED facts on a checkout (plan 03-31, OQ9, PRD section 11 criterion 1, DESIGN A50).
 *
 * The population is every fact of six kinds that the Fact Store holds for the checkout: definitions, imports, exports,
 * precise reference edges, relations (extends, implements, overrides) and ADR citations. It is read with plain SQL over a
 * read-only connection to the store file, never through atlas's query layer, so a bug in Query cannot hide a bad stored
 * fact, and this script never writes to the store. A seeded, stratified sample is drawn (at least 10 facts per stratum
 * that has that many, the rest in proportion to the strata's sizes), and every sampled fact is then checked by code that
 * shares nothing with atlas: the source text, a fresh TypeScript parse, a fresh TypeScript program with its checker (the
 * helpers of the frozen oracle, scripts/eval/oracle.ts) and the oracle's comment scanner. A fact that cannot be checked
 * (the file is gone, differs from the indexed version, or is in no program) counts as wrong and is listed.
 *
 * Output: a Markdown review table (the fact, where it is, what atlas claims, the automatic verdict, a column for the human
 * reviewer) and the overall precision with its Wilson interval. Exit code 0 when precision is at least 0.98, 1 below,
 * 2 for a usage error or a store this script cannot read. Nothing in this file imports from `src/`; the numbers of the
 * store schema it was written for are listed in WRITTEN_FOR_SCHEMA_VERSION and a different store is refused.
 *
 * Tables read (store schema version 2): meta, overlays, overlay_files, files, names, symbols, imports, exports, citations,
 * resolved_edges, resolved_relations.
 *
 * Dev-time tooling: nothing in the shipped package imports it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import {
  canon,
  citationsIn,
  commentRanges,
  computeLineStarts,
  relInside,
  resolveHeritageSymbol,
  resolveRequireSpec,
  stateOf,
  symbolAt,
  walk,
} from './eval/oracle.ts';
import type { OracleContext, State, Unit } from './eval/oracle.ts';
import { mulberry32, wilsonInterval } from './eval/stats.ts';

// ---------------------------------------------------------------------------------------------
// Constants

/** The store schema version this script reads. A store with another version is refused with a clear message. */
export const WRITTEN_FOR_SCHEMA_VERSION = 2;

/** The strata of the sample, in the order of the table. */
export const STRATA = ['definition', 'import', 'export', 'reference_edge', 'relation', 'citation'] as const;
export type Stratum = (typeof STRATA)[number];

/** The relation kinds the table lists even when the corpus has none (gsd-core has no `implements` and no `overrides`). */
export const RELATION_KINDS_LISTED = ['extends', 'implements', 'overrides'] as const;

/** The least number of facts drawn from a stratum that has that many. */
const MIN_PER_STRATUM = 10;

/** The gate of PRD criterion 1: at least 98 percent of the sample is correct (integer arithmetic: correct / total >= 49 / 50). */
const GATE_NUMERATOR = 49;
const GATE_DENOMINATOR = 50;

/** The normal quantile of the 95 percent two-sided Wilson interval. */
const WILSON_Z = 1.96;

const STORE_BUSY_MS = 5000;

const MAX_CELL_CHARS = 200;

/** Where the hand-written part of the review table starts; a regeneration keeps everything from here on. */
export const NOTES_MARKER = '<!-- edge-sample:notes -->';

const DEFAULT_NOTES = `${NOTES_MARKER}

## Notes

No notes yet. Record here, for every fact that was wrong or unverifiable in an earlier run, its cause and the commit that fixed it, and every inherent limit of a stratum.

## Human confirmation

Status: pending

PRD criterion 1 asks for a hand-verified sample. A person opens the twenty rows whose # is a multiple of five (5, 10, ..., 100), reads the cited file at the cited line in the prepared checkout, and confirms that the stated fact is true. Record the person, the date and the result here.
`;

// ---------------------------------------------------------------------------------------------
// Facts

/** A span as the store keeps it: 0-based lines and UTF-16 code unit columns. */
export interface Span {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

interface FactBase {
  /** A key that identifies the fact in its population: the stratum plus the store's own identity of the row. */
  readonly key: string;
  /** The repository-relative path the fact is about (the importing file, the file of the site, the subtype's file). */
  readonly path: string;
  /** The blob id the overlay records for `path`; null when the overlay does not hold the path. */
  readonly hash: string | null;
}

export interface DefinitionFact extends FactBase {
  readonly stratum: 'definition';
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly span: Span;
}

export interface ImportFact extends FactBase {
  readonly stratum: 'import';
  readonly specifier: string;
  readonly style: string | null;
  readonly span: Span;
}

export interface ExportFact extends FactBase {
  readonly stratum: 'export';
  readonly name: string;
  readonly local: string | null;
  readonly fromPath: string | null;
  readonly span: Span;
}

export interface ReferenceEdgeFact extends FactBase {
  readonly stratum: 'reference_edge';
  readonly name: string;
  readonly targetPath: string;
  readonly targetQualifiedName: string;
  readonly targetKind: string;
  readonly resolver: string;
  readonly span: Span;
}

export interface RelationFact extends FactBase {
  readonly stratum: 'relation';
  readonly relation: string;
  /** `path` is the file of the subtype (or of the overriding member). */
  readonly fromQualifiedName: string;
  readonly fromKind: string;
  readonly toPath: string;
  readonly toQualifiedName: string;
  readonly toKind: string;
  readonly resolver: string;
  /** The definition span of the `from` symbol when the store holds it; relations have no site of their own. */
  readonly span: Span | null;
}

export interface CitationFact extends FactBase {
  readonly stratum: 'citation';
  readonly number: number;
  readonly detail: string | null;
  readonly span: Span;
}

export type Fact = DefinitionFact | ImportFact | ExportFact | ReferenceEdgeFact | RelationFact | CitationFact;

export type Strata = { readonly [S in Stratum]: readonly Fact[] };

export interface LoadedPopulation {
  readonly strata: Strata;
  readonly schemaVersion: number;
  /** The overlay (worktree path) the facts belong to. */
  readonly worktree: string;
  /** Every path of the overlay: what the index holds. */
  readonly overlayPaths: ReadonlySet<string>;
}

export class SampleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SampleError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// The population (read-only SQL over the store file)

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new SampleError('store_row', `column ${key} is not text: ${String(value)}`);
  return value;
}

function maybeText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new SampleError('store_row', `column ${key} is not text: ${String(value)}`);
  return value;
}

function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new SampleError('store_row', `column ${key} is not a number: ${String(value)}`);
}

function spanOf(row: Row, startLine: string, startColumn: string, endLine: string, endColumn: string): Span {
  return { startLine: int(row, startLine), startColumn: int(row, startColumn), endLine: int(row, endLine), endColumn: int(row, endColumn) };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every fact of the six strata for one overlay of the store at `dbPath`, in a fixed order. The connection is read-only.
 * `worktree` names the overlay; without it the store must hold exactly one.
 */
export function loadPopulation(dbPath: string, options: { readonly worktree?: string } = {}): LoadedPopulation {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: STORE_BUSY_MS });
  } catch (error) {
    throw new SampleError('store_unreadable', `cannot open the store ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const all = (sql: string, ...params: string[]): Row[] => db.prepare(sql).all(...params) as Row[];

    const versionRow = all("SELECT value FROM meta WHERE name = 'schema_version'")[0];
    const schemaVersion = versionRow === undefined ? Number.NaN : Number(text(versionRow, 'value'));
    if (schemaVersion !== WRITTEN_FOR_SCHEMA_VERSION) {
      throw new SampleError(
        'schema_version',
        `the store has schema version ${String(schemaVersion)}; scripts/edge-sample.ts was written for version ${String(WRITTEN_FOR_SCHEMA_VERSION)}. Read the new schema, update the queries and verifiers, and raise WRITTEN_FOR_SCHEMA_VERSION.`,
      );
    }

    const overlays = all('SELECT worktree FROM overlays ORDER BY worktree').map((row) => text(row, 'worktree'));
    let worktree: string;
    if (options.worktree !== undefined) {
      if (!overlays.includes(options.worktree)) {
        throw new SampleError('no_overlay', `the store has no overlay for ${options.worktree}; its overlays are: ${overlays.join(', ') || '(none)'}`);
      }
      worktree = options.worktree;
    } else if (overlays.length === 1) {
      worktree = overlays[0] as string;
    } else {
      throw new SampleError('no_overlay', `the store holds ${String(overlays.length)} overlays (${overlays.join(', ')}); name one with the checkout directory`);
    }

    for (const table of ['resolved_edges', 'resolved_relations']) {
      const snapshots = all(`SELECT COUNT(DISTINCT snapshot) AS c FROM ${table}`)[0];
      if (snapshots !== undefined && int(snapshots, 'c') > 1) {
        throw new SampleError('several_snapshots', `${table} holds facts of several snapshots; sample an index built fresh in an empty store directory`);
      }
    }

    const overlayPaths = new Set(all('SELECT path FROM overlay_files WHERE worktree = ?', worktree).map((row) => text(row, 'path')));
    const hashOf = new Map(all('SELECT path, hash FROM overlay_files WHERE worktree = ?', worktree).map((row) => [text(row, 'path'), text(row, 'hash')] as const));

    const definitions: Fact[] = all(
      `SELECT o.path AS path, s.ord AS ord, n.name AS name, q.name AS qname, s.kind AS kind,
              s.start_line AS start_line, s.start_col AS start_col, s.end_line AS end_line, s.end_col AS end_col
         FROM overlay_files o
         JOIN files f ON f.id = o.file_id AND f.state = 'live'
         JOIN symbols s ON s.file_id = f.id
         JOIN names n ON n.id = s.name_id
         LEFT JOIN names q ON q.id = s.qname_id
        WHERE o.worktree = ?
        ORDER BY o.path, s.ord`,
      worktree,
    ).map(
      (row): DefinitionFact => ({
        stratum: 'definition',
        key: `definition|${text(row, 'path')}|${String(int(row, 'ord'))}`,
        path: text(row, 'path'),
        hash: hashOf.get(text(row, 'path')) ?? null,
        name: text(row, 'name'),
        qualifiedName: maybeText(row, 'qname') ?? text(row, 'name'),
        kind: text(row, 'kind'),
        span: spanOf(row, 'start_line', 'start_col', 'end_line', 'end_col'),
      }),
    );

    const imports: Fact[] = all(
      `SELECT o.path AS path, i.ord AS ord, i.path AS specifier, i.style AS style,
              i.start_line AS start_line, i.start_col AS start_col, i.end_line AS end_line, i.end_col AS end_col
         FROM overlay_files o
         JOIN files f ON f.id = o.file_id AND f.state = 'live'
         JOIN imports i ON i.file_id = f.id
        WHERE o.worktree = ?
        ORDER BY o.path, i.ord`,
      worktree,
    ).map(
      (row): ImportFact => ({
        stratum: 'import',
        key: `import|${text(row, 'path')}|${String(int(row, 'ord'))}`,
        path: text(row, 'path'),
        hash: hashOf.get(text(row, 'path')) ?? null,
        specifier: text(row, 'specifier'),
        style: maybeText(row, 'style'),
        span: spanOf(row, 'start_line', 'start_col', 'end_line', 'end_col'),
      }),
    );

    const exports: Fact[] = all(
      `SELECT o.path AS path, e.ord AS ord, n.name AS name, l.name AS local_name, e.from_path AS from_path,
              e.start_line AS start_line, e.start_col AS start_col, e.end_line AS end_line, e.end_col AS end_col
         FROM overlay_files o
         JOIN files f ON f.id = o.file_id AND f.state = 'live'
         JOIN exports e ON e.file_id = f.id
         JOIN names n ON n.id = e.name_id
         LEFT JOIN names l ON l.id = e.local_id
        WHERE o.worktree = ?
        ORDER BY o.path, e.ord`,
      worktree,
    ).map(
      (row): ExportFact => ({
        stratum: 'export',
        key: `export|${text(row, 'path')}|${String(int(row, 'ord'))}`,
        path: text(row, 'path'),
        hash: hashOf.get(text(row, 'path')) ?? null,
        name: text(row, 'name'),
        local: maybeText(row, 'local_name'),
        fromPath: maybeText(row, 'from_path'),
        span: spanOf(row, 'start_line', 'start_col', 'end_line', 'end_col'),
      }),
    );

    const edges: Fact[] = all(
      `SELECT site_path, start_line, start_column, end_line, end_column, name, target_path, target_qualified_name,
              target_kind, target_discriminator, resolver, context_id
         FROM resolved_edges
        ORDER BY site_path, start_line, start_column, end_line, end_column, name, target_path, target_qualified_name,
                 target_kind, target_discriminator, context_id`,
    ).map(
      (row): ReferenceEdgeFact => ({
        stratum: 'reference_edge',
        key: [
          'reference_edge',
          text(row, 'site_path'),
          int(row, 'start_line'),
          int(row, 'start_column'),
          int(row, 'end_line'),
          int(row, 'end_column'),
          text(row, 'name'),
          text(row, 'target_path'),
          text(row, 'target_qualified_name'),
          text(row, 'target_kind'),
          text(row, 'target_discriminator'),
          int(row, 'context_id'),
        ].join('|'),
        path: text(row, 'site_path'),
        hash: hashOf.get(text(row, 'site_path')) ?? null,
        name: text(row, 'name'),
        targetPath: text(row, 'target_path'),
        targetQualifiedName: text(row, 'target_qualified_name'),
        targetKind: text(row, 'target_kind'),
        resolver: text(row, 'resolver'),
        span: spanOf(row, 'start_line', 'start_column', 'end_line', 'end_column'),
      }),
    );

    const symbolSpan = db.prepare(
      `SELECT s.start_line AS start_line, s.start_col AS start_col, s.end_line AS end_line, s.end_col AS end_col
         FROM overlay_files o
         JOIN symbols s ON s.file_id = o.file_id
         JOIN names q ON q.id = s.qname_id
        WHERE o.worktree = ? AND o.path = ? AND q.name = ? AND s.kind = ?
        ORDER BY s.ord
        LIMIT 1`,
    );
    const relations: Fact[] = all(
      `SELECT from_path, from_qualified_name, from_kind, from_discriminator, to_path, to_qualified_name, to_kind,
              to_discriminator, relation, resolver, context_id
         FROM resolved_relations
        ORDER BY from_path, from_qualified_name, from_kind, from_discriminator, to_path, to_qualified_name, to_kind,
                 to_discriminator, relation, context_id`,
    ).map((row): RelationFact => {
      const located = symbolSpan.get(worktree, text(row, 'from_path'), text(row, 'from_qualified_name'), text(row, 'from_kind')) as Row | undefined;
      return {
        stratum: 'relation',
        key: [
          'relation',
          text(row, 'from_path'),
          text(row, 'from_qualified_name'),
          text(row, 'from_kind'),
          text(row, 'from_discriminator'),
          text(row, 'to_path'),
          text(row, 'to_qualified_name'),
          text(row, 'to_kind'),
          text(row, 'to_discriminator'),
          text(row, 'relation'),
          int(row, 'context_id'),
        ].join('|'),
        path: text(row, 'from_path'),
        hash: hashOf.get(text(row, 'from_path')) ?? null,
        relation: text(row, 'relation'),
        fromQualifiedName: text(row, 'from_qualified_name'),
        fromKind: text(row, 'from_kind'),
        toPath: text(row, 'to_path'),
        toQualifiedName: text(row, 'to_qualified_name'),
        toKind: text(row, 'to_kind'),
        resolver: text(row, 'resolver'),
        span: located === undefined ? null : spanOf(located, 'start_line', 'start_col', 'end_line', 'end_col'),
      };
    });

    const citations: Fact[] = all(
      `SELECT o.path AS path, c.ord AS ord, c.number AS number, c.detail AS detail,
              c.start_line AS start_line, c.start_col AS start_col, c.end_line AS end_line, c.end_col AS end_col
         FROM overlay_files o
         JOIN files f ON f.id = o.file_id AND f.state = 'live'
         JOIN citations c ON c.file_id = f.id
        WHERE o.worktree = ?
        ORDER BY o.path, c.ord`,
      worktree,
    ).map(
      (row): CitationFact => ({
        stratum: 'citation',
        key: `citation|${text(row, 'path')}|${String(int(row, 'ord'))}`,
        path: text(row, 'path'),
        hash: hashOf.get(text(row, 'path')) ?? null,
        number: int(row, 'number'),
        detail: maybeText(row, 'detail'),
        span: spanOf(row, 'start_line', 'start_col', 'end_line', 'end_col'),
      }),
    );

    return {
      strata: { definition: definitions, import: imports, export: exports, reference_edge: edges, relation: relations, citation: citations },
      schemaVersion,
      worktree,
      overlayPaths,
    };
  } finally {
    db.close();
  }
}

/** The one store file under an override root (`GSD_ATLAS_STORE_DIR`), or the file itself when `root` is one. */
export function findStoreFile(root: string): string {
  const stat = fs.statSync(root, { throwIfNoEntry: false });
  if (stat === undefined) throw new SampleError('store_missing', `no store at ${root}`);
  if (stat.isFile()) return root;
  const direct = path.join(root, 'facts.db');
  if (fs.existsSync(direct)) return direct;
  const stores = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'facts.db')));
  if (stores.length !== 1) {
    throw new SampleError('store_missing', `expected one store under ${root}, found ${String(stores.length)}; name the file with --store`);
  }
  return path.join(root, (stores[0] as fs.Dirent).name, 'facts.db');
}

// ---------------------------------------------------------------------------------------------
// The draw

/** How many facts to take from each stratum: at least the floor, then the rest in proportion to the strata's sizes. */
function allocate(sizes: Readonly<Record<Stratum, number>>, n: number): Record<Stratum, number> {
  const total = STRATA.reduce((sum, stratum) => sum + sizes[stratum], 0);
  const target = Math.min(n, total);
  const populated = STRATA.filter((stratum) => sizes[stratum] > 0);
  const given: Record<Stratum, number> = { definition: 0, import: 0, export: 0, reference_edge: 0, relation: 0, citation: 0 };
  if (populated.length === 0) return given;
  const floor = Math.min(MIN_PER_STRATUM, Math.floor(target / populated.length));
  for (const stratum of populated) given[stratum] = Math.min(sizes[stratum], floor);
  let rest = target - STRATA.reduce((sum, stratum) => sum + given[stratum], 0);
  while (rest > 0) {
    const open = STRATA.filter((stratum) => given[stratum] < sizes[stratum]);
    if (open.length === 0) break;
    const weight = open.reduce((sum, stratum) => sum + sizes[stratum], 0);
    const shares = open.map((stratum, order) => {
      const exact = (rest * sizes[stratum]) / weight;
      const whole = Math.min(Math.floor(exact), sizes[stratum] - given[stratum]);
      return { stratum, whole, remainder: exact - Math.floor(exact), order };
    });
    for (const share of shares) {
      given[share.stratum] += share.whole;
      rest -= share.whole;
    }
    const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.order - b.order);
    for (const share of byRemainder) {
      if (rest <= 0) break;
      if (given[share.stratum] < sizes[share.stratum]) {
        given[share.stratum] += 1;
        rest -= 1;
      }
    }
  }
  return given;
}

/**
 * A deterministic stratified sample of `n` facts (fewer when the population is smaller): the same strata, `n` and `seed`
 * give the same list on every platform. A stratum with no facts is skipped and the sample is topped up from the others in
 * proportion to their sizes. Facts come out in stratum order, then in population order; none is drawn twice.
 */
export function drawSample(strata: Strata, n: number, seed: number): Fact[] {
  const sizes = Object.fromEntries(STRATA.map((stratum) => [stratum, strata[stratum].length])) as Record<Stratum, number>;
  const counts = allocate(sizes, n);
  const out: Fact[] = [];
  STRATA.forEach((stratum, index) => {
    const facts = strata[stratum];
    const take = counts[stratum];
    if (take === 0) return;
    const random = mulberry32((seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    const order = facts.map((_, position) => position);
    for (let i = 0; i < take; i += 1) {
      const j = i + Math.floor(random() * (order.length - i));
      const swap = order[i] as number;
      order[i] = order[j] as number;
      order[j] = swap;
    }
    const chosen = order.slice(0, take).sort((a, b) => a - b);
    for (const position of chosen) out.push(facts[position] as Fact);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Verdicts

export type VerdictKind = 'correct' | 'wrong' | 'unverifiable';

export interface Verdict {
  readonly verdict: VerdictKind;
  readonly reason: string;
}

const right = (reason: string): Verdict => ({ verdict: 'correct', reason });
const wrong = (reason: string): Verdict => ({ verdict: 'wrong', reason });
const unverifiable = (reason: string): Verdict => ({ verdict: 'unverifiable', reason });

// ---------------------------------------------------------------------------------------------
// Sources, programs and positions (the verifier's own view of the checkout)

export interface Source {
  readonly rel: string;
  readonly text: string;
  readonly starts: readonly number[];
  readonly sf: ts.SourceFile;
}

export type SourceOutcome = { readonly source: Source } | { readonly problem: string };

export interface ProgramSite {
  readonly state: State;
  readonly unit: Unit;
}

export type ProgramOutcome = { readonly site: ProgramSite } | { readonly problem: string };

export interface VerifyEnv {
  readonly repoDir: string;
  /** Every path the index holds for the checkout. */
  readonly overlayPaths: ReadonlySet<string>;
  /** The file as the index saw it: read from the checkout and checked against the blob id the overlay recorded. */
  source(rel: string, hash: string | null): SourceOutcome;
  /** The file in a fresh TypeScript program built from the checkout's own tsconfig files. */
  program(rel: string): ProgramOutcome;
  /** Some program of the checkout (for the oracle's emit-aware path resolution). */
  anyState(): State | undefined;
}

function scriptKindOf(rel: string): ts.ScriptKind {
  switch (path.extname(rel).toLowerCase()) {
    case '.js':
    case '.cjs':
    case '.mjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

/** The git blob id of `bytes` as git computes it with no clean filter: the hash algorithm follows the id's length. */
function blobId(bytes: Buffer, expected: string): string | undefined {
  const algorithm = expected.length === 40 ? 'sha1' : expected.length === 64 ? 'sha256' : undefined;
  if (algorithm === undefined) return undefined;
  return createHash(algorithm).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

function gitOutput(cwd: string, args: readonly string[]): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env, windowsHide: true, maxBuffer: 1 << 26 });
  return result.status === 0 ? result.stdout : undefined;
}

/** The tsconfig files tracked in the checkout, the requested one first, then by depth and path. */
function configCandidates(repoDir: string, requested: string): string[] {
  const listed = (gitOutput(repoDir, ['ls-files', '-z']) ?? '')
    .split('\0')
    .filter((entry) => entry !== '' && /(^|\/)tsconfig[^/]*\.json$/.test(entry) && !entry.split('/').includes('node_modules'));
  const others = listed
    .filter((entry) => entry !== requested)
    .sort((a, b) => a.split('/').length - b.split('/').length || compareText(a, b));
  return [requested, ...others];
}

/**
 * A declaration file (`.d.ts`, `.d.cts`, `.d.mts`) the checkout's program includes. The oracle leaves declaration files
 * out of its units, but the store holds definitions and reference sites in them, so they are looked up in the program.
 */
function declarationUnit(state: State, root: string, rel: string): Unit | undefined {
  if (!/\.d\.[cm]?ts$/.test(rel)) return undefined;
  const sf = state.program.getSourceFile(path.resolve(root, ...rel.split('/')));
  if (sf === undefined || !sf.isDeclarationFile || state.program.isSourceFileFromExternalLibrary(sf) || state.program.isSourceFileDefaultLibrary(sf)) return undefined;
  return { rel, sf, lineStarts: computeLineStarts(sf.text), checker: state.checker, program: state.program, main: true };
}

export function createVerifyEnv(options: { readonly repoDir: string; readonly overlayPaths: ReadonlySet<string>; readonly tsconfig?: string }): VerifyEnv {
  const requested = options.tsconfig ?? 'tsconfig.json';
  let root = options.repoDir;
  try {
    root = fs.realpathSync.native(options.repoDir);
  } catch {
    // A missing checkout makes every fact unverifiable below; the path stays as given.
  }
  const sources = new Map<string, SourceOutcome>();
  const contexts = new Map<string, OracleContext>();
  const states = new Map<string, State | { readonly problem: string }>();
  const programs = new Map<string, ProgramOutcome>();
  let candidates: string[] | undefined;

  const stateFor = (config: string): State | { readonly problem: string } => {
    const known = states.get(config);
    if (known !== undefined) return known;
    let context = contexts.get(config);
    if (context === undefined) {
      context = { repoDir: root, tsconfig: config };
      contexts.set(config, context);
    }
    let built: State | { readonly problem: string };
    try {
      built = stateOf(context);
    } catch (error) {
      built = { problem: `${config}: ${error instanceof Error ? error.message : String(error)}` };
    }
    states.set(config, built);
    return built;
  };

  return {
    repoDir: root,
    overlayPaths: options.overlayPaths,
    source(rel, hash): SourceOutcome {
      const cacheKey = `${rel}\0${hash ?? ''}`;
      const cached = sources.get(cacheKey);
      if (cached !== undefined) return cached;
      let outcome: SourceOutcome;
      const absolute = path.resolve(root, ...rel.split('/'));
      if (relInside(root, absolute) === undefined) {
        outcome = { problem: `${rel} lies outside the checkout` };
      } else if (hash === null) {
        outcome = { problem: `${rel} is not in the index's overlay, so there is no indexed version to compare` };
      } else {
        let bytes: Buffer | undefined;
        try {
          bytes = fs.readFileSync(absolute);
        } catch {
          bytes = undefined;
        }
        if (bytes === undefined) {
          outcome = { problem: `${rel} cannot be read from the checkout` };
        } else if (blobId(bytes, hash) !== hash) {
          outcome = { problem: `${rel} differs from the version the index recorded (${hash.slice(0, 10)})` };
        } else {
          const fileText = bytes.toString('utf8');
          const sf = ts.createSourceFile(absolute, fileText, ts.ScriptTarget.ESNext, true, scriptKindOf(rel));
          outcome = { source: { rel, text: fileText, starts: computeLineStarts(fileText), sf } };
        }
      }
      sources.set(cacheKey, outcome);
      return outcome;
    },
    program(rel): ProgramOutcome {
      const cached = programs.get(rel);
      if (cached !== undefined) return cached;
      candidates ??= configCandidates(root, requested);
      const problems: string[] = [];
      let outcome: ProgramOutcome | undefined;
      for (const config of candidates) {
        const state = stateFor(config);
        if ('problem' in state) {
          problems.push(state.problem);
          continue;
        }
        const unit = state.units.get(rel) ?? declarationUnit(state, root, rel);
        if (unit !== undefined && unit.checker !== undefined) {
          outcome = { site: { state, unit } };
          break;
        }
      }
      outcome ??= { problem: `${rel} is in no TypeScript program built from the checkout's tsconfig files${problems.length > 0 ? ` (${problems.join('; ')})` : ''}` };
      programs.set(rel, outcome);
      return outcome;
    },
    anyState(): State | undefined {
      candidates ??= configCandidates(root, requested);
      for (const config of candidates) {
        const state = stateFor(config);
        if (!('problem' in state)) return state;
      }
      return undefined;
    },
  };
}

/** The offset of a (line, column) of the store in `fileText`, or undefined when it lies outside the text. */
function positionOf(starts: readonly number[], fileText: string, line: number, column: number): number | undefined {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0 || line >= starts.length) return undefined;
  const position = (starts[line] as number) + column;
  const lineEnd = line + 1 < starts.length ? (starts[line + 1] as number) : fileText.length;
  return position <= lineEnd ? position : undefined;
}

interface Located {
  readonly start: number;
  readonly end: number;
}

function locate(starts: readonly number[], fileText: string, span: Span): Located | undefined {
  const start = positionOf(starts, fileText, span.startLine, span.startColumn);
  const end = positionOf(starts, fileText, span.endLine, span.endColumn);
  return start === undefined || end === undefined || end < start ? undefined : { start, end };
}

/** A node begins where the span begins, or only after `export`, `default` and `declare` keywords the grammar leaves out. */
function startFits(fileText: string, nodeStart: number, spanStart: number): boolean {
  if (nodeStart === spanStart) return true;
  if (nodeStart > spanStart) return false;
  return /^(?:\s*\b(?:export|default|declare)\b)+\s*$/.test(fileText.slice(nodeStart, spanStart));
}

/** A node ends where the span ends, give or take one `;` or `,` that one side counts and the other leaves out. */
function endFits(fileText: string, nodeEnd: number, spanEnd: number): boolean {
  if (nodeEnd === spanEnd) return true;
  const between = nodeEnd > spanEnd ? fileText.slice(spanEnd, nodeEnd) : fileText.slice(nodeEnd, spanEnd);
  return /^\s*[;,]\s*$/.test(between);
}

// ---------------------------------------------------------------------------------------------
// Declarations (the verifier's own reading of what a definition is)

interface DeclInfo {
  readonly name: string;
  readonly kinds: readonly string[];
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** What a declaration node defines, by the vocabulary of the grammar modules: function, class, interface, type, enum, namespace, method, property, constant, variable. */
function declInfo(node: ts.Node): DeclInfo | undefined {
  if (ts.isFunctionDeclaration(node)) {
    const name = nameText(node.name);
    return name === undefined ? undefined : { name, kinds: ['function'] };
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const name = nameText(node.name);
    return name === undefined ? undefined : { name, kinds: ['class'] };
  }
  if (ts.isInterfaceDeclaration(node)) return { name: node.name.text, kinds: ['interface'] };
  if (ts.isTypeAliasDeclaration(node)) return { name: node.name.text, kinds: ['type'] };
  if (ts.isEnumDeclaration(node)) return { name: node.name.text, kinds: ['enum'] };
  if (ts.isModuleDeclaration(node)) {
    const name = nameText(node.name);
    return name === undefined ? undefined : { name, kinds: ['namespace'] };
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = nameText(node.name);
    return name === undefined ? undefined : { name, kinds: ['method'] };
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    const name = nameText(node.name);
    return name === undefined ? undefined : { name, kinds: ['property'] };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return { name: node.name.text, kinds: ['function'] };
    const list = node.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    return { name: node.name.text, kinds: [isConst ? 'constant' : 'variable'] };
  }
  return undefined;
}

/**
 * Whether a declaration is a definition in the scoping rules the grammar modules document (modules/typescript and
 * modules/javascript, queries/tags.scm): functions anywhere (also a const, let or var bound arrow or function
 * expression), classes, interfaces, type aliases, enums and namespaces anywhere but a class expression is not a class
 * definition, methods only in class bodies and as interface method signatures, properties only as class fields and
 * interface members, and a plain const, let or var (one that is not a function or a class) only at module top level.
 * A qualified name is the chain of such definitions around a definition, so this is what its check follows.
 */
function scopedDefinition(node: ts.Node): DeclInfo | undefined {
  const info = declInfo(node);
  if (info === undefined || ts.isClassExpression(node)) return undefined;
  const parent = node.parent;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return ts.isClassLike(parent) ? info : undefined;
  }
  if (ts.isMethodSignature(node) || ts.isPropertySignature(node)) return ts.isInterfaceDeclaration(parent) ? info : undefined;
  if (ts.isPropertyDeclaration(node)) return ts.isClassLike(parent) ? info : undefined;
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer;
    if (init !== undefined && (ts.isClassExpression(init) || (ts.isFunctionExpression(init) && init.asteriskToken !== undefined))) return undefined;
    if (info.kinds.includes('function')) return info;
    const statement = ts.isVariableDeclarationList(parent) ? parent.parent : undefined;
    return statement !== undefined && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) ? info : undefined;
  }
  return info;
}

/** The names of the enclosing definitions of a node, outermost first. */
function containerNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    const info = scopedDefinition(current);
    if (info !== undefined) names.unshift(info.name);
  }
  return names;
}

function qualifiedNameOf(node: ts.Node): string | undefined {
  const info = declInfo(node);
  return info === undefined ? undefined : [...containerNames(node), info.name].join('.');
}

interface Declared {
  readonly node: ts.Node;
  readonly info: DeclInfo;
}

const declaredCache = new WeakMap<ts.SourceFile, Declared[]>();

function declarationsOf(sf: ts.SourceFile): Declared[] {
  let found = declaredCache.get(sf);
  if (found === undefined) {
    const collected: Declared[] = [];
    walk(sf, (node) => {
      const info = declInfo(node);
      if (info !== undefined) collected.push({ node, info });
    });
    found = collected;
    declaredCache.set(sf, found);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The six verifiers

function sourceOrProblem(env: VerifyEnv, rel: string, hash: string | null): { readonly source: Source } | Verdict {
  const outcome = env.source(rel, hash);
  return 'source' in outcome ? outcome : unverifiable(outcome.problem);
}

/** A definition is correct when a fresh parse has a declaration of that kind and name at the span, nested as the qualified name says. */
export function verifyDefinition(fact: DefinitionFact, env: VerifyEnv): Verdict {
  const loaded = sourceOrProblem(env, fact.path, fact.hash);
  if (!('source' in loaded)) return loaded;
  const { source } = loaded;
  const at = locate(source.starts, source.text, fact.span);
  if (at === undefined) return wrong('the span lies outside the file');
  const reasons: string[] = [];
  for (const declared of declarationsOf(source.sf)) {
    if (declared.info.name !== fact.name) continue;
    if (!startFits(source.text, declared.node.getStart(source.sf), at.start) || !endFits(source.text, declared.node.getEnd(), at.end)) continue;
    if (!declared.info.kinds.includes(fact.kind)) {
      reasons.push(`the declaration of ${fact.name} at the span is a ${declared.info.kinds.join(' or ')}, not a ${fact.kind}`);
      continue;
    }
    const qualified = qualifiedNameOf(declared.node);
    if (qualified !== fact.qualifiedName) {
      reasons.push(`the source nests it as ${qualified ?? '?'}, not ${fact.qualifiedName}`);
      continue;
    }
    return right(`${fact.kind} ${fact.name} is declared at the span`);
  }
  return wrong(reasons[0] ?? `no declaration named ${fact.name} starts and ends at the span`);
}

interface ModuleReference {
  readonly node: ts.Node;
  readonly specifier: string;
}

const moduleRefCache = new WeakMap<ts.SourceFile, ModuleReference[]>();

function stringValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/** Every import statement, re-export with a source, `require(...)`, `import(...)` and `import x = require(...)` of a file. */
function moduleReferencesOf(sf: ts.SourceFile): ModuleReference[] {
  let found = moduleRefCache.get(sf);
  if (found === undefined) {
    const collected: ModuleReference[] = [];
    walk(sf, (node) => {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(node)) specifier = stringValue(node.moduleSpecifier);
      else if (ts.isExportDeclaration(node)) specifier = stringValue(node.moduleSpecifier);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = stringValue(node.moduleReference.expression);
      else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
        const callee = node.expression;
        if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) specifier = stringValue(node.arguments[0]);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = stringValue(node.argument.literal);
      if (specifier !== undefined) collected.push({ node, specifier });
    });
    found = collected;
    moduleRefCache.set(sf, found);
  }
  return found;
}

/**
 * An import is correct when the text at the span holds the specifier as a string, a fresh parse has an import, re-export,
 * `require` or dynamic `import` of that specifier at the span, and, for a relative specifier, the oracle's emit-aware
 * resolution either finds no program file or finds one the index holds. (The store keeps the specifier and the span; the
 * file it names is worked out when a question is asked, so the resolution is checked against what the index holds.)
 */
export function verifyImport(fact: ImportFact, env: VerifyEnv): Verdict {
  const loaded = sourceOrProblem(env, fact.path, fact.hash);
  if (!('source' in loaded)) return loaded;
  const { source } = loaded;
  const at = locate(source.starts, source.text, fact.span);
  if (at === undefined) return wrong('the span lies outside the file');
  const spanText = source.text.slice(at.start, at.end);
  const quoted = [`'${fact.specifier}'`, `"${fact.specifier}"`, `\`${fact.specifier}\``];
  if (!quoted.some((form) => spanText.includes(form))) return wrong(`the text at the span does not hold "${fact.specifier}" as a string`);
  const match = moduleReferencesOf(source.sf).find(
    (reference) =>
      reference.specifier === fact.specifier &&
      startFits(source.text, reference.node.getStart(source.sf), at.start) &&
      endFits(source.text, reference.node.getEnd(), at.end),
  );
  if (match === undefined) return wrong(`no import, re-export, require or dynamic import of "${fact.specifier}" starts and ends at the span`);
  if (fact.specifier.startsWith('./') || fact.specifier.startsWith('../')) {
    const site = env.program(fact.path);
    const state = 'site' in site ? site.site.state : env.anyState();
    const target = state === undefined ? undefined : resolveRequireSpec(state, fact.path, fact.specifier);
    if (target !== undefined && !env.overlayPaths.has(target)) {
      return wrong(`the oracle resolves "${fact.specifier}" to ${target}, which the index does not hold`);
    }
    return right(target === undefined ? `the statement is at the span; "${fact.specifier}" names no program file` : `the statement is at the span; "${fact.specifier}" resolves to ${target}`);
  }
  return right(`the statement is at the span; "${fact.specifier}" is a package or built-in specifier`);
}

interface ExportedName {
  readonly name: string;
  readonly local: string | null;
  readonly from: string | null;
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
}

function propertyKeyText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

/** `module.exports`, `exports` or `module.exports.x` / `exports.x` / `exports['x']`: the exported name, or '' for the whole `module.exports`. */
function commonJsTarget(left: ts.Expression): string | undefined {
  const isModuleExports = (expression: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'module' && expression.name.text === 'exports';
  const isExportsObject = (expression: ts.Expression): boolean => (ts.isIdentifier(expression) && expression.text === 'exports') || isModuleExports(expression);
  if (isModuleExports(left)) return '';
  if (ts.isPropertyAccessExpression(left) && isExportsObject(left.expression)) return left.name.text;
  if (ts.isElementAccessExpression(left) && isExportsObject(left.expression)) return stringValue(left.argumentExpression);
  return undefined;
}

/** Every name a statement (or other node) exports, by the rules of ES modules and of CommonJS assignment. */
function exportedNamesOf(node: ts.Node): ExportedName[] {
  const out: ExportedName[] = [];
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const hasExport = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  const hasDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
  if (ts.isExportDeclaration(node)) {
    const from = stringValue(node.moduleSpecifier) ?? null;
    const clause = node.exportClause;
    if (clause === undefined) out.push({ name: '*', local: '*', from });
    else if (ts.isNamespaceExport(clause)) out.push({ name: clause.name.text, local: '*', from });
    else for (const element of clause.elements) out.push({ name: element.name.text, local: (element.propertyName ?? element.name).text, from });
  } else if (ts.isExportAssignment(node)) {
    const local = ts.isIdentifier(node.expression) ? node.expression.text : null;
    out.push({ name: node.isExportEquals === true ? 'export=' : 'default', local, from: null });
    if (local !== null) out.push({ name: local, local, from: null });
  } else if (hasExport && ts.isVariableStatement(node)) {
    const names: string[] = [];
    for (const declaration of node.declarationList.declarations) bindingNames(declaration.name, names);
    for (const name of names) out.push({ name, local: name, from: null });
  } else if (hasExport) {
    const named = (node as { name?: ts.Node }).name;
    const name = nameText(named);
    if (name !== undefined) out.push({ name, local: name, from: null });
    if (hasDefault) out.push({ name: 'default', local: name ?? null, from: null });
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // The assignment itself, not its statement: `exports.A = exports.B = void 0;` exports A and B, each at its own span.
    const assignment = node;
    const target = commonJsTarget(assignment.left);
    if (target === '') {
      const value = assignment.right;
      if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (ts.isShorthandPropertyAssignment(property)) out.push({ name: property.name.text, local: property.name.text, from: null });
          else if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) && property.name !== undefined) {
            const key = propertyKeyText(property.name);
            if (key !== undefined) out.push({ name: key, local: ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) ? property.initializer.text : null, from: null });
          }
        }
      } else {
        out.push({ name: 'default', local: null, from: null });
        out.push({ name: 'module.exports', local: null, from: null });
        if (ts.isIdentifier(value)) out.push({ name: value.text, local: value.text, from: null });
        else if ((ts.isFunctionExpression(value) || ts.isClassExpression(value)) && value.name !== undefined) out.push({ name: value.name.text, local: value.name.text, from: null });
      }
    } else if (target !== undefined) {
      out.push({ name: target, local: ts.isIdentifier(assignment.right) ? assignment.right.text : null, from: null });
    }
  }
  return out;
}

/** An export is correct when a fresh parse has, at the span, a statement that exports the name (and the local name and source, when stored). */
export function verifyExport(fact: ExportFact, env: VerifyEnv): Verdict {
  const loaded = sourceOrProblem(env, fact.path, fact.hash);
  if (!('source' in loaded)) return loaded;
  const { source } = loaded;
  const at = locate(source.starts, source.text, fact.span);
  if (at === undefined) return wrong('the span lies outside the file');
  let reason: string | undefined;
  let matched = false;
  walk(source.sf, (node) => {
    if (matched || !startFits(source.text, node.getStart(source.sf), at.start) || !endFits(source.text, node.getEnd(), at.end)) return;
    const names = exportedNamesOf(node);
    if (names.length === 0) return;
    const named = names.filter((exported) => exported.name === fact.name);
    if (named.length === 0) {
      reason ??= `the statement at the span exports ${names.map((exported) => exported.name).join(', ')}, not ${fact.name}`;
      return;
    }
    const detail = named.find(
      (exported) => (fact.local === null || exported.local === null || exported.local === fact.local) && (fact.fromPath === null || exported.from === null || exported.from === fact.fromPath),
    );
    if (detail === undefined) reason ??= `${fact.name} is exported at the span, but not as local ${fact.local ?? '(none)'} from ${fact.fromPath ?? '(none)'}`;
    else matched = true;
  });
  if (matched) return right(`the statement at the span exports ${fact.name}`);
  return wrong(reason ?? 'no export statement starts and ends at the span');
}

function identifierAt(sf: ts.SourceFile, start: number, end: number): ts.Identifier | ts.PrivateIdentifier | undefined {
  let result: ts.Identifier | ts.PrivateIdentifier | undefined;
  const visit = (node: ts.Node): void => {
    if (result !== undefined || node.getEnd() < start || node.getFullStart() > end) return;
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.getStart(sf) === start && node.getEnd() === end) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

function declarationName(declaration: ts.Declaration): string | undefined {
  return nameText(ts.getNameOfDeclaration(declaration));
}

/** Where a compiler declaration lives and what it is called, in the store's vocabulary. */
function describeDeclaration(state: State, declaration: ts.Declaration): { readonly path: string | undefined; readonly name: string | undefined; readonly qualified: string | undefined; readonly kinds: readonly string[] } {
  const info = declInfo(declaration);
  return {
    path: relInside(state.repoDir, declaration.getSourceFile().fileName),
    name: info?.name ?? declarationName(declaration),
    qualified: info === undefined ? declarationName(declaration) : [...containerNames(declaration), info.name].join('.'),
    kinds: info?.kinds ?? [],
  };
}

/** A precise reference edge is correct when a fresh program's alias-resolved symbol at the site is declared at the stored target. */
export function verifyReferenceEdge(fact: ReferenceEdgeFact, env: VerifyEnv): Verdict {
  const loaded = sourceOrProblem(env, fact.path, fact.hash);
  if (!('source' in loaded)) return loaded;
  const program = env.program(fact.path);
  if (!('site' in program)) return unverifiable(program.problem);
  const { state, unit } = program.site;
  const checker = unit.checker as ts.TypeChecker;
  const at = locate(unit.lineStarts, unit.sf.text, fact.span);
  if (at === undefined) return wrong('the site span lies outside the file');
  const id = identifierAt(unit.sf, at.start, at.end);
  if (id === undefined) return wrong('no identifier starts and ends at the site span');
  if (id.text !== fact.name) return wrong(`the identifier at the site is ${id.text}, not ${fact.name}`);
  const raw = ts.isPrivateIdentifier(id) ? checker.getSymbolAtLocation(id) : symbolAt(checker, id);
  if (raw === undefined) return wrong('the compiler has no symbol at the site');
  let symbol: ts.Symbol;
  try {
    symbol = canon(checker, raw);
  } catch {
    return wrong('the compiler cannot resolve the alias at the site');
  }
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return wrong('the compiler symbol at the site has no declaration');
  const described = declarations.map((declaration) => describeDeclaration(state, declaration));
  const there = described.filter((candidate) => candidate.path === fact.targetPath);
  if (there.length === 0) return wrong(`the compiler declares it in ${[...new Set(described.map((candidate) => candidate.path ?? '(outside the checkout)'))].join(', ')}, not ${fact.targetPath}`);
  const named = there.filter((candidate) => candidate.qualified === fact.targetQualifiedName);
  if (named.length === 0) return wrong(`the compiler declaration in ${fact.targetPath} is ${there.map((candidate) => candidate.qualified ?? '?').join(', ')}, not ${fact.targetQualifiedName}`);
  if (!named.some((candidate) => candidate.kinds.includes(fact.targetKind))) {
    return wrong(`the compiler declaration of ${fact.targetQualifiedName} is a ${named.flatMap((candidate) => candidate.kinds).join(' or ') || 'declaration of an unknown kind'}, not a ${fact.targetKind}`);
  }
  return right(`the compiler resolves ${fact.name} at the site to ${fact.targetQualifiedName} in ${fact.targetPath}`);
}

function findClassOrInterface(sf: ts.SourceFile, qualified: string): (ts.ClassDeclaration | ts.InterfaceDeclaration)[] {
  return declarationsOf(sf)
    .filter((declared) => (ts.isClassDeclaration(declared.node) || ts.isInterfaceDeclaration(declared.node)) && qualifiedNameOf(declared.node) === qualified)
    .map((declared) => declared.node as ts.ClassDeclaration | ts.InterfaceDeclaration);
}

/** The declarations a heritage clause type names: the oracle's resolution first, then the checker's type for forms like `Mixin(Base)`. */
function heritageDeclarations(state: State, checker: ts.TypeChecker, type: ts.ExpressionWithTypeArguments): ts.Declaration[] {
  const symbol = resolveHeritageSymbol(state, type) ?? checker.getTypeAtLocation(type).getSymbol();
  return symbol?.declarations ?? [];
}

function declaresAt(state: State, declaration: ts.Declaration, targetPath: string, targetQualified: string): boolean {
  const described = describeDeclaration(state, declaration);
  return described.path === targetPath && described.qualified === targetQualified;
}

/** A relation is correct when the compiler's heritage of the subtype (or the class of the overriding member) holds the stored base. */
export function verifyRelation(fact: RelationFact, env: VerifyEnv): Verdict {
  const loaded = sourceOrProblem(env, fact.path, fact.hash);
  if (!('source' in loaded)) return loaded;
  const program = env.program(fact.path);
  if (!('site' in program)) return unverifiable(program.problem);
  const { state, unit } = program.site;
  const checker = unit.checker as ts.TypeChecker;

  if (fact.relation === 'extends' || fact.relation === 'implements') {
    const subtypes = findClassOrInterface(unit.sf, fact.fromQualifiedName);
    if (subtypes.length === 0) return wrong(`no class or interface named ${fact.fromQualifiedName} in ${fact.path}`);
    const wanted = fact.relation === 'extends' ? ts.SyntaxKind.ExtendsKeyword : ts.SyntaxKind.ImplementsKeyword;
    for (const subtype of subtypes) {
      for (const clause of subtype.heritageClauses ?? []) {
        if (clause.token !== wanted) continue;
        for (const type of clause.types) {
          if (heritageDeclarations(state, checker, type).some((declaration) => declaresAt(state, declaration, fact.toPath, fact.toQualifiedName))) {
            return right(`${fact.fromQualifiedName} ${fact.relation} ${fact.toQualifiedName} in its heritage clause`);
          }
        }
      }
    }
    return wrong(`the heritage clauses of ${fact.fromQualifiedName} hold no ${fact.relation} of ${fact.toQualifiedName} in ${fact.toPath}`);
  }

  if (fact.relation === 'overrides') {
    const members = declarationsOf(unit.sf).filter(
      (declared) => qualifiedNameOf(declared.node) === fact.fromQualifiedName && declared.info.kinds.some((kind) => kind === 'method' || kind === 'property'),
    );
    if (members.length === 0) return wrong(`no member named ${fact.fromQualifiedName} in ${fact.path}`);
    for (const member of members) {
      const owner = member.node.parent;
      if (!ts.isClassDeclaration(owner)) continue;
      const seen = new Set<ts.Type>();
      const ownerType = checker.getTypeAtLocation(owner);
      if (!ownerType.isClassOrInterface()) continue;
      const queue: ts.Type[] = [...checker.getBaseTypes(ownerType)];
      while (queue.length > 0) {
        const base = queue.shift() as ts.Type;
        const generic = (base as ts.TypeReference).target ?? base;
        if (seen.has(generic)) continue;
        seen.add(generic);
        const property = checker.getPropertyOfType(base, member.info.name);
        if (property?.declarations?.some((declaration) => declaresAt(state, declaration, fact.toPath, fact.toQualifiedName)) === true) {
          return right(`${fact.fromQualifiedName} overrides ${fact.toQualifiedName} of a base class`);
        }
        if (generic.isClassOrInterface()) queue.push(...checker.getBaseTypes(generic));
      }
    }
    return wrong(`no base class of the owner of ${fact.fromQualifiedName} declares ${fact.toQualifiedName} in ${fact.toPath}`);
  }

  return wrong(`unknown relation kind ${fact.relation}`);
}

/** A citation is correct when the text at the span is an ADR mention of the stored number (and detail) inside a comment. */
export function verifyCitation(fact: CitationFact, env: VerifyEnv): Verdict {
  const loaded = sourceOrProblem(env, fact.path, fact.hash);
  if (!('source' in loaded)) return loaded;
  const { source } = loaded;
  const at = locate(source.starts, source.text, fact.span);
  if (at === undefined) return wrong('the span lies outside the file');
  const spanText = source.text.slice(at.start, at.end);
  const mention = citationsIn(spanText, 0).find((candidate) => candidate.pos === 0);
  if (mention === undefined) return wrong(`the text at the span (${JSON.stringify(spanText.slice(0, 40))}) is not an ADR mention`);
  if (mention.number !== fact.number) return wrong(`the text at the span cites ADR ${String(mention.number)}, not ADR ${String(fact.number)}`);
  // The oracle's pattern reads numeric sections only (`§5`); the store also keeps alphanumeric ones (`§5d`, `§OpenCode`).
  // A longer stored detail is true when it is the text right after the number in the span.
  const detailOk =
    (mention.detail ?? null) === fact.detail ||
    (fact.detail !== null && fact.detail.startsWith('§') && spanText.endsWith(fact.detail) && (mention.detail === undefined || fact.detail.startsWith(mention.detail)));
  if (!detailOk) return wrong(`the text at the span has the detail ${mention.detail ?? 'none'}, not ${fact.detail ?? 'none'}`);
  const inComment = commentRanges(source.sf).some((range) => range.pos <= at.start && at.end <= range.end);
  return inComment ? right(`the span is an ADR ${String(fact.number)} mention inside a comment`) : wrong('the mention is not inside a comment');
}

export function verifyFact(fact: Fact, env: VerifyEnv): Verdict {
  switch (fact.stratum) {
    case 'definition':
      return verifyDefinition(fact, env);
    case 'import':
      return verifyImport(fact, env);
    case 'export':
      return verifyExport(fact, env);
    case 'reference_edge':
      return verifyReferenceEdge(fact, env);
    case 'relation':
      return verifyRelation(fact, env);
    case 'citation':
      return verifyCitation(fact, env);
  }
}

// ---------------------------------------------------------------------------------------------
// The report

export interface Counts {
  readonly population: number;
  readonly sampled: number;
  readonly correct: number;
  readonly wrong: number;
  readonly unverifiable: number;
}

export interface StratumCounts extends Counts {
  readonly stratum: Stratum;
}

export interface RelationKindCounts extends Counts {
  readonly relation: string;
}

export interface SampleRow {
  /** 1-based; the human check takes the rows whose index is a multiple of five. */
  readonly index: number;
  readonly fact: Fact;
  readonly verdict: Verdict;
}

export interface ReportHeader {
  readonly corpus: string;
  readonly corpusSha: string;
  readonly seed: number;
  readonly requested: number;
  readonly atlasCommit: string;
  readonly compilers: string;
  readonly schemaVersion: number;
}

export interface SampleReport {
  readonly header: ReportHeader;
  readonly strata: readonly StratumCounts[];
  readonly relationKinds: readonly RelationKindCounts[];
  readonly rows: readonly SampleRow[];
  readonly sampled: number;
  readonly correct: number;
  readonly wrong: number;
  readonly unverifiable: number;
  readonly precision: number;
  readonly lower: number;
  readonly upper: number;
  readonly passes: boolean;
}

/** The PRD gate: at least 98 percent of the sampled facts are correct, by integer arithmetic (an unverifiable fact is not correct). */
export function passesGate(correct: number, total: number): boolean {
  return total > 0 && correct * GATE_DENOMINATOR >= total * GATE_NUMERATOR;
}

function tally(rows: readonly SampleRow[], population: number): Counts {
  return {
    population,
    sampled: rows.length,
    correct: rows.filter((row) => row.verdict.verdict === 'correct').length,
    wrong: rows.filter((row) => row.verdict.verdict === 'wrong').length,
    unverifiable: rows.filter((row) => row.verdict.verdict === 'unverifiable').length,
  };
}

export function buildReport(header: ReportHeader, strata: Strata, rows: readonly SampleRow[]): SampleReport {
  const strataCounts = STRATA.map((stratum): StratumCounts => ({ stratum, ...tally(rows.filter((row) => row.fact.stratum === stratum), strata[stratum].length) }));
  const relationKinds = RELATION_KINDS_LISTED.map((relation): RelationKindCounts => {
    const isKind = (fact: Fact): boolean => fact.stratum === 'relation' && fact.relation === relation;
    return { relation, ...tally(rows.filter((row) => isKind(row.fact)), strata.relation.filter(isKind).length) };
  });
  const counts = tally(rows, 0);
  const interval = counts.sampled === 0 ? { point: 0, lower: 0, upper: 0 } : wilsonInterval(counts.correct, counts.sampled, WILSON_Z);
  return {
    header,
    strata: strataCounts,
    relationKinds,
    rows,
    sampled: counts.sampled,
    correct: counts.correct,
    wrong: counts.wrong,
    unverifiable: counts.unverifiable,
    precision: counts.sampled === 0 ? 0 : counts.correct / counts.sampled,
    lower: interval.lower,
    upper: interval.upper,
    passes: passesGate(counts.correct, counts.sampled),
  };
}

// ---------------------------------------------------------------------------------------------
// The review table

function cell(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 3)}...` : flat;
}

function where(fact: Fact): string {
  return fact.span === null ? fact.path : `${fact.path}:${String(fact.span.startLine + 1)}:${String(fact.span.startColumn + 1)}`;
}

function describe(fact: Fact): { readonly what: string; readonly claim: string } {
  switch (fact.stratum) {
    case 'definition':
      return { what: `${fact.kind} ${fact.qualifiedName}`, claim: `${fact.path} defines ${fact.kind} ${fact.qualifiedName} here` };
    case 'import':
      return { what: `import "${fact.specifier}"${fact.style === null ? '' : ` (${fact.style})`}`, claim: `${fact.path} imports "${fact.specifier}" here` };
    case 'export':
      return {
        what: `export ${fact.name}${fact.fromPath === null ? '' : ` from ${fact.fromPath}`}`,
        claim: `${fact.path} exports ${fact.name}${fact.local !== null && fact.local !== fact.name ? ` (local ${fact.local})` : ''} here`,
      };
    case 'reference_edge':
      return {
        what: `reference ${fact.name}`,
        claim: `the reference to ${fact.name} here resolves to ${fact.targetKind} ${fact.targetQualifiedName} in ${fact.targetPath}`,
      };
    case 'relation':
      return {
        what: `${fact.fromQualifiedName} ${fact.relation} ${fact.toQualifiedName}`,
        claim: `${fact.fromKind} ${fact.fromQualifiedName} ${fact.relation} ${fact.toKind} ${fact.toQualifiedName} (${fact.toPath})`,
      };
    case 'citation':
      return {
        what: `ADR ${String(fact.number)}${fact.detail === null ? '' : ` ${fact.detail}`}`,
        claim: `a comment here cites ADR ${String(fact.number)}${fact.detail === null ? '' : ` ${fact.detail}`}`,
      };
  }
}

function countsRow(label: string, counts: Counts): string {
  return `| ${label} | ${String(counts.population)} | ${String(counts.sampled)} | ${String(counts.correct)} | ${String(counts.wrong)} | ${String(counts.unverifiable)} |`;
}

/** The generated part of the review table: deterministic Markdown that ends before the notes marker. */
export function renderTable(report: SampleReport): string {
  const { header } = report;
  const lines: string[] = [
    '# Edge precision sample',
    '',
    'Generated by `node scripts/edge-sample.ts` (plan 03-31, OQ9, PRD section 11 criterion 1). Everything above the notes marker at the end is regenerated by the script; everything below it is written by hand and kept.',
    '',
    `- Corpus: ${header.corpus} at ${header.corpusSha}`,
    `- Seed: ${String(header.seed)}`,
    `- Sample size: ${String(report.sampled)} (requested ${String(header.requested)})`,
    `- Atlas commit: ${header.atlasCommit} (the last commit that changed src, modules, schemas or scripts/edge-sample.ts)`,
    `- Store schema version: ${String(header.schemaVersion)}`,
    `- Compilers: ${header.compilers}`,
    '',
    '## Result',
    '',
    `Overall precision ${report.precision.toFixed(3)} (${String(report.correct)} of ${String(report.sampled)} correct, ${String(report.wrong)} wrong, ${String(report.unverifiable)} unverifiable); Wilson 95% interval ${report.lower.toFixed(3)} to ${report.upper.toFixed(3)}; gate 0.98: ${report.passes ? 'met' : 'NOT met'}.`,
    '',
    'A fact the verifier could not check counts as wrong. The sample is drawn with the seed above and is never redrawn with another seed.',
    '',
    '## Strata',
    '',
    '| Stratum | Population | Sampled | Correct | Wrong | Unverifiable |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.strata.map((row) => countsRow(row.stratum, row)),
    '',
    'Relation kinds (inside the relation stratum; a kind with no facts is listed with zero and does not count toward the sample size):',
    '',
    '| Relation | Population | Sampled | Correct | Wrong | Unverifiable |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.relationKinds.map((row) => countsRow(row.relation, row)),
    '',
    '## Sampled rows',
    '',
    'Human check: take the rows whose # is a multiple of five (twenty rows when the sample has 100), open the file at the location in the checkout, and confirm that the stated fact is true. Line and column are 1-based.',
    '',
    '| # | Stratum | Fact | Location | Atlas claims | Verdict | Reason | Human |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => {
      const described = describe(row.fact);
      return `| ${String(row.index)} | ${row.fact.stratum} | ${cell(described.what)} | ${cell(where(row.fact))} | ${cell(described.claim)} | ${row.verdict.verdict} | ${cell(row.verdict.reason)} | |`;
    }),
    '',
    '## Wrong or unverifiable',
    '',
  ];
  const bad = report.rows.filter((row) => row.verdict.verdict !== 'correct');
  if (bad.length === 0) lines.push('None in this run.');
  else {
    for (const row of bad) {
      const described = describe(row.fact);
      lines.push(`- Row ${String(row.index)} (${row.fact.stratum}, ${row.verdict.verdict}) at ${where(row.fact)}: ${described.claim}. ${row.verdict.reason}.`);
    }
  }
  lines.push('', '');
  return lines.join('\n');
}

/** The table followed by the hand-written part: the one already in `existing` from the marker on, or the default. */
export function composeFile(table: string, existing: string | undefined): string {
  if (existing !== undefined) {
    const at = existing.indexOf(NOTES_MARKER);
    if (at >= 0) return table + existing.slice(at);
  }
  return table + DEFAULT_NOTES;
}

// ---------------------------------------------------------------------------------------------
// The run

export interface RunOptions {
  /** The checkout the index was built from. */
  readonly dir: string;
  /** The overlay of the store to sample; default the real path of `dir`. */
  readonly worktree?: string;
  readonly seed: number;
  readonly n: number;
  /** The store file or a store root; default `GSD_ATLAS_STORE_DIR`. */
  readonly storeFile?: string;
  readonly tsconfig?: string;
  /** The review table is written here, keeping the hand-written part of an existing file. */
  readonly out?: string;
  /** The checkout was prepared by scripts/eval/prepare-corpus.ts: read its record and check it. */
  readonly prepared?: boolean;
  /** Replaces the store (tests). */
  readonly population?: LoadedPopulation;
  /** Replaces the verifiers (tests). */
  readonly verify?: (fact: Fact, env: VerifyEnv) => Verdict;
}

export interface RunResult {
  readonly exitCode: number;
  readonly report: SampleReport;
  readonly table: string;
}

interface PreparedRecord {
  readonly corpusId: string;
  readonly sha: string;
  readonly typescriptVersion: string | null;
  readonly npmCi: boolean;
}

function readPreparedRecord(dir: string): PreparedRecord {
  const file = path.join(dir, '.eval-prepared.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new SampleError('not_prepared', `--prepared was given but ${file} is missing or not JSON; prepare the checkout with scripts/eval/prepare-corpus.ts`);
  }
  const record = parsed as Partial<PreparedRecord> | null;
  if (typeof record !== 'object' || record === null || typeof record.corpusId !== 'string' || typeof record.sha !== 'string' || typeof record.npmCi !== 'boolean') {
    throw new SampleError('not_prepared', `${file} is not a preparation record`);
  }
  return { corpusId: record.corpusId, sha: record.sha, typescriptVersion: record.typescriptVersion ?? null, npmCi: record.npmCi };
}

/**
 * The commit of the atlas code that made the index and checked it: the last commit that changed the package's sources,
 * modules, schemas or this script. Committing the review table itself does not change it, so regenerating the table
 * after the commit that holds it gives the same text.
 */
function atlasCommit(): string {
  const root = path.resolve(import.meta.dirname, '..');
  const scope = ['src', 'modules', 'schemas', 'scripts/edge-sample.ts'];
  const last = gitOutput(root, ['log', '-1', '--format=%H', '--', ...scope])?.trim();
  if (last === undefined || last === '') return 'unknown';
  const dirty = (gitOutput(root, ['status', '--porcelain', '--untracked-files=no', '--', ...scope]) ?? '').trim() !== '';
  return dirty ? `${last} (with uncommitted changes)` : last;
}

export async function runEdgeSample(options: RunOptions): Promise<RunResult> {
  if (!Number.isInteger(options.n) || options.n < 1) throw new SampleError('usage', '--n must be a whole number of at least 1');
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) throw new SampleError('usage', '--seed must be a whole number from 0 to 4294967295');
  let dir: string;
  try {
    dir = fs.realpathSync.native(options.dir);
  } catch {
    throw new SampleError('usage', `the checkout directory does not exist: ${options.dir}`);
  }
  const record = options.prepared === true ? readPreparedRecord(dir) : undefined;
  const sha = gitOutput(dir, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown';
  if (record !== undefined && record.sha !== sha) {
    throw new SampleError('not_prepared', `the preparation record says ${record.sha} but the checkout is at ${sha}`);
  }
  let population = options.population;
  if (population === undefined) {
    const root = options.storeFile ?? process.env['GSD_ATLAS_STORE_DIR'];
    if (root === undefined || root === '') throw new SampleError('usage', 'name the index: --store <facts.db or store root>, or set GSD_ATLAS_STORE_DIR');
    population = loadPopulation(findStoreFile(root), { worktree: options.worktree ?? dir });
  }
  const sample = drawSample(population.strata, options.n, options.seed);
  const env = createVerifyEnv({ repoDir: dir, overlayPaths: population.overlayPaths, ...(options.tsconfig === undefined ? {} : { tsconfig: options.tsconfig }) });
  const verify = options.verify ?? verifyFact;
  const rows: SampleRow[] = sample.map((fact, index) => {
    let verdict: Verdict;
    try {
      verdict = verify(fact, env);
    } catch (error) {
      verdict = unverifiable(`the verifier failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { index: index + 1, fact, verdict };
  });
  const header: ReportHeader = {
    corpus: record?.corpusId ?? path.basename(dir),
    corpusSha: sha,
    seed: options.seed,
    requested: options.n,
    atlasCommit: atlasCommit(),
    compilers: `checkout ${record === undefined ? 'not prepared (--prepared not given)' : record.typescriptVersion === null ? 'prepared without an install' : `typescript ${record.typescriptVersion} (prepared, npm ci --ignore-scripts)`}; verifiers typescript ${ts.version} (the package's own, through scripts/eval/oracle.ts)`,
    schemaVersion: population.schemaVersion,
  };
  const report = buildReport(header, population.strata, rows);
  const table = renderTable(report);
  if (options.out !== undefined) {
    const existing = fs.existsSync(options.out) ? fs.readFileSync(options.out, 'utf8') : undefined;
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, composeFile(table, existing));
  }
  return { exitCode: report.sampled > 0 && report.passes ? 0 : report.sampled === 0 ? 2 : 1, report, table };
}

const USAGE =
  'usage: node scripts/edge-sample.ts --dir <prepared checkout> --seed <seed> [--n 100] [--out <review table>] [--store <facts.db or store root>] [--tsconfig tsconfig.json] [--prepared]\n';

/** The command-line body with the output sink injected. Returns the exit code: 0 at or above 0.98, 1 below, 2 for usage or an unreadable store. */
export async function runCli(argv: string[], write: (text: string) => void, overrides: Partial<RunOptions> = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        seed: { type: 'string' },
        n: { type: 'string' },
        out: { type: 'string' },
        store: { type: 'string' },
        tsconfig: { type: 'string' },
        prepared: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    write(`edge-sample: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.dir === undefined) {
    write(`edge-sample: --dir is required\n${USAGE}`);
    return 2;
  }
  if (values.seed === undefined) {
    write(`edge-sample: --seed is required (the approved eval.bootstrapSeed is 20261017)\n${USAGE}`);
    return 2;
  }
  const wholeNumber = (value: string): boolean => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
  if (!wholeNumber(values.seed)) {
    write(`edge-sample: --seed must be a whole number, got ${values.seed}\n${USAGE}`);
    return 2;
  }
  const n = values.n ?? '100';
  if (!wholeNumber(n) || Number(n) < 1) {
    write(`edge-sample: --n must be a whole number of at least 1, got ${n}\n${USAGE}`);
    return 2;
  }
  try {
    const result = await runEdgeSample({
      dir: values.dir,
      seed: Number(values.seed),
      n: Number(n),
      ...(values.out === undefined ? {} : { out: values.out }),
      ...(values.store === undefined ? {} : { storeFile: values.store }),
      ...(values.tsconfig === undefined ? {} : { tsconfig: values.tsconfig }),
      ...(values.prepared === true ? { prepared: true } : {}),
      ...overrides,
    });
    if (values.out === undefined && overrides.out === undefined) write(result.table);
    const { report } = result;
    write(
      `edge-sample: Overall precision ${report.precision.toFixed(3)} (${String(report.correct)} of ${String(report.sampled)}), Wilson 95% ${report.lower.toFixed(3)} to ${report.upper.toFixed(3)}, ${report.passes ? 'gate met' : 'gate NOT met'}\n`,
    );
    return result.exitCode;
  } catch (error) {
    write(`edge-sample: ${error instanceof Error ? error.message : String(error)}\n${error instanceof SampleError && error.code === 'usage' ? USAGE : ''}`);
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`edge-sample: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
