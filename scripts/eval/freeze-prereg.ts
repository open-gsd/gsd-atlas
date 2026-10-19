/**
 * node scripts/eval/freeze-prereg.ts --stage A --by <name> [--prereg <path>] [--constants <path>]
 * node scripts/eval/freeze-prereg.ts --stage B --by <name> [--prereg <path>]
 * node scripts/eval/freeze-prereg.ts --reopen --revision <n> --by <name> --reason <text> [--prereg <path>]
 *
 * Plan 03-38 adds the safe supersession of a frozen Stage A record (`reopenPrereg`, then `--stage A` in revision mode);
 * their refusals are documented at `reopenPrereg` and `freezeRevision` below.
 *
 * The mechanical half of the freeze (D-01, D-04, D-08, EVL-02). Given a Draft pre-registration it checks everything
 * a person must have settled, computes the sha256 of the sixteen Stage A files (CRLF read as LF), writes them into
 * the single `prereg-json` block, sets `Status: Frozen (Stage A, <date>, by <name>)` and runs `verifyPrereg` on the
 * result. It writes nothing unless every check passed, and it never writes a hash it did not just compute.
 *
 * Stage B (plan 03-33, D-09, D-23) adds the two things Stage A could not know: the sha256 of the skill file
 * (`skills/gsd-atlas/SKILL.md`, CRLF read as LF) and the atlas commit, which is the full id of HEAD. It changes the
 * block's `stage` to B, adds `stageB`, and writes `Status: Frozen (Stage B, <date>, by <name>)` on a new line below
 * the Stage A status line, which stays. Nothing else in the document or in a registered file changes. Its refusals:
 * - `stage_a_not_frozen`: the document is not a Frozen Stage A one, or `verifyPrereg` finds a problem with it (a
 *   registered file changed since Stage A, a hash missing).
 * - `already_frozen_b`: the document already holds a Stage B record. A change after Stage B is a new registered run.
 * - `skill_missing` / `skill_dirty`: the skill file is absent, or is modified, staged, untracked or ignored (the hash
 *   must be of committed bytes).
 * - `tree_dirty`: any other file is modified or untracked (apart from `node_modules`), because the atlas commit has to
 *   be the commit that was built and that will run.
 * - `build_failed`: `tsc -p tsconfig.build.json` exited non-zero, so the package does not build from this commit.
 *
 * Stage A refusals, each leaving the document byte for byte as it was:
 * - `dirty_registered_file`: a Stage A file is modified, untracked or ignored (the hashes must be of committed bytes).
 * - `missing_file`: a Stage A path does not exist.
 * - `parameter_mismatch`: a registered parameter differs from the approved constants (03-CONSTANTS.md), or the
 *   document's question set, corpus sha or question count differs from the question file.
 * - `citation_criterion_unconfirmed`: the Approvals section does not hold exactly one line
 *   `OQ4 confirmed by the user: point_estimate|wilson_lower_bound`, equal to `params.citationJudgedOn`. A Draft value
 *   of `citationJudgedOn` alone never satisfies the check (OQ4 has no default).
 * - `tests_failed`: the eval test command exited non-zero.
 * - `already_frozen`, `invalid_document`, `invalid_reviewer`, `git_unavailable`,
 *   `verification_failed`: the document or the call is not one this tool can freeze.
 *
 * Exit codes of the command: 0 frozen, 1 refused, 2 usage error.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PREREG_PATH, hashBytes, hashFile, readPrereg, replacePreregBlock, SKILL_PATH, STAGE_A_FILES } from './prereg.ts';
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
  /** The approved constants Stage A compares the registered parameters with; Stage B does not read them. */
  readonly approved?: ApprovedConstants;
  /** The eval test command; default `node --test` over every `scripts/eval/*.test.ts`. */
  readonly testCommand?: TestCommand;
  /** Stage B: the command that builds the package; default `tsc -p tsconfig.build.json` of the repository's own TypeScript. */
  readonly buildCommand?: TestCommand;
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
  | 'git_unavailable'
  | 'verification_failed'
  | 'stage_a_not_frozen'
  | 'already_frozen_b'
  | 'skill_missing'
  | 'skill_dirty'
  | 'tree_dirty'
  | 'build_failed'
  | 'reopen_not_frozen_a'
  | 'reopen_stage_b_recorded'
  | 'reopen_results_present'
  | 'reopen_tree_dirty'
  | 'reopen_already_open'
  | 'reopen_record_unverified'
  | 'revision_oq4_unconfirmed'
  | 'revision_params_changed'
  | 'revision_immutable_file_changed'
  | 'revision_changes_undeclared'
  | 'revision_text_rewritten'
  | 'revision_sections_missing';

