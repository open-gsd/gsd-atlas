/**
 * node scripts/project-model-differential.ts --corpus gsd-core|gsd-pi [--dir <prepared checkout>] [--keep]
 *
 * The corpus differential for the compiler-free ProjectModel (TSM-07, plan 03-18): on a pinned checkout, for every
 * `tsconfig*.json` / `jsconfig*.json` git tracks, the model's `matches(config, path)` is compared with the compiler's
 * own file list (`ts.parseJsonConfigFileContent(...).fileNames`) for every tracked path. One line is printed per
 * config with the number of paths compared and the number of disagreements; the exit status is 1 when any config the
 * model reports as understood disagrees (or any config makes the model throw), else 0.
 *
 * "Understood" means the model read the whole chain without an `extends_*` or `tsconfig_*` diagnostic. A config
 * whose `extends` points at a package that is not installed (a pnpm workspace checked out without `node_modules`) is
 * still compared and printed, but only as information: the compiler fails the same way, and the result says nothing
 * about the model.
 *
 * Without `--dir` the checkout is fetched at the manifest SHA and prepared by `scripts/eval/prepare-corpus.ts` run as
 * a child process (needs the network; `--no-npm-ci`, because the differential reads configs and sources only), into
 * a temporary directory that is removed afterwards unless `--keep` is given. `typescript` is used here, in a script,
 * as the oracle; it is never imported by the model.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

import { createTypeScriptProjectModel } from '../src/project-model/index.ts';
import type { ProjectFs } from '../src/project-model/index.ts';
import { DEFAULT_READ_TEXT_BYTES, readConfinedText } from '../src/source-tree/read-text.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PREPARE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'eval', 'prepare-corpus.ts');
const CORPORA = ['gsd-core', 'gsd-pi'] as const;
const CONFIG_NAME = /^[jt]sconfig(?:\.[^/]*)?\.json$/;
const SHOWN_DISAGREEMENTS = 5;

export interface ConfigReport {
  readonly path: string;
  /** Tracked paths the model and the compiler were both asked about. */
  readonly compared: number;
  /** Tracked paths the two answered differently, as `path (model yes|no)`. */
  readonly disagreements: readonly string[];
  /** Paths the model says belong to the config. */
  readonly modelFiles: number;
  /** Files in the compiler's list (tracked or not). */
  readonly compilerFiles: number;
  /** False when the model reported a problem with the chain; then the line is information only. */
  readonly understood: boolean;
  readonly notes: readonly string[];
}

export interface DifferentialReport {
  readonly dir: string;
  readonly tracked: number;
  readonly configs: readonly ConfigReport[];
  /** Configs that made the model or the compiler throw, as `path: message`. */
  readonly crashes: readonly string[];
  /** Disagreements on configs the model reported as understood. */
  readonly disagreements: number;
}

export interface CompareOptions {
  /** Wraps the reader the model sees (the compiler always reads the disk). For tests that break the model on purpose. */
  readonly wrapFs?: (fs: ProjectFs) => ProjectFs;
}

// ---------------------------------------------------------------------------------------------
// The checkout

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  return env;
}

/** Every path git tracks in `dir`, repo-relative POSIX. */
export function trackedPaths(dir: string): string[] {
  const result = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', env: gitEnv(), windowsHide: true, maxBuffer: 1 << 28 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ls-files failed in ${dir}: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.split('\0').filter((p) => p !== '');
}

