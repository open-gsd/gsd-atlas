import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createGrammarEngine } from '../src/grammar-engine/index.ts';
import { readModuleInputs } from '../src/lang/module-files.ts';
import { discoverModules } from './grammar-build.ts';

/**
 * node scripts/grammar-budget.ts [moduleDir...] [--fixtures-dir <name>]
 *
 * The CI parse-quality gate (LNG-06, D-06). For every module it runs the grammar over each
 * fixture file and compares bytes inside outermost ERROR nodes with source bytes against the
 * module's manifest `parseBudget` (default 0.5 percent). Over budget (strictly greater) exits 1.
 *
 * The measured set is the regular files of the fixtures folder (default `fixtures`) whose
 * extension the manifest claims, minus golden files (names containing `.golden`). The negative
 * folder (`fixtures-negative`) is never measured unless asked for by name.
 */

export interface BudgetOptions {
  /** Folder name inside the module directory. Default `fixtures`. */
  readonly fixturesDir?: string;
  /** Overrides the manifest parseBudget. */
  readonly budget?: number;
}

export interface BudgetResult {
  readonly ok: boolean;
  readonly module: string;
  readonly errorBytes: number;
  readonly totalBytes: number;
  /** errorBytes / totalBytes, 0 when there are no bytes. */
  readonly ratio: number;
  readonly budget: number;
  readonly files: ReadonlyArray<{ readonly file: string; readonly errorBytes: number; readonly totalBytes: number }>;
  /** Why the check could not pass for a reason other than the ratio (no fixtures, unreadable file, ...). */
  readonly problems: readonly string[];
}

export class GrammarBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrammarBudgetError';
  }
}

function assertPlainFolderName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..' || /[\\/]/.test(name) || path.isAbsolute(name) || name.includes('\0')) {
    throw new GrammarBudgetError(`--fixtures-dir must be a plain folder name inside the module, got "${name}"`);
  }
}

function fixtureFiles(fixturesPath: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(fixturesPath)) {
    return [];
  }
  const wanted = new Set(extensions.map((e) => e.toLowerCase()));
  return fs
    .readdirSync(fixturesPath, { withFileTypes: true })
    // isFile() is false for a symlink, so a link out of the module is never followed here.
    .filter((entry) => entry.isFile() && !entry.name.includes('.golden') && wanted.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
}

export async function checkBudget(moduleDir: string, opts: BudgetOptions = {}): Promise<BudgetResult> {
  const fixturesDir = opts.fixturesDir ?? 'fixtures';
  assertPlainFolderName(fixturesDir);
  const inputs = readModuleInputs(moduleDir);
  if (!inputs.ok) {
    throw new GrammarBudgetError(
      `cannot read module ${moduleDir}: ${inputs.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`,
    );
  }
  const budget = opts.budget ?? inputs.manifest.parseBudget;
  const fixturesPath = path.join(moduleDir, fixturesDir);
  const names = fixtureFiles(fixturesPath, inputs.manifest.extensions);

  const problems: string[] = [];
  const files: Array<{ file: string; errorBytes: number; totalBytes: number }> = [];
  let errorBytes = 0;
  let totalBytes = 0;

  const engine = createGrammarEngine();
  try {
    const grammar = await engine.load(inputs.input);
    for (const name of names) {
      try {
        const result = await grammar.run(fs.readFileSync(path.join(fixturesPath, name), 'utf8'));
        files.push({ file: name, errorBytes: result.errorBytes, totalBytes: result.totalBytes });
        errorBytes += result.errorBytes;
        totalBytes += result.totalBytes;
      } catch (error) {
        problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await engine.dispose();
  }
  if (names.length === 0) {
    problems.push(`no fixture files with a manifest extension found in ${fixturesDir}/`);
  }

  const ratio = totalBytes === 0 ? 0 : errorBytes / totalBytes;
  return {
    ok: problems.length === 0 && !(ratio > budget),
    module: inputs.manifest.name,
    errorBytes,
    totalBytes,
    ratio,
    budget,
    files,
    problems,
  };
}

function formatResult(result: BudgetResult): string {
  const lines = [
    `${result.module}: errorBytes ${String(result.errorBytes)} totalBytes ${String(result.totalBytes)} ` +
      `ratio ${result.ratio.toFixed(6)} budget ${String(result.budget)} ${result.ok ? 'OK' : 'OVER BUDGET'}`,
  ];
  for (const problem of result.problems) {
    lines.push(`  problem: ${problem}`);
  }
  if (!result.ok) {
    for (const file of result.files.filter((f) => f.errorBytes > 0)) {
      lines.push(`  ${file.file}: ${String(file.errorBytes)} error bytes of ${String(file.totalBytes)}`);
    }
  }
  return lines.join('\n');
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

/** The CLI body, with the output sink injected so tests can run it in-process. Returns the exit code. */
export async function runCli(argv: string[], write: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'fixtures-dir': { type: 'string' } },
  });
  const modules = positionals.length > 0 ? positionals.map((p) => path.resolve(p)) : discoverModules();
  if (modules.length === 0) {
    write('grammar-budget: no module with a grammar.lock found\n');
    return 1;
  }
  let status = 0;
  for (const moduleDir of modules) {
    const opts: BudgetOptions = values['fixtures-dir'] === undefined ? {} : { fixturesDir: values['fixtures-dir'] };
    const result = await checkBudget(moduleDir, opts);
    write(`${formatResult(result)}\n`);
    if (!result.ok) {
      status = 1;
    }
  }
  return status;
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`grammar-budget: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
