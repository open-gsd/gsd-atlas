/**
 * node scripts/relations-check.ts --dir <prepared checkout> [--tsconfig tsconfig.json] [--max-wait-ms 120000]
 *
 * Compares the `extends` and `implements` relations the Fact Store holds with the independent oracle's heritage key
 * (plan 03-25, TSM-01, ROADMAP criterion 1).
 *
 * The oracle (scripts/eval/oracle.ts) reads the checkout with its own TypeScript program and consults no store. The census
 * that chooses what is compared comes from the oracle too: every class and interface of the repository that at least one
 * class or interface names in a heritage clause, so the sample does not come from the system under test. This script builds
 * the checkout into an isolated store through the composed Host (the same composition the bins use), asks `code_refs` for each
 * census target until the compiler's answer has arrived (the store fills `resolved_relations` lazily), reads the stored rows
 * through a read-only connection, and compares, per target, the set of (subtype file, subtype name) pairs of the two sides.
 *
 * A base that is a library class (`Error`) has no symbol in the repository, so the store holds no relation for it by design.
 * The oracle's subclasses of such a base are printed under `library bases (not stored)` and are not counted as differences.
 *
 * It prints one line per target, then the totals `agree`, `store_only` and `oracle_only`, lists up to ten differences of each
 * kind, and exits 1 when either difference count is above zero (exit 2 for a usage error). The oracle file is frozen (plan
 * 03-16): only its exported helpers are used. Dev-time tooling: nothing in the shipped package imports it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import { composeHost } from '../src/bin/compose.ts';
import { STORE_FILE_NAME } from '../src/fact-store/schema.ts';
import { PROTOCOL_VERSION } from '../src/facts/index.ts';
import { openDatabase } from '../src/sqlite/index.ts';
import { computeAnswerKey, heritageTypes, isLibraryFile, relInside, resolveHeritageSymbol, stateOf, walk } from './eval/oracle.ts';
import type { OracleContext } from './eval/oracle.ts';

/** How many differences of each kind are listed. */
const LISTED_DIFFERENCES = 10;

const STORE_READ_BUSY_MS = 5000;

/** How long to wait for the compiler to answer one target, in milliseconds, unless `--max-wait-ms` says otherwise. */
const DEFAULT_MAX_WAIT_MS = 120_000;

/** One class or interface of the repository that something extends or implements. */
export interface RelationTarget {
  /** The repository-relative path of the file that declares it. */
  readonly definedIn: string;
  readonly symbol: string;
  readonly kind: 'class' | 'interface';
}

export interface Census {
  /** Repository classes and interfaces with at least one subtype, in path then name order. */
  readonly targets: readonly RelationTarget[];
  /** Names of library classes and interfaces (declared in a lib file) that something in the repository extends. */
  readonly libraryBases: readonly string[];
}

/** One subtype as a pair: the file that declares it and its name. */
export interface SubtypePair {
  readonly file: string;
  readonly name: string;
}

/** One relation the store holds. */
export interface StoredRelation {
  readonly relation: string;
  readonly from: { readonly path: string; readonly qualifiedName: string; readonly kind: string };
  readonly to: { readonly path: string; readonly qualifiedName: string; readonly kind: string };
}

export interface Comparison {
  readonly agree: number;
  readonly storeOnly: readonly SubtypePair[];
  readonly oracleOnly: readonly SubtypePair[];
}

export interface TargetRow {
  readonly target: RelationTarget;
  readonly oracle: number;
  readonly store: number;
  readonly agree: number;
  readonly storeOnly: number;
  readonly oracleOnly: number;
}

