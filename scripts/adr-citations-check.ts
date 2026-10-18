/**
 * node scripts/adr-citations-check.ts --dir <prepared checkout> [--sample 20] [--seed 7] [--numbers 1,2,3] [--tsconfig tsconfig.json]
 *
 * Compares the ADR citations the Fact Store holds with the independent oracle's (plan 03-24, TSM-04, D-19).
 *
 * The oracle (scripts/eval/oracle.ts) reads the checkout with the TypeScript compiler's comment ranges and its own
 * pattern and consults no store. This script builds the checkout into an isolated store through the composed Host
 * (the same composition the bins use), reads the stored `citations` rows (the store side never touches the oracle),
 * picks cited ADR numbers from the oracle's own census, so the sample does not come from the system under test, and
 * for each number compares the set of (file, line) pairs of the two sides with a slack of two lines.
 *
 * It prints the counts per number and then the totals `agree`, `store_only` and `oracle_only`, lists up to ten
 * differences of each kind, and exits 1 when `store_only + oracle_only` is more than 2 percent of the oracle's total
 * (exit 2 for a usage error). The oracle file is frozen (plan 03-16): only its exported helpers are used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { composeHost } from '../src/bin/compose.ts';
import { STORE_FILE_NAME } from '../src/fact-store/schema.ts';
import { PROTOCOL_VERSION } from '../src/facts/index.ts';
import { openDatabase } from '../src/sqlite/index.ts';
import { commentCitations, computeAnswerKey, stateOf, trackedCodeUnits } from './eval/oracle.ts';
import type { OracleContext } from './eval/oracle.ts';

/** The lines either side may be apart and still be the same mention (a comment that the two sides cut differently). */
export const LINE_SLACK = 2;

/** The share of the oracle's total that `store_only + oracle_only` may reach: 2 percent. */
export const MAX_DIFFERENCE_RATIO = 0.02;

/** How many differences of each kind are listed. */
const LISTED_DIFFERENCES = 10;

const STORE_READ_BUSY_MS = 5000;

/** One citation as a line in a file (1-based line). */
export interface LineHit {
  readonly file: string;
  readonly line: number;
}

/** One citation the store holds. */
export interface StoreHit extends LineHit {
  readonly number: number;
}

export interface Comparison {
  readonly agree: number;
  readonly storeOnly: readonly LineHit[];
  readonly oracleOnly: readonly LineHit[];
}

export interface NumberRow {
  readonly number: number;
  /** Distinct (file, line) pairs the oracle found. */
  readonly oracle: number;
  /** Distinct (file, line) pairs the store holds. */
  readonly store: number;
  readonly agree: number;
  readonly storeOnly: number;
  readonly oracleOnly: number;
}

export interface CheckOptions {
  /** The prepared checkout: a git work tree with a tsconfig. */
  readonly dir: string;
  /** How many cited numbers to compare. Default 20. */
  readonly sample?: number;
  /** Seed of the sample. Default 7. */
  readonly seed?: number;
  /** Compare exactly these numbers instead of a sample. */
  readonly numbers?: readonly number[];
  /** The tsconfig the oracle builds its program from, relative to `dir`. Default `tsconfig.json`. */
  readonly tsconfig?: string;
  readonly slack?: number;
  /** Where the lines go. Default stdout. */
  readonly out?: (line: string) => void;
  /** Replaces the build and the read of the store. Tests inject one to force a difference. */
  readonly readStoreCitations?: (dir: string, workDir: string) => Promise<readonly StoreHit[]>;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly rows: readonly NumberRow[];
  readonly agree: number;
  readonly storeOnly: number;
  readonly oracleOnly: number;
  /** Distinct numbers the oracle found cited in comments across the checkout. */
  readonly census: number;
  /** The oracle's total over the compared numbers. */
  readonly oracleTotal: number;
  /** Mentions inside string literals the oracle excluded, over the compared numbers. */
  readonly excludedNonComment: number;
}

// ---------------------------------------------------------------------------------------------
// Comparison

const keyOf = (hit: LineHit): string => `${hit.file}\u0000${String(hit.line)}`;