/** A reader over a real directory: every read goes through the confined reader (realpath containment, no links out). */
export function directoryProjectFs(root: string): ProjectFs {
  return {
    readText: (p) => readConfinedText(root, p, DEFAULT_READ_TEXT_BYTES),
    async exists(paths) {
      const found = new Set<string>();
      for (const p of paths) {
        try {
          if ((await fs.promises.lstat(path.join(root, ...p.split('/')))).isFile()) found.add(p);
        } catch {
          // absent: not in the set
        }
      }
      return found;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The comparison

const compilerHost: ts.ParseConfigHost = { ...ts.sys, useCaseSensitiveFileNames: true };

/** The compiler's own file list for one config, as repo-relative POSIX paths. */
function compilerFileNames(root: string, configRel: string): Set<string> {
  const configPath = path.join(root, ...configRel.split('/'));
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, compilerHost, path.dirname(configPath), undefined, configPath);
  return new Set(parsed.fileNames.map((f) => path.relative(root, f).split(path.sep).join('/')));
}

/** Compares the model with the compiler over the checkout at `dir`. */
export async function compareCheckout(dir: string, options: CompareOptions = {}): Promise<DifferentialReport> {
  const root = path.resolve(dir);
  const tracked = trackedPaths(root);
  const base = directoryProjectFs(root);
  const projectFs = options.wrapFs === undefined ? base : options.wrapFs(base);
  const model = createTypeScriptProjectModel(projectFs);
  const extraConfigs = tracked.filter((p) => CONFIG_NAME.test(p.slice(p.lastIndexOf('/') + 1)));
  const description = await model.describe({ overlayPaths: tracked, fs: projectFs, extraConfigs });

  const configs: ConfigReport[] = [];
  const crashes: string[] = [];
  let disagreementTotal = 0;
  for (const config of description.configs) {
    try {
      const compiler = compilerFileNames(root, config.path);
      const chain = new Set(config.chain);
      const notes = description.diagnostics
        .filter((d) => d.subject !== undefined && chain.has(d.subject) && (d.code.startsWith('extends_') || d.code.startsWith('tsconfig_')))
        .map((d) => `${d.code} at ${d.subject ?? ''}`);
      const understood = notes.length === 0;
      const disagreements: string[] = [];
      let modelFiles = 0;
      for (const p of tracked) {
        const mine = description.matches(config.path, p);
        if (mine) modelFiles += 1;
        if (mine !== compiler.has(p)) disagreements.push(`${p} (model ${mine ? 'yes' : 'no'})`);
      }
      if (understood) disagreementTotal += disagreements.length;
      configs.push({ path: config.path, compared: tracked.length, disagreements, modelFiles, compilerFiles: compiler.size, understood, notes });
    } catch (error) {
      crashes.push(`${config.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { dir: root, tracked: tracked.length, configs, crashes, disagreements: disagreementTotal };
}

export function formatReport(corpus: string, report: DifferentialReport): string {
  const lines: string[] = [];
  for (const c of report.configs) {
    const status = c.understood ? '' : ` [not understood, information only: ${c.notes.join('; ')}]`;
    lines.push(`${c.path}: compared=${String(c.compared)} disagreements=${String(c.disagreements.length)} model=${String(c.modelFiles)} compiler=${String(c.compilerFiles)}${status}`);
    for (const d of c.disagreements.slice(0, SHOWN_DISAGREEMENTS)) lines.push(`  ${d}`);
    if (c.disagreements.length > SHOWN_DISAGREEMENTS) lines.push(`  ... and ${String(c.disagreements.length - SHOWN_DISAGREEMENTS)} more`);
  }
  for (const crash of report.crashes) lines.push(`CRASH ${crash}`);
  const understood = report.configs.filter((c) => c.understood).length;
  lines.push(
    `${corpus}: configs=${String(report.configs.length)} understood=${String(understood)} tracked=${String(report.tracked)} disagreements=${String(report.disagreements)} crashes=${String(report.crashes.length)}`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Command line

export interface CliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export interface CliDeps extends CompareOptions {
  /** Replaces the fetch and prepare step. For tests; returns the checkout directory. */
  readonly prepare?: (corpus: string) => string;
}

const USAGE = 'usage: node scripts/project-model-differential.ts --corpus gsd-core|gsd-pi [--dir <prepared checkout>] [--keep]\n';

/** Fetches and prepares the pinned corpus through `scripts/eval/prepare-corpus.ts`; returns the checkout and a remover. */
function prepareCorpus(corpus: string): { dir: string; remove(): void } {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pm-diff-'));
  const remove = (): void => fs.rmSync(holder, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [PREPARE_SCRIPT, '--corpus', corpus, '--dest', holder, '--no-npm-ci'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 26,
  });
  const lines = (result.stdout ?? '').split('\n').filter((l) => l.trim() !== '');
  const dir = lines[lines.length - 1];
  if (result.error !== undefined || result.status !== 0 || dir === undefined) {
    remove();
    throw new Error(`could not prepare ${corpus}: ${result.error?.message ?? result.stderr}`);
  }
  return { dir: dir.trim(), remove };
}

/** Exit codes: 0 no disagreement, 1 a disagreement or crash (or the checkout could not be prepared), 2 usage. */
export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let values: { corpus?: string; dir?: string; keep?: boolean };
  try {
    values = parseArgs({
      args: [...argv],
      options: { corpus: { type: 'string' }, dir: { type: 'string' }, keep: { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.stderr.write(`project-model-differential: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const corpus = values.corpus;
  if (corpus === undefined || !(CORPORA as readonly string[]).includes(corpus)) {
    io.stderr.write(`project-model-differential: --corpus must be one of ${CORPORA.join(', ')}\n${USAGE}`);
    return 2;
  }

  let dir = values.dir;
  let remove: (() => void) | undefined;
  try {
    if (dir === undefined) {
      if (deps.prepare !== undefined) dir = deps.prepare(corpus);
      else {
        const prepared = prepareCorpus(corpus);
        dir = prepared.dir;
        if (values.keep !== true) remove = prepared.remove;
        else io.stderr.write(`project-model-differential: keeping ${prepared.dir}\n`);
      }
    }
    const report = await compareCheckout(dir, deps.wrapFs === undefined ? {} : { wrapFs: deps.wrapFs });
    io.stdout.write(formatReport(corpus, report));
    return report.disagreements > 0 || report.crashes.length > 0 ? 1 : 0;
  } catch (error) {
    io.stderr.write(`project-model-differential: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    remove?.();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
