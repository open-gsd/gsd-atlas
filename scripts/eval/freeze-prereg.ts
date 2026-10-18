/**
 * node scripts/eval/freeze-prereg.ts --stage A --by <name> [--prereg <path>] [--constants <path>]
 *
 * The mechanical half of the freeze (D-01, D-04, D-08, EVL-02). Given a Draft pre-registration it checks everything
 * a person must have settled, computes the sha256 of the sixteen Stage A files (CRLF read as LF), writes them into
 * the single `prereg-json` block, sets `Status: Frozen (Stage A, <date>, by <name>)` and runs `verifyPrereg` on the
 * result. It writes nothing unless every check passed, and it never writes a hash it did not just compute.
 *
 * Refusals, each leaving the document byte for byte as it was:
 * - `dirty_registered_file`: a Stage A file is modified, untracked or ignored (the hashes must be of committed bytes).
 * - `missing_file`: a Stage A path does not exist.
 * - `parameter_mismatch`: a registered parameter differs from the approved constants (03-CONSTANTS.md), or the
 *   document's question set, corpus sha or question count differs from the question file.
 * - `citation_criterion_unconfirmed`: the Approvals section does not hold exactly one line
 *   `OQ4 confirmed by the user: point_estimate|wilson_lower_bound`, equal to `params.citationJudgedOn`. A Draft value
 *   of `citationJudgedOn` alone never satisfies the check (OQ4 has no default).
 * - `tests_failed`: the eval test command exited non-zero.
 * - `already_frozen`, `invalid_document`, `invalid_reviewer`, `stage_unsupported`, `git_unavailable`,
 *   `verification_failed`: the document or the call is not one this tool can freeze.
 *
 * Exit codes of the command: 0 frozen, 1 refused, 2 usage error.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PREREG_PATH, hashFile, readPrereg, replacePreregBlock, STAGE_A_FILES } from './prereg.ts';
import type { Prereg } from './prereg.ts';
import { verifyPrereg } from './verify-prereg.ts';

/** Where the approved constants live (Status line `Approved`, one row per key). */
export const APPROVED_CONSTANTS_PATH = '.planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md';

const QUESTIONS_PATH = 'scripts/eval/questions/gsd-core.questions.json';
const ANSWERS_PATH = 'scripts/eval/questions/gsd-core.answers.json';

/** The values of 03-CONSTANTS.md that the pre-registration repeats. */
export interface ApprovedConstants {
  readonly marginPoints: number;
  /** The one-sided level of the bootstrap bound: 0.95 for "90 percent two-sided". */
  readonly intervalLevel: number;
  readonly resamples: number;
  readonly seed: number;
  readonly runsPerCell: number;
  readonly citationRate: number;
  readonly concurrency: number;
  readonly maxBudgetUsdPerSession: number;
  readonly sessionWallClockMs: number;
  /** The chosen N (`eval.scoredQuestions`). */
  readonly scoredQuestions: number;
  /** The locked floor (`eval.minQuestions`). */
  readonly minQuestions: number;
}

export interface TestCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface FreezeOptions {
  /** The repository root: Stage A paths are relative to it and `git` runs there. */
  readonly root: string;
  /** The pre-registration, relative to `root` or absolute. */
  readonly path: string;
  readonly stage: 'A' | 'B';
  readonly approvedBy: string;
  readonly now: Date;
  readonly approved: ApprovedConstants;
  /** The eval test command; default `node --test` over every `scripts/eval/*.test.ts`. */
  readonly testCommand?: TestCommand;
}

export type RefusalReason =
  | 'dirty_registered_file'
  | 'missing_file'
  | 'tests_failed'
  | 'parameter_mismatch'
  | 'citation_criterion_unconfirmed'
  | 'already_frozen'
  | 'invalid_document'
  | 'invalid_reviewer'
  | 'stage_unsupported'
  | 'git_unavailable'
  | 'verification_failed';

export type FreezeResult =
  | { readonly ok: true; readonly status: string; readonly files: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: RefusalReason; readonly details: string[] };