function distinct(hits: readonly LineHit[]): LineHit[] {
  const seen = new Map<string, LineHit>();
  for (const hit of hits) {
    if (!seen.has(keyOf(hit))) seen.set(keyOf(hit), { file: hit.file, line: hit.line });
  }
  return [...seen.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/**
 * Pair the oracle's lines with the store's, file by file: a store line within `slack` lines of an oracle line is its
 * counterpart, and each line pairs once. A line is counted once however many mentions it holds. What is left on the
 * oracle side is `oracleOnly`, what is left on the store side is `storeOnly`.
 */
export function compareLines(oracle: readonly LineHit[], store: readonly LineHit[], slack: number): Comparison {
  const byFile = (hits: readonly LineHit[]): Map<string, number[]> => {
    const grouped = new Map<string, number[]>();
    for (const hit of distinct(hits)) {
      const lines = grouped.get(hit.file);
      if (lines === undefined) grouped.set(hit.file, [hit.line]);
      else lines.push(hit.line);
    }
    return grouped;
  };
  const oracleLines = byFile(oracle);
  const storeLines = byFile(store);
  let agree = 0;
  const oracleOnly: LineHit[] = [];
  const storeOnly: LineHit[] = [];
  for (const file of [...new Set([...oracleLines.keys(), ...storeLines.keys()])].sort()) {
    const spare = [...(storeLines.get(file) ?? [])];
    for (const line of oracleLines.get(file) ?? []) {
      const at = spare.findIndex((candidate) => Math.abs(candidate - line) <= slack);
      if (at >= 0) {
        spare.splice(at, 1);
        agree += 1;
      } else {
        oracleOnly.push({ file, line });
      }
    }
    for (const line of spare) storeOnly.push({ file, line });
  }
  return { agree, storeOnly, oracleOnly };
}

/** A small seeded generator (mulberry32): the same seed always gives the same sequence on every platform. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` numbers of the census chosen by a seeded shuffle of the sorted census, returned sorted. */
export function sampleNumbers(census: readonly number[], count: number, seed: number): number[] {
  const pool = [...new Set(census)].sort((a, b) => a - b);
  const random = seeded(seed);
  for (let at = pool.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    const held = pool[at] as number;
    pool[at] = pool[other] as number;
    pool[other] = held;
  }
  return pool.slice(0, Math.max(0, count)).sort((a, b) => a - b);
}

/** True when `storeOnly + oracleOnly` is at most 2 percent of the oracle's total. */
export function withinThreshold(storeOnly: number, oracleOnly: number, oracleTotal: number): boolean {
  return storeOnly + oracleOnly <= oracleTotal * MAX_DIFFERENCE_RATIO;
}

// ---------------------------------------------------------------------------------------------
// The store side

/** The one store directory the override created, and its database file. */
function storeFileUnder(storeRoot: string): string {
  const stores = fs.readdirSync(storeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (stores.length !== 1) throw new Error(`expected one store under ${storeRoot}, found ${String(stores.length)}`);
  return path.join(storeRoot, (stores[0] as fs.Dirent).name, STORE_FILE_NAME);
}

/**
 * Build `dir` once into an isolated store through the composed Host and read every stored citation of the overlay
 * (path, number, 1-based line of the mention), through a read-only connection. Nothing here consults the oracle.
 */
export async function buildAndReadCitations(dir: string, workDir: string): Promise<StoreHit[]> {
  const storeRoot = path.join(workDir, 'stores');
  const userDir = path.join(workDir, 'user');
  const home = path.join(workDir, 'home');
  for (const made of [storeRoot, userDir, home]) fs.mkdirSync(made, { recursive: true });
  const env = { ...process.env, GSD_ATLAS_USER_DIR: userDir, GSD_ATLAS_STORE_DIR: storeRoot };
  const composed = composeHost({ cwd: dir, env, stderr: process.stderr, home });
  try {
    const envelope = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: dir } });
    if (!envelope.ok || envelope.data === null) {
      throw new Error(`build failed: ${envelope.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
    }
  } finally {
    await composed.dispose();
  }
  const db = await openDatabase(storeFileUnder(storeRoot), { readOnly: true, timeoutMs: STORE_READ_BUSY_MS });
  try {
    return db
      .prepare(
        `SELECT o.path AS path, c.number AS number, c.start_line AS start_line
         FROM overlay_files o JOIN citations c ON c.file_id = o.file_id
         ORDER BY o.path, c.start_line, c.ord`,
      )
      .all()
      .map((row) => ({ file: String(row['path']), number: Number(row['number']), line: Number(row['start_line']) + 1 }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The run

/** The numbers the oracle finds cited in the comments of the checkout's tracked code files. */
function oracleCensus(ctx: OracleContext): number[] {
  const state = stateOf(ctx);
  const numbers = new Set<number>();
  for (const unit of trackedCodeUnits(state)) {
    for (const citation of commentCitations(unit)) numbers.add(citation.number);
  }
  return [...numbers].sort((a, b) => a - b);
}

function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const percent = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;

/** Run the comparison. The work directory (the isolated store) is removed in `finally`. */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dir = path.resolve(options.dir);
  const slack = options.slack ?? LINE_SLACK;
  const ctx: OracleContext = { repoDir: dir, tsconfig: options.tsconfig ?? 'tsconfig.json' };

  const census = oracleCensus(ctx);
  const numbers =
    options.numbers === undefined
      ? sampleNumbers(census, options.sample ?? 20, options.seed ?? 7)
      : [...new Set(options.numbers)].sort((a, b) => a - b);
  out(
    `adr-citations-check: the oracle finds ${String(census.length)} distinct ADR numbers cited in comments; comparing ${String(numbers.length)}` +
      `${options.numbers === undefined ? ` (sample ${String(options.sample ?? 20)}, seed ${String(options.seed ?? 7)})` : ' (given)'}`,
  );

  const workDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gsd-atlas-adr-check-'));
  try {
    const stored = await (options.readStoreCitations ?? buildAndReadCitations)(dir, workDir);
    out(`adr-citations-check: the store holds ${String(stored.length)} citations in total`);

    const rows: NumberRow[] = [];
    const storeOnlyEntries: string[] = [];
    const oracleOnlyEntries: string[] = [];
    let oracleTotal = 0;
    let excluded = 0;
    out('number  oracle  store  agree  store_only  oracle_only');
    for (const number of numbers) {
      const key = await computeAnswerKey({ kind: 'adr-citers', number, granularity: 'file', equality: 'exact-set' }, ctx);
      const oracleHits = key.items.flatMap((item) => (item.file === undefined || item.line === undefined ? [] : [{ file: item.file, line: item.line }]));
      const storeHits = stored.filter((hit) => hit.number === number);
      const compared = compareLines(oracleHits, storeHits, slack);
      const row: NumberRow = {
        number,
        oracle: distinct(oracleHits).length,
        store: distinct(storeHits).length,
        agree: compared.agree,
        storeOnly: compared.storeOnly.length,
        oracleOnly: compared.oracleOnly.length,
      };
      rows.push(row);
      oracleTotal += row.oracle;
      const skipped = key.notes['excludedNonComment'];
      excluded += typeof skipped === 'number' ? skipped : 0;
      out(
        `${String(number).padEnd(8)}${String(row.oracle).padEnd(8)}${String(row.store).padEnd(7)}${String(row.agree).padEnd(7)}${String(row.storeOnly).padEnd(12)}${String(row.oracleOnly)}`,
      );
      for (const hit of compared.storeOnly) storeOnlyEntries.push(`${hit.file}:${String(hit.line)} (ADR-${String(number)})`);
      for (const hit of compared.oracleOnly) oracleOnlyEntries.push(`${hit.file}:${String(hit.line)} (ADR-${String(number)})`);
    }

    const agree = rows.reduce((sum, row) => sum + row.agree, 0);
    const storeOnly = rows.reduce((sum, row) => sum + row.storeOnly, 0);
    const oracleOnly = rows.reduce((sum, row) => sum + row.oracleOnly, 0);
    out(`agree ${String(agree)}`);
    out(`store_only ${String(storeOnly)}`);
    out(`oracle_only ${String(oracleOnly)}`);
    for (const entry of storeOnlyEntries.slice(0, LISTED_DIFFERENCES)) out(`store_only: ${entry}`);
    for (const entry of oracleOnlyEntries.slice(0, LISTED_DIFFERENCES)) out(`oracle_only: ${entry}`);
    out(
      `adr-citations-check: the oracle's total over these numbers is ${String(oracleTotal)}; differences ${String(storeOnly + oracleOnly)} ` +
        `(${percent(oracleTotal === 0 ? 0 : (storeOnly + oracleOnly) / oracleTotal)}, limit ${percent(MAX_DIFFERENCE_RATIO)}); ` +
        `the oracle left out ${String(excluded)} mentions inside string literals and templates, and the store holds none of them unless listed under store_only`,
    );
    return {
      ok: withinThreshold(storeOnly, oracleOnly, oracleTotal),
      rows,
      agree,
      storeOnly,
      oracleOnly,
      census: census.length,
      oracleTotal,
      excludedNonComment: excluded,
    };
  } finally {
    removeTree(workDir);
  }
}

const USAGE = 'usage: node scripts/adr-citations-check.ts --dir <prepared checkout> [--sample 20] [--seed 7] [--numbers 1,2,3] [--tsconfig tsconfig.json]\n';

function wholeNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RangeError(`${name} must be a whole number, got ${value}`);
  return Number(value);
}

