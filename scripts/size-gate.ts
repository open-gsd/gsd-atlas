/**
 * node scripts/size-gate.ts [--files N] [--edits N] [--symbols N] [--max-ratio R] [--maintain-every N] [--driver NAME]
 *
 * The store size gate (STO-05, DESIGN lifecycle budgets). It builds a store of synthetic files, applies many
 * edits (each recommits one file under a new content hash with changed facts and new identifier names), runs the
 * store's idle maintenance at its normal cadence (the same `IDLE_MAINTENANCE` policy the Tenant runs), then builds
 * a second store from the final content and compares sizes. The asserted figure is the IDLE-ONLY size: the edited
 * store's file after the idle loop alone, measured before any explicit full compaction, divided by a settled fresh
 * build of the same final content. It must be at most `max-ratio` (default the approved `gate.storeEditsRatio`,
 * 1.25); otherwise the command prints OVER and exits 1. The size after an explicit final `compact({ full: true })`
 * is printed as `settledBytes` and `settledRatio` for information only: a store that meets the bound only after a
 * manual full compaction does not pass.
 *
 * The generator is deterministic: file choice comes from a seeded linear congruential counter and every fact
 * from the file index and its version number, so two runs give the same sizes. Time comes from a counter clock
 * that never fires a timer, so nothing depends on the wall clock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { IDLE_MAINTENANCE, openFactStore } from '../src/fact-store/index.ts';
import type { FactStore, Resolver, StoreDeps, StoreMaintainOptions, Writer } from '../src/fact-store/index.ts';
import type { Clock, FileFacts, Span } from '../src/facts/index.ts';

/** The approved `gate.storeEditsRatio` of 02-CONSTANTS.md (STO-05). */
export const DEFAULT_MAX_RATIO = 1.25;

const DEFAULTS = { files: 300, symbolsPerFile: 8, edits: 20_000, maintainEvery: 200 } as const;

/** The budget of one idle maintenance run in the gate: generous, so each run finishes what is pending. */
const MAINTAIN_BUDGET_MS = 600_000;

/** How many `maintain` calls a final settle may take before the gate gives up on the store finishing. */
const SETTLE_LIMIT = 100;

export interface SizeGateOptions {
  /** How many files the synthetic repository has. Default 300 (research assumption A12). */
  readonly files?: number;
  /** Symbols in a file at its first version; later versions add and remove a few. Default 8. */
  readonly symbolsPerFile?: number;
  /** How many single-file edits to apply. Default 20,000. */
  readonly edits?: number;
  /** The largest idle-only edited-to-fresh size ratio that passes. Default 1.25. */
  readonly maxRatio?: number;
  /** Run `store.maintain` after every this many edits; 0 turns maintenance off (the negative control). Default 200. */
  readonly maintainEvery?: number;
  /** The SQLite driver to run on. Default `node:sqlite`. */
  readonly driver?: 'node:sqlite' | 'better-sqlite3';
  /**
   * The options passed to every idle `store.maintain` call. Default `IDLE_MAINTENANCE`, the policy the Tenant runs.
   * A test passes `{}` (the policy before plan 02-30) to prove the gate fails without the fix.
   */
  readonly idle?: StoreMaintainOptions;
}

export interface SizeGateResult {
  /** Size of the store built once from the final content, after compaction. */
  readonly freshBytes: number;
  /** Informational: size of the store that took every edit, after the idle loop AND an explicit full compaction. */
  readonly editedBytes: number;
  /** The asserted figure: `idleBytes / freshBytes`. */
  readonly ratio: number;
  readonly ok: boolean;
  /**
   * The edited store's size after the idle maintenance loop alone, measured before any explicit full compaction.
   * This is what the gate asserts.
   */
  readonly idleBytes: number;
  /** Informational, not asserted: `editedBytes / freshBytes`, the ratio after the explicit final compaction. */
  readonly settledRatio: number;
  /** How many times `maintain` ran during the edits. */
  readonly maintainRuns: number;
}

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number): Span => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

const pathOf = (file: number): string => `src/gen/f${file}.ts`;

/** A 40-hex blob id, unique per (file, version). */
function hashOf(file: number, version: number, files: number): string {
  return (version * files + file + 1).toString(16).padStart(40, '0');
}

/**
 * The facts of `file` at `version`. A third of the symbol names carry the version, so every edit introduces new
 * identifier names; the symbol and reference counts move between versions, so edits add and remove rows.
 */