export type FreezeResult =
  | {
      readonly ok: true;
      readonly status: string;
      readonly files: Readonly<Record<string, string>>;
      /** Stage B only: what was recorded. */
      readonly stageB?: { readonly skillSha256: string; readonly atlasCommit: string };
    }
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

/** Of `paths`, those that are not committed as they are on disk: modified, staged, untracked or ignored. */
function dirtyPaths(root: string, paths: readonly string[] = STAGE_A_FILES): { ok: true; dirty: string[] } | { ok: false; error: string } {
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
  if (options.stage === 'B') return freezeStageB(options);
  const approved = options.approved;
  if (approved === undefined) return refuse('parameter_mismatch', 'Stage A compares the registered parameters with the approved constants, and none were given');
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
  // A Draft that a reopen left (plan 03-38) is frozen as a revision: more checks, a different status line.
  if (prereg.revision !== undefined && prereg.status === 'Draft') return freezeRevision(options, approved, approvedBy, file, original, prereg);
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

  const mismatches = [...checkParams(prereg, approved), ...checkQuestionFiles(options.root, prereg)];
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
// Stage B

/** Untracked or modified paths of the whole tree, except `node_modules` (a worktree links it to the main checkout). */
function dirtyTree(root: string): { ok: true; dirty: string[] } | { ok: false; error: string } {
  const status = runGit(root, ['status', '--porcelain', '--untracked-files=all', '-z']);
  if (!status.ok) return { ok: false, error: status.stderr.trim() || 'git status failed' };
  const dirty = status.stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => ({ code: entry.slice(0, 2).trim() || 'changed', rel: entry.slice(3) }))
    .filter(({ rel }) => rel !== 'node_modules' && !rel.startsWith('node_modules/'))
    .map(({ code, rel }) => `${rel} (${code})`);
  return { ok: true, dirty: dirty.sort() };
}