// ---------------------------------------------------------------------------------------------
// The approved constants

const KEY_ROW = /^\|\s*`(eval\.[A-Za-z]+)`\s*\|\s*([^|]*?)\s*\|/;

/**
 * Reads the `eval.*` rows of 03-CONSTANTS.md. Throws unless the file's Status line says Approved, a needed row is
 * missing or a value does not parse (the row is named). `eval.intervalLevel` is registered as the one-sided level, so
 * "90 percent two-sided" reads as 0.95.
 */
export function readApprovedConstants(file: string): ApprovedConstants {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (!lines.some((line) => /^Status:\s*Approved\b/.test(line))) {
    throw new Error(`${file}: the constants are not Approved (no line starting "Status: Approved")`);
  }
  const rows = new Map<string, string>();
  for (const line of lines) {
    const match = KEY_ROW.exec(line);
    if (match !== null) rows.set(match[1] as string, match[2] as string);
  }
  const number = (key: string): number => {
    const raw = rows.get(key);
    if (raw === undefined) throw new Error(`${file}: no row for ${key}`);
    const value = /^-?\d+(?:\.\d+)?(?=\s|$)/.exec(raw);
    if (value === null) throw new Error(`${file}: the value of ${key} does not start with a number: "${raw}"`);
    return Number(value[0]);
  };
  const interval = rows.get('eval.intervalLevel');
  if (interval === undefined) throw new Error(`${file}: no row for eval.intervalLevel`);
  const twoSided = /^(\d+(?:\.\d+)?)\s*percent two-sided/.exec(interval);
  if (twoSided === null) throw new Error(`${file}: the value of eval.intervalLevel is not "<n> percent two-sided ...": "${interval}"`);
  const oneSided = 1 - (1 - Number(twoSided[1]) / 100) / 2;
  return {
    marginPoints: number('eval.marginPoints'),
    intervalLevel: Number(oneSided.toFixed(6)),
    resamples: number('eval.bootstrapResamples'),
    seed: number('eval.bootstrapSeed'),
    runsPerCell: number('eval.runsPerCell'),
    citationRate: number('eval.citationRate'),
    concurrency: number('eval.concurrency'),
    maxBudgetUsdPerSession: number('eval.maxBudgetUsdPerSession'),
    sessionWallClockMs: number('eval.sessionWallClockMs'),
    scoredQuestions: number('eval.scoredQuestions'),
    minQuestions: number('eval.minQuestions'),
  };
}