export interface CheckOptions {
  /** The prepared checkout: a git work tree with a tsconfig. */
  readonly dir: string;
  /** The tsconfig the oracle builds its program from, relative to `dir`. Default `tsconfig.json`. */
  readonly tsconfig?: string;
  readonly maxWaitMs?: number;
  /** Where the lines go. Default stdout. */
  readonly out?: (line: string) => void;
  /** Replaces the build and the read of the store. Tests inject one to force a difference. */
  readonly readStoreRelations?: (dir: string, workDir: string, targets: readonly RelationTarget[]) => Promise<readonly StoredRelation[]>;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly rows: readonly TargetRow[];
  readonly agree: number;
  readonly storeOnly: number;
  readonly oracleOnly: number;
  /** The library bases, with how many subtypes the oracle finds for each. They are not differences. */
  readonly libraryBases: readonly { readonly name: string; readonly subtypes: number }[];
}

// ---------------------------------------------------------------------------------------------
// The census (the oracle's side)

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The classes and interfaces of the repository that something extends or implements, from the oracle's own program. */
export function censusOf(ctx: OracleContext): Census {
  const state = stateOf(ctx);
  const targets = new Map<string, RelationTarget>();
  const library = new Set<string>();
  for (const unit of state.units.values()) {
    walk(unit.sf, (node) => {
      if ((!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) || node.name === undefined) return;
      for (const type of heritageTypes(node)) {
        const resolved = resolveHeritageSymbol(state, type);
        const declaration = resolved?.declarations?.[0];
        if (resolved === undefined || declaration === undefined) continue;
        const file = declaration.getSourceFile();
        if (isLibraryFile(state, file)) {
          library.add(resolved.name);
          continue;
        }
        const rel = relInside(state.repoDir, file.fileName);
        // A base the repository does not hold (a dependency under node_modules) has no symbol in the store either.
        if (rel === undefined || !state.units.has(rel)) continue;
        const kind = ts.isClassDeclaration(declaration) ? 'class' : ts.isInterfaceDeclaration(declaration) ? 'interface' : undefined;
        if (kind === undefined) continue;
        targets.set(`${rel}\u0000${resolved.name}`, { definedIn: rel, symbol: resolved.name, kind });
      }
    });
  }
  return {
    targets: [...targets.values()].sort((a, b) => compareText(a.definedIn, b.definedIn) || compareText(a.symbol, b.symbol)),
    libraryBases: [...library].sort(compareText),
  };
}

// ---------------------------------------------------------------------------------------------
// Comparison

const keyOf = (pair: SubtypePair): string => `${pair.file}\u0000${pair.name}`;

function distinct(pairs: readonly SubtypePair[]): SubtypePair[] {
  const seen = new Map<string, SubtypePair>();
  for (const pair of pairs) if (!seen.has(keyOf(pair))) seen.set(keyOf(pair), { file: pair.file, name: pair.name });
  return [...seen.values()].sort((a, b) => compareText(a.file, b.file) || compareText(a.name, b.name));
}

/** Pair the oracle's subtypes with the store's by file and name. A pair is counted once however often a side lists it. */
export function compareSubtypes(oracle: readonly SubtypePair[], store: readonly SubtypePair[]): Comparison {
  const storeKeys = new Set(distinct(store).map(keyOf));
  const oracleKeys = new Set(distinct(oracle).map(keyOf));
  const agree = [...oracleKeys].filter((key) => storeKeys.has(key)).length;
  return {
    agree,
    oracleOnly: distinct(oracle).filter((pair) => !storeKeys.has(keyOf(pair))),
    storeOnly: distinct(store).filter((pair) => !oracleKeys.has(keyOf(pair))),
  };
}

// ---------------------------------------------------------------------------------------------
// The store side