export function factsFor(file: number, version: number, files: number, symbolsPerFile: number): FileFacts {
  const symbolCount = Math.max(1, symbolsPerFile + (version % 3) - 1);
  const refCount = Math.max(1, symbolsPerFile + (version % 2));
  const nameOf = (owner: number, index: number, at: number): string =>
    index % 3 === 0 ? `fn${owner}_${index}_v${at}` : `fn${owner}_${index}`;
  const hash = hashOf(file, version, files);
  return {
    path: pathOf(file),
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: Array.from({ length: symbolCount }, (_, index) => ({
      name: nameOf(file, index, version),
      kind: 'function',
      span: span(index * 4, 0, index * 4 + 3, 1),
      exported: index % 2 === 0,
    })),
    refSites: Array.from({ length: refCount }, (_, index) => ({
      // Calls into the next file's stable names, and into the file's own versioned ones.
      name: index % 2 === 0 ? `fn${(file + 1) % files}_${(index + 1) % symbolsPerFile}` : nameOf(file, index % symbolCount, version),
      span: span(index * 4 + 1, 2, index * 4 + 1, 12),
      kind: 'call' as const,
      enclosing: index % symbolCount,
    })),
    imports: [
      { path: `./mod${file % 17}`, span: span(100, 0, 100, 30), style: 'es' as const },
      { path: '../shared', span: span(101, 0, 101, 26), style: 'es' as const },
    ],
    exports: [],
    parse: { errorBytes: 0, totalBytes: 1200 + symbolCount * 40 },
  };
}

/** A clock that counts instead of reading the wall clock and never fires a timer. */
function countingClock(): Clock {
  let tick = 1_000_000;
  return {
    now: () => (tick += 1),
    sleep: () => Promise.resolve(),
    after: () => () => undefined,
  };
}

const noResolver: Resolver = async function* () {
  // the gate runs on the grammar tier alone
};

/** Remove a directory; Windows keeps database files locked for a moment after close, so retry. */
function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** A seeded linear congruential counter: the next state of `state`, 32 bits. */
const nextState = (state: number): number => (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

async function openStore(dir: string, options: SizeGateOptions, clock: Clock): Promise<FactStore> {
  const deps: StoreDeps = { resolver: noResolver, clock, gitHas: async () => true };
  return openFactStore(dir, deps, { driver: options.driver ?? 'node:sqlite', repo: 'gate', version: 'size-gate' });
}

async function commit(writer: Writer, file: number, version: number, files: number, symbolsPerFile: number): Promise<void> {
  const facts = factsFor(file, version, files, symbolsPerFile);
  const result = await writer.commitFile({ worktree: 'main', path: pathOf(file), hash: facts.contentHash, facts });
  if (result.status !== 'committed') {
    throw new Error(`size-gate: committing ${pathOf(file)} version ${version} answered ${result.status}`);
  }
}

/** Compact fully: collect nothing more, give every free page back, truncate the log; then report the file size. */
async function settledSize(store: FactStore): Promise<number> {
  const result = await store.compact({ budgetMs: MAINTAIN_BUDGET_MS, full: true });
  if (!result.complete) throw new Error('size-gate: compaction did not finish inside its budget');
  return (await store.status()).sizeBytes;
}

function checkCount(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`size-gate: --${name} must be a whole number, ${minimum} or more`);
}