/** One line per registered value that differs from the approved constants (and for a count below the floor). */
export function checkParams(prereg: Prereg, approved: ApprovedConstants): string[] {
  const problems: string[] = [];
  const same = (name: string, registered: number, wanted: number): void => {
    if (registered !== wanted) problems.push(`${name}: registered ${String(registered)}, approved ${String(wanted)}`);
  };
  const p = prereg.params;
  same('marginPoints', p.marginPoints, approved.marginPoints);
  same('intervalLevel', p.intervalLevel, approved.intervalLevel);
  same('resamples', p.resamples, approved.resamples);
  same('seed', p.seed, approved.seed);
  same('runsPerCell', p.runsPerCell, approved.runsPerCell);
  same('citationRate', p.citationRate, approved.citationRate);
  same('concurrency', p.concurrency, approved.concurrency);
  same('maxBudgetUsdPerSession', p.maxBudgetUsdPerSession, approved.maxBudgetUsdPerSession);
  same('sessionWallClockMs', p.sessionWallClockMs, approved.sessionWallClockMs);
  same('questionSet.count', prereg.questionSet.count, approved.scoredQuestions);
  if (prereg.questionSet.count < approved.minQuestions) {
    problems.push(`questionSet.count: ${String(prereg.questionSet.count)} is below the locked floor minQuestions ${String(approved.minQuestions)} (at least ${String(approved.minQuestions)} questions)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The OQ4 line

const OQ4_PREFIX = 'OQ4 confirmed by the user:';
const OQ4_VALUES: readonly string[] = ['point_estimate', 'wilson_lower_bound'];

export interface Oq4Reading {
  /** The valid values found on lines of the Approvals section. */
  readonly values: string[];
  /** Why the document does not hold exactly one valid line; empty when it does. */
  readonly problems: string[];
}

/**
 * Reads the OQ4 confirmation. Only a line that starts with `OQ4 confirmed by the user:` counts, so a mention inside
 * running prose or code ticks does not. The line must sit in the `## Approvals` section; there must be exactly one in
 * the whole document and its value must be one of the two names.
 */
export function oq4Confirmation(text: string): Oq4Reading {
  const lines = text.split(/\r?\n/);
  const problems: string[] = [];
  const values: string[] = [];
  let inApprovals = false;
  let hasApprovals = false;
  let total = 0;
  let invalid = 0;
  let outside = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inApprovals = /^##\s+Approvals\s*$/.test(line);
      if (inApprovals) hasApprovals = true;
      continue;
    }
    if (!line.startsWith(OQ4_PREFIX)) continue;
    total += 1;
    if (!inApprovals) {
      outside += 1;
      continue;
    }
    const value = line.slice(OQ4_PREFIX.length).trim();
    if (OQ4_VALUES.includes(value)) values.push(value);
    else invalid += 1;
  }
  if (!hasApprovals) problems.push('the document has no "## Approvals" section');
  if (outside > 0) problems.push(`${String(outside)} "${OQ4_PREFIX}" line(s) outside the Approvals section`);
  if (invalid > 0) problems.push(`${String(invalid)} "${OQ4_PREFIX}" line(s) name neither point_estimate nor wilson_lower_bound`);
  if (total === 0) problems.push(`no line starting "${OQ4_PREFIX}" (the user's explicit OQ4 value is required, there is no default)`);
  if (total > 1) problems.push(`${String(total)} lines start with "${OQ4_PREFIX}", exactly one is allowed`);
  return { values, problems };
}

// ---------------------------------------------------------------------------------------------
// The checks

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A hook or a worktree may export these; the command must look at `root` and nothing else.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

function runGit(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

/** Registered paths that are not committed as they are on disk: modified, staged, untracked or ignored. */
function dirtyPaths(root: string): { ok: true; dirty: string[] } | { ok: false; error: string } {
  const paths = [...STAGE_A_FILES];
  const tracked = runGit(root, ['ls-files', '-z', '--', ...paths]);
  if (!tracked.ok) return { ok: false, error: tracked.stderr.trim() || 'git ls-files failed' };
  const trackedSet = new Set(tracked.stdout.split('\0').filter((line) => line !== ''));
  const dirty = new Set<string>();
  for (const rel of paths) if (!trackedSet.has(rel)) dirty.add(`${rel} (not tracked by git)`);
  const status = runGit(root, ['status', '--porcelain', '--untracked-files=all', '-z', '--', ...paths]);
  if (!status.ok) return { ok: false, error: status.stderr.trim() || 'git status failed' };
  for (const entry of status.stdout.split('\0').filter((line) => line !== '')) {
    const rel = entry.slice(3);
    dirty.add(`${rel} (${entry.slice(0, 2).trim() || 'changed'})`);
  }
  return { ok: true, dirty: [...dirty].sort() };
}

interface QuestionFileShape {
  corpusSha?: unknown;
  questions?: unknown;
}

/** Disagreements between the document and the question and answer files it registers. */
function checkQuestionFiles(root: string, prereg: Prereg): string[] {
  const problems: string[] = [];
  let questions: QuestionFileShape;
  try {
    questions = JSON.parse(fs.readFileSync(path.join(root, ...QUESTIONS_PATH.split('/')), 'utf8')) as QuestionFileShape;
  } catch (error) {
    return [`questions: cannot read ${QUESTIONS_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!Array.isArray(questions.questions)) return [`questions: ${QUESTIONS_PATH} has no questions array`];
  const byCategory: Record<string, number> = {};
  for (const question of questions.questions as Array<{ category?: unknown }>) {
    const category = typeof question.category === 'string' ? question.category : '(none)';
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }
  if (questions.questions.length !== prereg.questionSet.count) {
    problems.push(`questions: the question file has ${String(questions.questions.length)}, the document registers ${String(prereg.questionSet.count)}`);
  }
  for (const category of new Set([...Object.keys(byCategory), ...Object.keys(prereg.questionSet.byCategory)])) {
    if ((byCategory[category] ?? 0) !== (prereg.questionSet.byCategory[category] ?? 0)) {
      problems.push(
        `questions: category ${category} has ${String(byCategory[category] ?? 0)} in the question file, ${String(prereg.questionSet.byCategory[category] ?? 0)} in the document`,
      );
    }
  }
  if (questions.corpusSha !== prereg.params.corpusSha) {
    problems.push(`corpusSha: the question file says ${String(questions.corpusSha)}, the document ${prereg.params.corpusSha}`);
  }
  try {
    const answers = JSON.parse(fs.readFileSync(path.join(root, ...ANSWERS_PATH.split('/')), 'utf8')) as { repoSha?: unknown };
    if (answers.repoSha !== prereg.params.corpusSha) {
      problems.push(`corpusSha: the answer file says ${String(answers.repoSha)}, the document ${prereg.params.corpusSha}`);
    }
  } catch (error) {
    problems.push(`answers: cannot read ${ANSWERS_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

function defaultTestCommand(root: string): TestCommand {
  const dir = path.join(root, 'scripts', 'eval');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `scripts/eval/${name}`);
  return { command: process.execPath, args: ['--test', ...files] };
}

function refuse(reason: RefusalReason, ...details: string[]): FreezeResult {
  return { ok: false, reason, details };
}

/**
 * Freezes the Draft pre-registration at `options.path`. Returns the refusal with its reason and the lines that
 * explain it, or `ok` after the document has been rewritten and `verifyPrereg` accepted it. On any refusal the
 * document is untouched.
 */
export function freezePrereg(options: FreezeOptions): FreezeResult {
  if (options.stage !== 'A') return refuse('stage_unsupported', 'only Stage A is frozen by this tool; Stage B is added by plan 03-33');
  const approvedBy = options.approvedBy.trim();
  if (approvedBy === '' || /[\r\n()]/.test(approvedBy)) {
    return refuse('invalid_reviewer', 'the reviewer name must be non-empty and contain no line break or parenthesis');
  }
  const file = path.resolve(options.root, options.path);
  let original: string;
  let prereg: Prereg;
  try {
    original = fs.readFileSync(file, 'utf8');
    prereg = readPrereg(file);
  } catch (error) {
    return refuse('invalid_document', error instanceof Error ? error.message : String(error));
  }
  if (prereg.status === 'Frozen' || /^Status:\s*Frozen\b/m.test(original)) return refuse('already_frozen', `${options.path} is already Frozen`);
  const statusLines = original.split(/\r?\n/).filter((line) => /^Status:/.test(line));
  if (prereg.stage !== 'A' || statusLines.length !== 1 || !/^Status:\s*Draft\s*$/.test(statusLines[0] as string)) {
    return refuse('invalid_document', 'expected a Stage A block and exactly one line "Status: Draft"');
  }

  const missing = STAGE_A_FILES.filter((rel) => {
    try {
      return !fs.statSync(path.join(options.root, ...rel.split('/'))).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) return refuse('missing_file', ...missing);

  const dirty = dirtyPaths(options.root);
  if (!dirty.ok) return refuse('git_unavailable', dirty.error);
  if (dirty.dirty.length > 0) return refuse('dirty_registered_file', ...dirty.dirty);

  const mismatches = [...checkParams(prereg, options.approved), ...checkQuestionFiles(options.root, prereg)];
  if (mismatches.length > 0) return refuse('parameter_mismatch', ...mismatches);

  const oq4 = oq4Confirmation(original);
  const registered = prereg.params.citationJudgedOn;
  if (oq4.problems.length > 0) return refuse('citation_criterion_unconfirmed', ...oq4.problems);
  if (oq4.values[0] !== registered) {
    return refuse(
      'citation_criterion_unconfirmed',
      `the Approvals line names ${String(oq4.values[0])} but params.citationJudgedOn is ${registered}`,
    );
  }

  const tests = options.testCommand ?? defaultTestCommand(options.root);
  const ran = spawnSync(tests.command, [...tests.args], { cwd: options.root, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  if (ran.error !== undefined || ran.status !== 0) {
    const tail = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim().split(/\r?\n/).slice(-15);
    return refuse('tests_failed', `exit ${String(ran.error?.message ?? ran.status ?? ran.signal)}`, ...tail);
  }

  const files: Record<string, string> = {};
  for (const rel of STAGE_A_FILES) files[rel] = hashFile(path.join(options.root, ...rel.split('/')));
  const status = `Frozen (Stage A, ${options.now.toISOString().slice(0, 10)}, by ${approvedBy})`;
  let next: string;
  try {
    next = replacePreregBlock(original, { ...prereg, status: 'Frozen', files });
  } catch (error) {
    return refuse('invalid_document', error instanceof Error ? error.message : String(error));
  }
  next = next.replace(/^Status:[ \t]*Draft[ \t]*$/m, () => `Status: ${status}`);

  // Write beside the target and rename, so a crash leaves either the Draft or the Frozen document, never half of one.
  const temp = `${file}.freeze-tmp`;
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, file);
  const verified = verifyPrereg(file, options.root);
  if (!verified.ok) {
    fs.writeFileSync(file, original);
    return refuse('verification_failed', ...verified.problems);
  }
  return { ok: true, status, files };
}

// ---------------------------------------------------------------------------------------------
// Command

export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** What a test may replace in the command. */
export interface CliDeps {
  readonly approved?: ApprovedConstants;
  readonly testCommand?: TestCommand;
  readonly now?: Date;
}

const USAGE = 'usage: node scripts/eval/freeze-prereg.ts --stage A --by <name> [--prereg <path>] [--constants <path>]\n';

/** The command body. Returns the exit code. */
export function runCli(argv: string[], io: Io, root: string, deps: CliDeps = {}): number {
  let values: { stage?: string | undefined; by?: string | undefined; prereg?: string | undefined; constants?: string | undefined };
  try {
    values = parseArgs({
      args: argv,
      options: { stage: { type: 'string' }, by: { type: 'string' }, prereg: { type: 'string' }, constants: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`freeze-prereg: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.stage !== 'A' && values.stage !== 'B') {
    io.err(`freeze-prereg: --stage must be A (Stage B belongs to plan 03-33)\n${USAGE}`);
    return 2;
  }
  if (values.by === undefined || values.by.trim() === '') {
    io.err(`freeze-prereg: --by <name> is required: the freeze records who approved it\n${USAGE}`);
    return 2;
  }
  let approved: ApprovedConstants;
  try {
    approved = deps.approved ?? readApprovedConstants(path.resolve(root, values.constants ?? APPROVED_CONSTANTS_PATH));
  } catch (error) {
    io.err(`freeze-prereg: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const result = freezePrereg({
    root,
    path: values.prereg ?? DEFAULT_PREREG_PATH,
    stage: values.stage,
    approvedBy: values.by,
    now: deps.now ?? new Date(),
    approved,
    ...(deps.testCommand === undefined ? {} : { testCommand: deps.testCommand }),
  });
  if (!result.ok) {
    io.err(`freeze-prereg: refused: ${result.reason}\n`);
    for (const line of result.details) io.err(`  ${line}\n`);
    return 1;
  }
  io.out(`freeze-prereg: ${result.status}\n`);
  io.out(`freeze-prereg: registered ${String(Object.keys(result.files).length)} files\n`);
  return 0;
}

/** The repository root, two levels above scripts/eval. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    REPO_ROOT,
  );
}