/** The one store directory the override created, and its database file. */
function storeFileUnder(storeRoot: string): string {
  const stores = fs.readdirSync(storeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (stores.length !== 1) throw new Error(`expected one store under ${storeRoot}, found ${String(stores.length)}`);
  return path.join(storeRoot, (stores[0] as fs.Dirent).name, STORE_FILE_NAME);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The codes that mean the compiler's answer is not coming (a fallback to the compiler bundled with the package is fine). */
const NO_ANSWER_CODES = ['precise_unavailable', 'memory_budget', 'resolver_failed', 'cache_unavailable'];

/**
 * Build `dir` once into an isolated store through the composed Host, ask `code_refs` for every target until the answer no
 * longer says `resolver_timeout` (the compiler fills the relations in the background past the first bound), and read every
 * stored relation through a read-only connection. Nothing here consults the oracle.
 */
export async function buildAndReadRelations(
  dir: string,
  workDir: string,
  targets: readonly RelationTarget[],
  options: { readonly maxWaitMs?: number } = {},
): Promise<StoredRelation[]> {
  const storeRoot = path.join(workDir, 'stores');
  const userDir = path.join(workDir, 'user');
  const home = path.join(workDir, 'home');
  for (const made of [storeRoot, userDir, home]) fs.mkdirSync(made, { recursive: true });
  const env = { ...process.env, GSD_ATLAS_USER_DIR: userDir, GSD_ATLAS_STORE_DIR: storeRoot };
  const composed = composeHost({ cwd: dir, env, stderr: process.stderr, home });
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  try {
    const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: dir } });
    if (!built.ok || built.data === null) {
      throw new Error(`build failed: ${built.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
    }
    for (const target of targets) {
      const started = Date.now();
      for (;;) {
        const answer = await composed.client.handle({
          protocol: PROTOCOL_VERSION,
          kind: 'code_refs',
          args: { repo: dir, name: target.symbol, path: target.definedIn, kind: target.kind },
        });
        const degraded = answer.degraded ?? [];
        const failed = degraded.filter((code) => NO_ANSWER_CODES.includes(code));
        if (!answer.ok || failed.length > 0) {
          throw new Error(`the compiler did not answer for ${target.definedIn} ${target.symbol}: ${[...failed, ...answer.diagnostics.map((d) => d.code)].join(', ')}`);
        }
        if (!degraded.includes('resolver_timeout')) break;
        if (Date.now() - started > maxWaitMs) throw new Error(`the compiler did not answer for ${target.definedIn} ${target.symbol} within ${String(maxWaitMs)} ms`);
        await sleep(300);
      }
    }
  } finally {
    await composed.dispose();
  }
  const db = await openDatabase(storeFileUnder(storeRoot), { readOnly: true, timeoutMs: STORE_READ_BUSY_MS });
  try {
    return db
      .prepare(
        `SELECT DISTINCT from_path, from_qualified_name, from_kind, to_path, to_qualified_name, to_kind, relation
         FROM resolved_relations
         ORDER BY from_path, from_qualified_name, to_path, to_qualified_name, relation`,
      )
      .all()
      .map((row) => ({
        relation: String(row['relation']),
        from: { path: String(row['from_path']), qualifiedName: String(row['from_qualified_name']), kind: String(row['from_kind']) },
        to: { path: String(row['to_path']), qualifiedName: String(row['to_qualified_name']), kind: String(row['to_kind']) },
      }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The run

function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Run the comparison. The work directory (the isolated store) is removed in `finally`. */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dir = path.resolve(options.dir);
  const ctx: OracleContext = { repoDir: dir, tsconfig: options.tsconfig ?? 'tsconfig.json' };

  const census = censusOf(ctx);
  out(`relations-check: the oracle finds ${String(census.targets.length)} classes and interfaces with at least one subtype; comparing all of them`);

  const workDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gsd-atlas-relations-check-'));
  try {
    const stored = await (options.readStoreRelations ?? ((d, w, t) => buildAndReadRelations(d, w, t, options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs })))(
      dir,
      workDir,
      census.targets,
    );
    out(`relations-check: the store holds ${String(stored.length)} relations in total`);

    const rows: TargetRow[] = [];
    const storeOnlyEntries: string[] = [];
    const oracleOnlyEntries: string[] = [];
    out('target  oracle  store  agree  store_only  oracle_only');
    for (const target of census.targets) {
      const key = await computeAnswerKey(
        { kind: 'heritage', symbol: target.symbol, definedIn: target.definedIn, direction: 'subtypes', granularity: 'file+symbol', equality: 'exact-set' },
        ctx,
      );
      const oracle = key.items.flatMap((item) => (item.file === undefined || item.symbol === undefined ? [] : [{ file: item.file, name: item.symbol }]));
      const store = stored
        .filter(
          (item) =>
            (item.relation === 'extends' || item.relation === 'implements') &&
            item.to.path === target.definedIn &&
            item.to.qualifiedName === target.symbol,
        )
        .map((item) => ({ file: item.from.path, name: item.from.qualifiedName }));
      const compared = compareSubtypes(oracle, store);
      const row: TargetRow = {
        target,
        oracle: distinct(oracle).length,
        store: distinct(store).length,
        agree: compared.agree,
        storeOnly: compared.storeOnly.length,
        oracleOnly: compared.oracleOnly.length,
      };
      rows.push(row);
      out(`${target.definedIn}:${target.symbol}  ${String(row.oracle)}  ${String(row.store)}  ${String(row.agree)}  ${String(row.storeOnly)}  ${String(row.oracleOnly)}`);
      for (const pair of compared.storeOnly) storeOnlyEntries.push(`${pair.file} ${pair.name} (${target.symbol})`);
      for (const pair of compared.oracleOnly) oracleOnlyEntries.push(`${pair.file} ${pair.name} (${target.symbol})`);
    }

    const agree = rows.reduce((sum, row) => sum + row.agree, 0);
    const storeOnly = rows.reduce((sum, row) => sum + row.storeOnly, 0);
    const oracleOnly = rows.reduce((sum, row) => sum + row.oracleOnly, 0);
    out(`agree ${String(agree)}`);
    out(`store_only ${String(storeOnly)}`);
    out(`oracle_only ${String(oracleOnly)}`);
    for (const entry of storeOnlyEntries.slice(0, LISTED_DIFFERENCES)) out(`store_only: ${entry}`);
    for (const entry of oracleOnlyEntries.slice(0, LISTED_DIFFERENCES)) out(`oracle_only: ${entry}`);

    const libraryBases: { name: string; subtypes: number }[] = [];
    for (const name of census.libraryBases) {
      const key = await computeAnswerKey({ kind: 'heritage', symbol: name, lib: true, direction: 'subtypes', granularity: 'file+symbol', equality: 'exact-set' }, ctx);
      libraryBases.push({ name, subtypes: key.items.length });
    }
    out('library bases (not stored)');
    for (const base of libraryBases) out(`${base.name} ${String(base.subtypes)}`);

    return { ok: storeOnly === 0 && oracleOnly === 0, rows, agree, storeOnly, oracleOnly, libraryBases };
  } finally {
    removeTree(workDir);
  }
}

const USAGE = 'usage: node scripts/relations-check.ts --dir <prepared checkout> [--tsconfig tsconfig.json] [--max-wait-ms 120000]\n';

/** The command-line body, with the output sink injected. Returns the exit code. */
export async function runCli(argv: string[], write: (text: string) => void, overrides: Partial<CheckOptions> = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        tsconfig: { type: 'string' },
        'max-wait-ms': { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    write(`relations-check: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.dir === undefined) {
    write(`relations-check: --dir is required\n${USAGE}`);
    return 2;
  }
  const wait = values['max-wait-ms'];
  if (wait !== undefined && (!/^\d+$/.test(wait) || !Number.isSafeInteger(Number(wait)))) {
    write(`relations-check: --max-wait-ms must be a whole number, got ${wait}\n${USAGE}`);
    return 2;
  }
  const report = await runCheck({
    dir: values.dir,
    ...(values.tsconfig === undefined ? {} : { tsconfig: values.tsconfig }),
    ...(wait === undefined ? {} : { maxWaitMs: Number(wait) }),
    out: (line) => {
      write(`${line}\n`);
    },
    ...overrides,
  });
  write(`relations-check: ${report.ok ? 'OK' : 'FAILED'}\n`);
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
      process.stderr.write(`relations-check: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