/** The repository's own `tsc -p tsconfig.build.json`, run through `node` (never a shell or an npm shim). */
function defaultBuildCommand(root: string): TestCommand {
  return { command: process.execPath, args: [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'] };
}

const STAGE_A_STATUS_LINE = /^Status:[ \t]*Frozen \(Stage A,[^\n]*$/m;

/**
 * Records Stage B (D-09, D-23): the skill's hash and the atlas commit. See the header for the refusals. The document is
 * written only after every check and the build passed, and `verifyPrereg` has the last word.
 */
function freezeStageB(options: FreezeOptions): FreezeResult {
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
  if (prereg.stage === 'B' || prereg.stageB !== undefined || /^Status:.*\(Stage B,/m.test(original)) {
    return refuse('already_frozen_b', `${options.path} already holds a Stage B record; a change after it is a new registered run`);
  }
  const statusLines = original.split(/\r?\n/).filter((line) => /^Status:/.test(line));
  if (prereg.status !== 'Frozen' || statusLines.length !== 1 || !STAGE_A_STATUS_LINE.test(statusLines[0] as string)) {
    return refuse('stage_a_not_frozen', 'expected a Frozen Stage A block and exactly one line "Status: Frozen (Stage A, <date>, by <name>)"');
  }
  const verified = verifyPrereg(file, options.root);
  if (!verified.ok) return refuse('stage_a_not_frozen', 'Stage A does not verify:', ...verified.problems);

  const skill = path.join(options.root, ...SKILL_PATH.split('/'));
  let skillIsFile = false;
  try {
    skillIsFile = fs.statSync(skill).isFile();
  } catch {
    skillIsFile = false;
  }
  if (!skillIsFile) return refuse('skill_missing', SKILL_PATH);
  const skillDirty = dirtyPaths(options.root, [SKILL_PATH]);
  if (!skillDirty.ok) return refuse('git_unavailable', skillDirty.error);
  if (skillDirty.dirty.length > 0) return refuse('skill_dirty', ...skillDirty.dirty);
  const registeredDirty = dirtyPaths(options.root);
  if (!registeredDirty.ok) return refuse('git_unavailable', registeredDirty.error);
  if (registeredDirty.dirty.length > 0) return refuse('dirty_registered_file', ...registeredDirty.dirty);
  const tree = dirtyTree(options.root);
  if (!tree.ok) return refuse('git_unavailable', tree.error);
  if (tree.dirty.length > 0) return refuse('tree_dirty', ...tree.dirty);

  const head = runGit(options.root, ['rev-parse', 'HEAD']);
  const atlasCommit = head.stdout.trim();
  if (!head.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(atlasCommit)) {
    return refuse('git_unavailable', head.stderr.trim() || 'git rev-parse HEAD did not print a commit id');
  }

  const build = options.buildCommand ?? defaultBuildCommand(options.root);
  const built = spawnSync(build.command, [...build.args], { cwd: options.root, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  if (built.error !== undefined || built.status !== 0) {
    const tail = `${built.stdout ?? ''}${built.stderr ?? ''}`.trim().split(/\r?\n/).slice(-15);
    return refuse('build_failed', `exit ${String(built.error?.message ?? built.status ?? built.signal)}`, ...tail);
  }
  // The build must not have changed what is committed; a build that writes a tracked file would break "this commit".
  const afterBuild = dirtyTree(options.root);
  if (!afterBuild.ok) return refuse('git_unavailable', afterBuild.error);
  if (afterBuild.dirty.length > 0) return refuse('tree_dirty', 'the build changed the tree:', ...afterBuild.dirty);

  const skillSha256 = hashFile(skill);
  const status = `Frozen (Stage B, ${options.now.toISOString().slice(0, 10)}, by ${approvedBy})`;
  let next: string;
  try {
    next = replacePreregBlock(original, { ...prereg, stage: 'B', stageB: { skillSha256, atlasCommit } });
  } catch (error) {
    return refuse('invalid_document', error instanceof Error ? error.message : String(error));
  }
  // The Stage A line stays; the Stage B line goes on a line of its own directly below it, in the file's line ending.
  next = next.replace(/^(Status:[ \t]*Frozen \(Stage A,[^\r\n]*)(\r?\n)/m, (_whole, line: string, eol: string) => `${line}${eol}Status: ${status}${eol}`);

  const temp = `${file}.freeze-tmp`;
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, file);
  const recheck = verifyPrereg(file, options.root);
  if (!recheck.ok) {
    fs.writeFileSync(file, original);
    return refuse('verification_failed', ...recheck.problems);
  }
  return { ok: true, status, files: prereg.files, stageB: { skillSha256, atlasCommit } };
}

// ---------------------------------------------------------------------------------------------
// Reopen and revision (plan 03-38)

/**
 * The files a revision of a frozen Stage A record may change (D-04, D-08): the four that carry the run
 * configuration. The questions, the keys, the oracle, the scorer, the statistics, the analysis, the row schema and the
 * answer schema are immutable across a revision.
 */
export const RUN_CONFIGURATION_FILES: readonly string[] = [
  'scripts/eval/arms.ts',
  'scripts/eval/claude-session.ts',
  'scripts/eval/harness.ts',
  'scripts/eval/prereg.ts',
];

/** What a reopen writes under a Revision heading that a person still has to write. Revision mode refuses it. */
export const REVISION_PLACEHOLDER = '(not written yet)';

/** A results file means a scored session has run: the record can no longer be reopened. */
const SCORED_RESULTS_PATH = 'docs/eval/results/results.jsonl';

const OQ4_ORIGINAL_PREFIX = OQ4_PREFIX;

const oq4RevisionPrefix = (revision: number): string => `OQ4 re-confirmed by the user at Revision ${String(revision)}:`;

/** The sub-headings of a `## Revision N (<date>)` section, in order. */
function revisionHeadings(revision: number): string[] {
  return ['What changed', 'Why', 'What did not change', 'No scored data', 'Superseded records', `Approvals (Revision ${String(revision)})`];
}

const posixRelative = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

/** Bytes of a git object (a blob at a commit), unlike `runGit`, which decodes text. */
function gitBlob(root: string, commit: string, rel: string): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  const result = spawnSync('git', ['show', `${commit}:${rel}`], { cwd: root, env: cleanGitEnv(), windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, error: result.error?.message ?? result.stderr.toString('utf8').trim() };
  }
  return { ok: true, bytes: result.stdout };
}

export interface ReopenOptions {
  readonly root: string;
  readonly path: string;
  /** The revision to open: 1 for the first. It must be the record's current revision plus one. */
  readonly revision: number;
  readonly approvedBy: string;
  /** One line: why the record is reopened. */
  readonly reason: string;
  readonly now: Date;
}

/** The text of the appended section: the headings with placeholders, the table of the superseded record. */
function revisionSection(revision: number, date: string, by: string, reason: string, entry: NonNullable<Prereg['supersedes']>[number]): string {
  const headings = revisionHeadings(revision);
  const table = [
    '| Record | Value |',
    '| --- | --- |',
    `| Superseded status line | \`${entry.status}\` |`,
    `| Superseded at commit | \`${entry.frozenAtCommit}\` |`,
    ...Object.keys(entry.files).map((rel) => `| \`${rel}\` | \`${entry.files[rel] as string}\` |`),
  ];
  const parts: string[] = [`## Revision ${String(revision)} (${date})`, '', `Opened on ${date} by ${by}. Reason: ${reason}`, ''];
  for (const heading of headings) {
    parts.push(`### ${heading}`, '');
    if (heading === 'Superseded records') parts.push(...table, '');
    else if (!heading.startsWith('Approvals')) parts.push(REVISION_PLACEHOLDER, '');
  }
  return `${parts.join('\n')}\n`.replace(/\n+$/, '\n');
}

/**
 * Reopens a Frozen Stage A record as a CI-safe Draft (plan 03-38). The old record is verified against the git blobs
 * at the commit that froze it, then kept inside the block's `supersedes` chain and in a `Superseded records` table of
 * an appended `## Revision N (<date>)` section; the status line becomes `Status: Draft` and the block loses its
 * hashes. Nothing else in the document changes. Refusals (the document is left byte for byte as it was):
 * - `reopen_not_frozen_a`: no document, a Draft, or a document that is not a Frozen Stage A record.
 * - `reopen_stage_b_recorded`: a Stage B record exists; a change after it is a new registered run.
 * - `reopen_results_present`: `docs/eval/results/results.jsonl` exists, so scored data may exist.
 * - `reopen_tree_dirty`: any file is modified or untracked (apart from `node_modules`).
 * - `reopen_already_open`: a revision is already open, or `revision` is not the record's next revision number.
 * - `reopen_record_unverified`: no commit holds the document, or a recorded hash is not that of the blob at it.
 */
export function reopenPrereg(options: ReopenOptions): FreezeResult {
  const approvedBy = options.approvedBy.trim();
  if (approvedBy === '' || /[\r\n()]/.test(approvedBy)) {
    return refuse('invalid_reviewer', 'the reviewer name must be non-empty and contain no line break or parenthesis');
  }
  const reason = options.reason.trim();
  if (reason === '' || /[\r\n]/.test(reason)) return refuse('invalid_document', 'the reason must be one non-empty line');
  const file = path.resolve(options.root, options.path);
  if (!fs.existsSync(file)) return refuse('reopen_not_frozen_a', `${options.path} does not exist`);
  let original: string;
  let prereg: Prereg;
  try {
    original = fs.readFileSync(file, 'utf8');
    prereg = readPrereg(file);
  } catch (error) {
    return refuse('invalid_document', error instanceof Error ? error.message : String(error));
  }
  const statusLines = original.split(/\r?\n/).filter((line) => /^Status:/.test(line));
  if (prereg.stage === 'B' || prereg.stageB !== undefined || statusLines.some((line) => /\(Stage B,/.test(line))) {
    return refuse('reopen_stage_b_recorded', `${options.path} holds a Stage B record; a change after it is a new registered run`);
  }
  if (prereg.status === 'Draft') {
    return prereg.revision !== undefined
      ? refuse('reopen_already_open', `revision ${String(prereg.revision)} is already open in ${options.path}`)
      : refuse('reopen_not_frozen_a', `${options.path} is a Draft; there is no frozen record to reopen`);
  }
  if (statusLines.length !== 1 || !STAGE_A_STATUS_LINE.test(statusLines[0] as string)) {
    return refuse('reopen_not_frozen_a', 'expected a Frozen Stage A block and exactly one line "Status: Frozen (Stage A, <date>, by <name>)"');
  }
  const next = (prereg.revision ?? 0) + 1;
  if (options.revision !== next) {
    return refuse('reopen_already_open', `the next revision of ${options.path} is ${String(next)}, not ${String(options.revision)}`);
  }
  if (fs.existsSync(path.join(options.root, ...SCORED_RESULTS_PATH.split('/')))) {
    return refuse('reopen_results_present', `${SCORED_RESULTS_PATH} exists: a scored session may have run`);
  }
  const tree = dirtyTree(options.root);
  if (!tree.ok) return refuse('git_unavailable', tree.error);
  if (tree.dirty.length > 0) return refuse('reopen_tree_dirty', ...tree.dirty);

  // The old record, checked against history and not against the text that is about to be replaced.
  const rel = posixRelative(options.root, file);
  const log = runGit(options.root, ['log', '-1', '--format=%H', '--', rel]);
  const frozenAtCommit = log.stdout.trim();
  if (!log.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(frozenAtCommit)) {
    return refuse('reopen_record_unverified', `no commit holds ${rel}, so the commit that froze the record cannot be found`);
  }
  const problems: string[] = [];
  // The commit has to hold the document itself: a commit that removed it froze nothing.
  const atCommit = gitBlob(options.root, frozenAtCommit, rel);
  if (!atCommit.ok) return refuse('reopen_record_unverified', `${rel} is not in commit ${frozenAtCommit.slice(0, 12)}, the last commit that touched it`);
  const blobHashes: Record<string, string> = {};
  for (const registered of Object.keys(prereg.files)) {
    const blob = gitBlob(options.root, frozenAtCommit, registered);
    if (!blob.ok) {
      problems.push(`${registered}: not in commit ${frozenAtCommit.slice(0, 12)} (${blob.error})`);
      continue;
    }
    blobHashes[registered] = hashBytes(blob.bytes);
    if (blobHashes[registered] !== prereg.files[registered]) {
      problems.push(`${registered}: recorded ${(prereg.files[registered] as string).slice(0, 12)}, the blob at ${frozenAtCommit.slice(0, 12)} is ${blobHashes[registered].slice(0, 12)}`);
    }
  }
  for (const registered of STAGE_A_FILES) if (prereg.files[registered] === undefined) problems.push(`${registered}: the record has no hash for it`);
  if (problems.length > 0) return refuse('reopen_record_unverified', ...problems);

  const entry: NonNullable<Prereg['supersedes']>[number] = {
    revision: next - 1,
    status: statusLines[0] as string,
    frozenAtCommit,
    params: prereg.params,
    files: blobHashes,
    questionSet: prereg.questionSet,
  };
  const date = options.now.toISOString().slice(0, 10);
  let text: string;
  try {
    text = replacePreregBlock(original, { ...prereg, status: 'Draft', revision: next, files: {}, supersedes: [...(prereg.supersedes ?? []), entry] });
  } catch (error) {
    return refuse('invalid_document', error instanceof Error ? error.message : String(error));
  }
  text = text.replace(/^Status:[^\r\n]*/m, () => 'Status: Draft');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const section = revisionSection(next, date, approvedBy, reason, entry).replace(/\n/g, eol);
  text = `${text}${text.endsWith('\n') ? '' : eol}${eol}${section}`;

  const temp = `${file}.freeze-tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
  const verified = verifyPrereg(file, options.root, { draft: true });
  if (!verified.ok) {
    fs.writeFileSync(file, original);
    return refuse('verification_failed', ...verified.problems);
  }
  return { ok: true, status: 'Draft', files: {} };
}

interface RevisionSections {
  readonly problems: string[];
  /** The body lines of each sub-heading of the section. */
  readonly bodies: Map<string, string[]>;
  /** Every line of the section. */
  readonly lines: string[];
}

/** Splits the `## Revision N (...)` section into its sub-sections; reports a missing or doubled heading and an empty body. */
function readRevisionSections(text: string, revision: number): RevisionSections {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => (line.startsWith(`## Revision ${String(revision)} (`) ? [index] : []));
  if (starts.length !== 1) {
    problems.push(`expected exactly one "## Revision ${String(revision)} (<date>)" section, found ${String(starts.length)}`);
    return { problems, bodies: new Map(), lines: [] };
  }
  let end = lines.length;
  for (let i = (starts[0] as number) + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const section = lines.slice(starts[0] as number, end);
  const bodies = new Map<string, string[]>();
  let current: string[] | null = null;
  const seen = new Map<string, number>();
  for (const line of section) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const title = heading[1] as string;
      seen.set(title, (seen.get(title) ?? 0) + 1);
      current = [];
      bodies.set(title, current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  for (const title of revisionHeadings(revision)) {
    const count = seen.get(title) ?? 0;
    if (count !== 1) {
      problems.push(`the heading "### ${title}" is ${count === 0 ? 'missing' : 'repeated'} in the Revision ${String(revision)} section`);
      continue;
    }
    if (title.startsWith('Approvals')) continue;
    const body = (bodies.get(title) as string[]).join('\n').trim();
    if (body === '') problems.push(`"### ${title}" is empty`);
    else if (body === REVISION_PLACEHOLDER) problems.push(`"### ${title}" still holds the placeholder ${REVISION_PLACEHOLDER}`);
  }
  return { problems, bodies, lines: section };
}

/** The same text with the status line and the block's content neutralised, so only the prose is compared. */
function proseOf(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^Status:[^\n]*$/m, 'Status: <status>')
    .replace(/^(```prereg-json[ \t]*\n)[\s\S]*?(^```[ \t]*$)/m, '$1<block>\n$2');
}

/** The files named on the line `Changed registered files: <path>, <path>`; null when the line is absent or repeated. */
function declaredChanges(lines: readonly string[]): { paths: string[] } | { problem: string } {
  const prefix = 'Changed registered files:';
  const found = lines.filter((line) => line.startsWith(prefix));
  if (found.length !== 1) return { problem: `expected exactly one line "${prefix} <path>, <path>", found ${String(found.length)}` };
  const paths = (found[0] as string)
    .slice(prefix.length)
    .split(',')
    .map((part) => part.trim().replace(/^`|`$/g, '').replace(/\.$/, '').trim())
    .filter((part) => part !== '');
  return { paths };
}

/**
 * Freezes the Draft that a reopen left, as a revision of the superseded record (plan 03-38). On top of every Stage A
 * refusal (dirty or missing registered files, the approved constants, the tests) it refuses, leaving the document
 * unchanged:
 * - `revision_params_changed`: the parameters or the question set differ from the superseded record.
 * - `revision_immutable_file_changed`: a registered file other than the four run-configuration files differs from the
 *   superseded record.
 * - `revision_sections_missing`: the Revision section lacks a heading or one of its sections is empty or still the
 *   placeholder.
 * - `revision_changes_undeclared`: the files named on the `Changed registered files:` line are not exactly the files
 *   whose hash changed.
 * - `revision_text_rewritten`: the document, apart from the status line, the block and the appended section, is not
 *   the document at the commit that froze the superseded record.
 * - `revision_oq4_unconfirmed`: the Approvals of the revision do not hold exactly one line
 *   `OQ4 re-confirmed by the user at Revision N: <value>` equal to `params.citationJudgedOn`.
 */
function freezeRevision(
  options: FreezeOptions,
  approved: ApprovedConstants,
  approvedBy: string,
  file: string,
  original: string,
  prereg: Prereg,
): FreezeResult {
  const revision = prereg.revision as number;
  const superseded = prereg.supersedes?.[revision - 1];
  if (superseded === undefined) return refuse('invalid_document', 'a revision needs its superseded record');
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

  // The parameters and the question set are exactly the superseded record's.
  const paramProblems: string[] = [];
  const same = (name: string, now: unknown, was: unknown): void => {
    if (JSON.stringify(now) !== JSON.stringify(was)) paramProblems.push(`${name}: now ${JSON.stringify(now)}, superseded ${JSON.stringify(was)}`);
  };
  for (const key of Object.keys(superseded.params) as Array<keyof Prereg['params']>) same(`params.${key}`, prereg.params[key], superseded.params[key]);
  for (const key of Object.keys(prereg.params)) if (!(key in superseded.params)) paramProblems.push(`params.${key}: not in the superseded record`);
  same('questionSet', prereg.questionSet, superseded.questionSet);
  if (paramProblems.length > 0) return refuse('revision_params_changed', ...paramProblems);
  const mismatches = [...checkParams(prereg, approved), ...checkQuestionFiles(options.root, prereg)];
  if (mismatches.length > 0) return refuse('parameter_mismatch', ...mismatches);

  // Only the run configuration may differ from the superseded hashes.
  const files: Record<string, string> = {};
  for (const rel of STAGE_A_FILES) files[rel] = hashFile(path.join(options.root, ...rel.split('/')));
  const immutable = STAGE_A_FILES.filter((rel) => !RUN_CONFIGURATION_FILES.includes(rel) && files[rel] !== superseded.files[rel]);
  if (immutable.length > 0) {
    return refuse('revision_immutable_file_changed', ...immutable.map((rel) => `${rel}: superseded ${String(superseded.files[rel]).slice(0, 12)}, now ${(files[rel] as string).slice(0, 12)}; a revision may change only ${RUN_CONFIGURATION_FILES.join(', ')}`));
  }

  const sections = readRevisionSections(original, revision);
  if (sections.problems.length > 0) return refuse('revision_sections_missing', ...sections.problems);

  const changed = RUN_CONFIGURATION_FILES.filter((rel) => files[rel] !== superseded.files[rel]);
  const declared = declaredChanges(sections.lines);
  if ('problem' in declared) return refuse('revision_changes_undeclared', declared.problem);
  const undeclared = changed.filter((rel) => !declared.paths.includes(rel)).map((rel) => `${rel} changed and is not named`);
  const unchanged = declared.paths.filter((rel) => !changed.includes(rel)).map((rel) => `${rel} is named and did not change (or is not a run-configuration file)`);
  if (undeclared.length + unchanged.length > 0) return refuse('revision_changes_undeclared', ...undeclared, ...unchanged);

  // The text of the earlier registration is intact: the document is the one at the freezing commit, plus the appended section.
  const rel = posixRelative(options.root, file);
  const base = gitBlob(options.root, superseded.frozenAtCommit, rel);
  if (!base.ok) return refuse('git_unavailable', `cannot read ${rel} at the commit ${superseded.frozenAtCommit.slice(0, 12)} that froze the superseded record: ${base.error}`);
  const wasText = proseOf(base.bytes.toString('utf8'));
  const nowText = proseOf(original);
  if (!nowText.startsWith(wasText)) {
    const at = [...wasText].findIndex((ch, i) => nowText[i] !== ch);
    const line = wasText.slice(0, Math.max(at, 0)).split('\n').length;
    return refuse('revision_text_rewritten', `the text differs from the document at ${superseded.frozenAtCommit.slice(0, 12)} near line ${String(line)}; Revision ${String(revision)} is appended, the earlier text is not rewritten`);
  }

  // The user's explicit re-confirmation, in the Approvals of the revision, and nowhere else.
  const approvalHeading = `Approvals (Revision ${String(revision)})`;
  const approvalLines = sections.bodies.get(approvalHeading) ?? [];
  const prefix = oq4RevisionPrefix(revision);
  const oq4Problems: string[] = [];
  const confirmed = approvalLines.filter((line) => line.startsWith(prefix));
  const elsewhere = sections.lines.filter((line) => line.startsWith(prefix)).length - confirmed.length;
  if (confirmed.length !== 1) oq4Problems.push(`expected exactly one line "${prefix} <value>" under "### ${approvalHeading}", found ${String(confirmed.length)}`);
  if (elsewhere > 0) oq4Problems.push(`${String(elsewhere)} "${prefix}" line(s) outside "### ${approvalHeading}"`);
  const value = (confirmed[0] ?? '').slice(prefix.length).trim();
  if (confirmed.length === 1 && !OQ4_VALUES.includes(value)) oq4Problems.push(`"${prefix}" names neither point_estimate nor wilson_lower_bound: "${value}"`);
  if (confirmed.length === 1 && OQ4_VALUES.includes(value) && value !== prereg.params.citationJudgedOn) {
    oq4Problems.push(`the Revision line names ${value} but params.citationJudgedOn is ${prereg.params.citationJudgedOn}`);
  }
  if (approvalLines.some((line) => line.startsWith(OQ4_ORIGINAL_PREFIX))) {
    oq4Problems.push(`a line "${OQ4_ORIGINAL_PREFIX}" under "### ${approvalHeading}" is not the Revision ${String(revision)} confirmation`);
  }
  oq4Problems.push(...oq4Confirmation(original).problems);
  if (oq4Problems.length > 0) return refuse('revision_oq4_unconfirmed', ...oq4Problems);

  const tests = options.testCommand ?? defaultTestCommand(options.root);
  const ran = spawnSync(tests.command, [...tests.args], { cwd: options.root, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  if (ran.error !== undefined || ran.status !== 0) {
    const tail = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim().split(/\r?\n/).slice(-15);
    return refuse('tests_failed', `exit ${String(ran.error?.message ?? ran.status ?? ran.signal)}`, ...tail);
  }

  const status = `Frozen (Stage A, revision ${String(revision)}, ${options.now.toISOString().slice(0, 10)}, by ${approvedBy})`;
  let next: string;
  try {
    next = replacePreregBlock(original, { ...prereg, status: 'Frozen', files });
  } catch (error) {
    return refuse('invalid_document', error instanceof Error ? error.message : String(error));
  }
  next = next.replace(/^Status:[ \t]*Draft[ \t]*$/m, () => `Status: ${status}`);

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
  readonly buildCommand?: TestCommand;
  readonly now?: Date;
}

const USAGE =
  'usage: node scripts/eval/freeze-prereg.ts --stage A --by <name> [--prereg <path>] [--constants <path>]\n' +
  '       node scripts/eval/freeze-prereg.ts --stage B --by <name> [--prereg <path>]\n' +
  '       node scripts/eval/freeze-prereg.ts --reopen --revision <n> --by <name> --reason <text> [--prereg <path>]\n';

/** The command body. Returns the exit code. */
export function runCli(argv: string[], io: Io, root: string, deps: CliDeps = {}): number {
  let values: {
    stage?: string | undefined;
    by?: string | undefined;
    prereg?: string | undefined;
    constants?: string | undefined;
    reopen?: boolean | undefined;
    revision?: string | undefined;
    reason?: string | undefined;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        stage: { type: 'string' },
        by: { type: 'string' },
        prereg: { type: 'string' },
        constants: { type: 'string' },
        reopen: { type: 'boolean' },
        revision: { type: 'string' },
        reason: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`freeze-prereg: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.reopen === true) {
    const revision = Number(values.revision);
    if (values.stage !== undefined || values.constants !== undefined) {
      io.err(`freeze-prereg: --reopen takes no --stage and no --constants\n${USAGE}`);
      return 2;
    }
    if (values.revision === undefined || !Number.isInteger(revision) || revision < 1) {
      io.err(`freeze-prereg: --reopen needs --revision <n>, a whole number of at least 1\n${USAGE}`);
      return 2;
    }
    if (values.by === undefined || values.by.trim() === '' || values.reason === undefined || values.reason.trim() === '') {
      io.err(`freeze-prereg: --reopen needs --by <name> and --reason <text>\n${USAGE}`);
      return 2;
    }
    const reopened = reopenPrereg({
      root,
      path: values.prereg ?? DEFAULT_PREREG_PATH,
      revision,
      approvedBy: values.by,
      reason: values.reason,
      now: deps.now ?? new Date(),
    });
    if (!reopened.ok) {
      io.err(`freeze-prereg: refused: ${reopened.reason}\n`);
      for (const line of reopened.details) io.err(`  ${line}\n`);
      return 1;
    }
    io.out(`freeze-prereg: reopened as ${reopened.status}, revision ${String(revision)}; the superseded record is kept in the block and in the Revision ${String(revision)} section\n`);
    return 0;
  }
  if (values.revision !== undefined || values.reason !== undefined) {
    io.err(`freeze-prereg: --revision and --reason belong to --reopen\n${USAGE}`);
    return 2;
  }
  if (values.stage !== 'A' && values.stage !== 'B') {
    io.err(`freeze-prereg: --stage must be A or B\n${USAGE}`);
    return 2;
  }
  if (values.by === undefined || values.by.trim() === '') {
    io.err(`freeze-prereg: --by <name> is required: the freeze records who approved it\n${USAGE}`);
    return 2;
  }
  // Stage B compares nothing with the constants, so a missing constants file must not stop it.
  let approved: ApprovedConstants | undefined;
  if (values.stage === 'A') {
    try {
      approved = deps.approved ?? readApprovedConstants(path.resolve(root, values.constants ?? APPROVED_CONSTANTS_PATH));
    } catch (error) {
      io.err(`freeze-prereg: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  const result = freezePrereg({
    root,
    path: values.prereg ?? DEFAULT_PREREG_PATH,
    stage: values.stage,
    approvedBy: values.by,
    now: deps.now ?? new Date(),
    ...(approved === undefined ? {} : { approved }),
    ...(deps.testCommand === undefined ? {} : { testCommand: deps.testCommand }),
    ...(deps.buildCommand === undefined ? {} : { buildCommand: deps.buildCommand }),
  });
  if (!result.ok) {
    io.err(`freeze-prereg: refused: ${result.reason}\n`);
    for (const line of result.details) io.err(`  ${line}\n`);
    return 1;
  }
  io.out(`freeze-prereg: ${result.status}\n`);
  if (result.stageB === undefined) {
    io.out(`freeze-prereg: registered ${String(Object.keys(result.files).length)} files\n`);
  } else {
    io.out(`freeze-prereg: skillSha256 ${result.stageB.skillSha256}\n`);
    io.out(`freeze-prereg: atlasCommit ${result.stageB.atlasCommit}\n`);
  }
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