export async function runSizeGate(options: SizeGateOptions = {}): Promise<SizeGateResult> {
  const files = options.files ?? DEFAULTS.files;
  const symbolsPerFile = options.symbolsPerFile ?? DEFAULTS.symbolsPerFile;
  const edits = options.edits ?? DEFAULTS.edits;
  const maxRatio = options.maxRatio ?? DEFAULT_MAX_RATIO;
  const maintainEvery = options.maintainEvery ?? DEFAULTS.maintainEvery;
  const idle = options.idle ?? IDLE_MAINTENANCE;
  checkCount('files', files, 1);
  checkCount('symbols', symbolsPerFile, 1);
  checkCount('edits', edits, 0);
  checkCount('maintain-every', maintainEvery, 0);
  if (!Number.isFinite(maxRatio) || maxRatio <= 0) throw new RangeError('size-gate: --max-ratio must be a positive number');

  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gsd-atlas-size-gate-'));
  const stores: FactStore[] = [];
  try {
    const clock = countingClock();
    const versions = new Array<number>(files).fill(0);

    // The edited store: every file at version 0, then `edits` single-file edits with maintenance in between.
    const edited = await openStore(path.join(root, 'edited'), options, clock);
    stores.push(edited);
    let writer = edited.writer();
    for (let file = 0; file < files; file += 1) await commit(writer, file, 0, files, symbolsPerFile);
    let state = 20_261_016;
    let maintainRuns = 0;
    for (let edit = 1; edit <= edits; edit += 1) {
      state = nextState(state);
      const file = state % files;
      versions[file] = (versions[file] ?? 0) + 1;
      await commit(writer, file, versions[file] ?? 0, files, symbolsPerFile);
      if (maintainEvery > 0 && edit % maintainEvery === 0) {
        writer.release(); // `maintain` takes the writer slot itself
        await edited.maintain(MAINTAIN_BUDGET_MS, idle);
        maintainRuns += 1;
        writer = edited.writer();
      }
    }
    writer.release();
    if (maintainEvery > 0) {
      // Settle: whatever the last edits left behind, within the same idle task.
      for (let round = 0; round < SETTLE_LIMIT; round += 1) {
        maintainRuns += 1;
        if ((await edited.maintain(MAINTAIN_BUDGET_MS, idle)).complete) break;
      }
    }
    // The asserted figure is read here, before the explicit full compaction below can hide the idle loop's gap.
    const idleBytes = (await edited.status()).sizeBytes;
    const editedBytes = await settledSize(edited);

    // The fresh store: only the final content, written once.
    const fresh = await openStore(path.join(root, 'fresh'), options, clock);
    stores.push(fresh);
    const freshWriter = fresh.writer();
    for (let file = 0; file < files; file += 1) await commit(freshWriter, file, versions[file] ?? 0, files, symbolsPerFile);
    freshWriter.release();
    const freshBytes = await settledSize(fresh);

    const ratio = idleBytes / freshBytes;
    return { freshBytes, editedBytes, ratio, ok: ratio <= maxRatio, idleBytes, settledRatio: editedBytes / freshBytes, maintainRuns };
  } finally {
    for (const store of stores) await store.close(); // every handle is closed before the files go (EBUSY on Windows)
    removeTree(root);
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

function whole(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new RangeError(`size-gate: --${name} must be a whole number, got ${JSON.stringify(text)}`);
  return Number(text);
}

function driverOf(text: string | undefined): SizeGateOptions['driver'] {
  if (text === undefined || text === 'node:sqlite' || text === 'better-sqlite3') return text;
  throw new RangeError('size-gate: --driver must be node:sqlite or better-sqlite3');
}

/** The CLI body, with the output sink injected so tests can run it in-process. Returns the exit code. */
export async function runCli(argv: string[], write: (text: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      files: { type: 'string' },
      edits: { type: 'string' },
      symbols: { type: 'string' },
      'max-ratio': { type: 'string' },
      'maintain-every': { type: 'string' },
      driver: { type: 'string' },
    },
  });
  const maxRatio = values['max-ratio'] === undefined ? DEFAULT_MAX_RATIO : Number(values['max-ratio']);
  if (!Number.isFinite(maxRatio) || maxRatio <= 0) throw new RangeError('size-gate: --max-ratio must be a positive number');
  const driver = driverOf(values.driver);
  const options = {
    files: whole('files', values.files, DEFAULTS.files),
    symbolsPerFile: whole('symbols', values.symbols, DEFAULTS.symbolsPerFile),
    edits: whole('edits', values.edits, DEFAULTS.edits),
    maintainEvery: whole('maintain-every', values['maintain-every'], DEFAULTS.maintainEvery),
    maxRatio,
    ...(driver === undefined ? {} : { driver }),
  };
  checkCount('files', options.files, 1);
  const began = Date.now();
  const result = await runSizeGate(options);
  write(
    `size-gate: files ${options.files} symbols ${options.symbolsPerFile} edits ${options.edits} maintain-every ${options.maintainEvery} ` +
      `freshBytes ${result.freshBytes} idleBytes ${result.idleBytes} idleRatio ${result.ratio.toFixed(4)} max ${maxRatio} ` +
      `settledBytes ${result.editedBytes} settledRatio ${result.settledRatio.toFixed(4)} ` +
      `maintainRuns ${result.maintainRuns} seconds ${((Date.now() - began) / 1000).toFixed(1)} ${result.ok ? 'OK' : 'OVER'}\n`,
  );
  return result.ok ? 0 : 1;
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`size-gate: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