/** The command-line body, with the output sink injected. Returns the exit code. */
export async function runCli(argv: string[], write: (text: string) => void, overrides: Partial<CheckOptions> = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        sample: { type: 'string' },
        seed: { type: 'string' },
        numbers: { type: 'string' },
        tsconfig: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    write(`adr-citations-check: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.dir === undefined) {
    write(`adr-citations-check: --dir is required\n${USAGE}`);
    return 2;
  }
  let numbers: number[] | undefined;
  let sample: number;
  let seed: number;
  try {
    sample = wholeNumber(values.sample, 20, '--sample');
    seed = wholeNumber(values.seed, 7, '--seed');
    numbers = values.numbers === undefined ? undefined : values.numbers.split(',').map((part) => wholeNumber(part.trim(), Number.NaN, '--numbers'));
  } catch (error) {
    write(`adr-citations-check: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const report = await runCheck({
    dir: values.dir,
    sample,
    seed,
    ...(numbers === undefined ? {} : { numbers }),
    ...(values.tsconfig === undefined ? {} : { tsconfig: values.tsconfig }),
    out: (line) => {
      write(`${line}\n`);
    },
    ...overrides,
  });
  write(`adr-citations-check: ${report.ok ? 'OK' : 'FAILED'}\n`);
  return report.ok ? 0 : 1;
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
      process.stderr.write(`adr-citations-check: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
