import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  APPROVED_CONSTANTS_PATH,
  REVISION_PLACEHOLDER,
  checkParams,
  freezePrereg,
  oq4Confirmation,
  readApprovedConstants,
  reopenPrereg,
  runCli,
} from './freeze-prereg.ts';
import type { ApprovedConstants, FreezeOptions, FreezeResult, ReopenOptions } from './freeze-prereg.ts';
import { DEFAULT_PREREG_PATH, hashFile, PREREG_BLOCK_LABEL, readPrereg, replacePreregBlock, SKILL_PATH, STAGE_A_FILES } from './prereg.ts';
import type { Prereg } from './prereg.ts';
import { verifyPrereg } from './verify-prereg.ts';

const SHA = 'a'.repeat(40);
const QUESTIONS_PATH = 'scripts/eval/questions/gsd-core.questions.json';
const ANSWERS_PATH = 'scripts/eval/questions/gsd-core.answers.json';

const APPROVED: ApprovedConstants = {
  marginPoints: 5,
  intervalLevel: 0.95,
  resamples: 10000,
  seed: 20261017,
  runsPerCell: 3,
  citationRate: 0.8,
  concurrency: 2,
  maxBudgetUsdPerSession: 3,
  sessionWallClockMs: 900000,
  scoredQuestions: 4,
  minQuestions: 3,
};

const PARAMS: Prereg['params'] = {
  marginPoints: 5,
  intervalLevel: 0.95,
  resamples: 10000,
  seed: 20261017,
  runsPerCell: 3,
  citationRate: 0.8,
  citationJudgedOn: 'wilson_lower_bound',
  wilsonZ: 1.96,
  tokenCriterion: 'point',
  failureRule: 'incorrect-keep-tokens',
  concurrency: 2,
  maxBudgetUsdPerSession: 3,
  sessionWallClockMs: 900000,
  model: 'claude-test-model',
  claudeVersion: '2.1.302',
  corpusSha: SHA,
  npmCiRan: true,
};

const OK_TESTS = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const BAD_TESTS = { command: process.execPath, args: ['-e', 'process.exit(1)'] };
const OK_BUILD = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const BAD_BUILD = { command: process.execPath, args: ['-e', 'console.error("tsc: error TS0000"); process.exit(1)'] };
const NOW = new Date('2026-10-18T12:00:00Z');

let root = '';

function abs(rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function git(...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd: root, env, encoding: 'utf8' },
  );
}

function writeFile(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
}

function questionsJson(): string {
  const questions = [
    { id: 'q-001', category: 'callers' },
    { id: 'q-002', category: 'callers' },
    { id: 'q-003', category: 'emit' },
    { id: 'q-004', category: 'abstain' },
  ];
  return `${JSON.stringify({ corpusId: 'toy', corpusSha: SHA, questions }, null, 2)}\n`;
}

function answersJson(): string {
  return `${JSON.stringify({ oracleVersion: 'test', repoSha: SHA, answers: [] }, null, 2)}\n`;
}

function draftPrereg(overrides: Partial<Prereg['params']> = {}, questionSet?: Prereg['questionSet']): Prereg {
  return {
    stage: 'A',
    status: 'Draft',
    params: { ...PARAMS, ...overrides },
    files: {},
    questionSet: questionSet ?? { count: 4, byCategory: { callers: 2, emit: 1, abstain: 1 } },
  };
}

function documentText(prereg: Prereg, oq4Lines: string[] = ['OQ4 confirmed by the user: wilson_lower_bound']): string {
  return [
    '# Pre-registration (test)',
    '',
    'Status: Draft',
    '',
    '## Design',
    '',
    'Prose that mentions `OQ4 confirmed by the user: point_estimate` inside code ticks, which is not an Approvals line.',
    '',
    '## Approvals',
    '',
    '> approve oq4=wilson_lower_bound',
    '',
    ...oq4Lines,
    '',
    '## Machine-readable block',
    '',
    `\`\`\`${PREREG_BLOCK_LABEL}`,
    JSON.stringify(prereg, null, 2),
    '```',
    '',
  ].join('\n');
}

function setup(doc: string = documentText(draftPrereg())): void {
  git('init', '--quiet');
  for (const rel of STAGE_A_FILES) writeFile(rel, `// stand-in for ${rel}\n`);
  writeFile(QUESTIONS_PATH, questionsJson());
  writeFile(ANSWERS_PATH, answersJson());
  writeFile(DEFAULT_PREREG_PATH, doc);
  git('add', '--all');
  git('commit', '--quiet', '-m', 'fixture');
}

function options(overrides: Partial<FreezeOptions> = {}): FreezeOptions {
  return {
    root,
    path: DEFAULT_PREREG_PATH,
    stage: 'A',
    approvedBy: 'Test Reviewer',
    now: NOW,
    approved: APPROVED,
    testCommand: OK_TESTS,
    ...overrides,
  };
}

function docBytes(): string {
  return fs.readFileSync(abs(DEFAULT_PREREG_PATH), 'utf8');
}

function refusal(result: FreezeResult): { reason: string; details: string[] } {
  assert.equal(result.ok, false, 'expected a refusal');
  if (result.ok) throw new Error('unreachable');
  return { reason: result.reason, details: result.details };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-prereg-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('freezePrereg', () => {
  test('freezes and verifies: Status line, hashes with CRLF normalised, and verifyPrereg passes', () => {
    setup();
    // One registered file is committed with CRLF; its registered hash is that of the LF form.
    writeFile('scripts/eval/oracle.ts', '// a\r\n// b\r\n');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'crlf');
    const result = freezePrereg(options());
    assert.equal(result.ok, true);
    const text = docBytes();
    assert.match(text, /^Status: Frozen \(Stage A, 2026-10-18, by Test Reviewer\)$/m);
    assert.doesNotMatch(text, /^Status: Draft/m);
    const prereg = readPrereg(abs(DEFAULT_PREREG_PATH));
    assert.equal(prereg.status, 'Frozen');
    assert.equal(prereg.stage, 'A');
    assert.deepEqual(Object.keys(prereg.files), [...STAGE_A_FILES]);
    for (const rel of STAGE_A_FILES) assert.equal(prereg.files[rel], hashFile(abs(rel)), rel);
    writeFile('lf.txt', '// a\n// b\n');
    assert.equal(prereg.files['scripts/eval/oracle.ts'], hashFile(abs('lf.txt')));
    const verified = verifyPrereg(abs(DEFAULT_PREREG_PATH), root);
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);
    // The prose around the block is untouched.
    assert.match(text, /^## Approvals$/m);
    assert.match(text, /^OQ4 confirmed by the user: wilson_lower_bound$/m);
  });

  test('dirty registered file: a modified registered file refuses and leaves the document unchanged', () => {
    setup();
    const before = docBytes();
    fs.appendFileSync(abs('scripts/eval/oracle.ts'), '// edited after the commit\n');
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'dirty_registered_file');
    assert.ok(refused.details.some((line) => line.includes('scripts/eval/oracle.ts')), refused.details.join('\n'));
    assert.equal(docBytes(), before);
  });

  test('dirty registered file: an untracked registered file refuses too', () => {
    setup();
    const before = docBytes();
    git('rm', '--quiet', '--cached', 'scripts/eval/stats.ts');
    git('commit', '--quiet', '-m', 'untrack');
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'dirty_registered_file');
    assert.ok(refused.details.some((line) => line.includes('scripts/eval/stats.ts')));
    assert.equal(docBytes(), before);
  });

  test('missing file: a Stage A path that is absent refuses and leaves the document unchanged', () => {
    setup();
    const before = docBytes();
    git('rm', '--quiet', 'scripts/eval/schedule.ts');
    git('commit', '--quiet', '-m', 'remove');
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'missing_file');
    assert.ok(refused.details.some((line) => line.includes('scripts/eval/schedule.ts')));
    assert.equal(docBytes(), before);
  });

  test('parameter mismatch: a margin of 4 against the approved 5 refuses and names the field', () => {
    setup(documentText(draftPrereg({ marginPoints: 4 })));
    const before = docBytes();
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'parameter_mismatch');
    assert.ok(refused.details.some((line) => line.includes('marginPoints')), refused.details.join('\n'));
    assert.equal(docBytes(), before);
  });

  test('parameter mismatch: a question count that differs from the question file refuses', () => {
    setup(documentText(draftPrereg({}, { count: 5, byCategory: { callers: 3, emit: 1, abstain: 1 } })));
    const refused = refusal(freezePrereg(options({ approved: { ...APPROVED, scoredQuestions: 5 } })));
    assert.equal(refused.reason, 'parameter_mismatch');
    assert.ok(refused.details.some((line) => line.includes('questions')), refused.details.join('\n'));
  });

  test('parameter mismatch: a corpus sha that differs from the question file refuses', () => {
    setup(documentText(draftPrereg({ corpusSha: 'b'.repeat(40) })));
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'parameter_mismatch');
    assert.ok(refused.details.some((line) => line.includes('corpusSha')));
  });

  test('tests failed: a failing test command refuses and leaves the document unchanged', () => {
    setup();
    const before = docBytes();
    const refused = refusal(freezePrereg(options({ testCommand: BAD_TESTS })));
    assert.equal(refused.reason, 'tests_failed');
    assert.equal(docBytes(), before);
  });

  test('already frozen: a second freeze refuses and changes nothing', () => {
    setup();
    assert.equal(freezePrereg(options()).ok, true);
    const frozen = docBytes();
    const refused = refusal(freezePrereg(options({ now: new Date('2026-12-31T00:00:00Z'), approvedBy: 'Someone Else' })));
    assert.equal(refused.reason, 'already_frozen');
    assert.equal(docBytes(), frozen);
  });

  test('citation criterion unconfirmed: no OQ4 line in Approvals refuses even though the Draft names a value', () => {
    setup(documentText(draftPrereg(), []));
    const before = docBytes();
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'citation_criterion_unconfirmed');
    assert.equal(docBytes(), before);
  });

  test('citation criterion unconfirmed: a line whose value is not one of the two names refuses', () => {
    setup(documentText(draftPrereg(), ['OQ4 confirmed by the user: whichever']));
    assert.equal(refusal(freezePrereg(options())).reason, 'citation_criterion_unconfirmed');
  });

  test('citation criterion mismatch: the line names the other value than params.citationJudgedOn', () => {
    setup(documentText(draftPrereg(), ['OQ4 confirmed by the user: point_estimate']));
    const before = docBytes();
    const refused = refusal(freezePrereg(options()));
    assert.equal(refused.reason, 'citation_criterion_unconfirmed');
    assert.ok(refused.details.some((line) => line.includes('point_estimate') && line.includes('wilson_lower_bound')), refused.details.join('\n'));
    assert.equal(docBytes(), before);
  });

  test('citation criterion duplicated: two OQ4 lines refuse, even when both agree', () => {
    setup(
      documentText(draftPrereg(), [
        'OQ4 confirmed by the user: wilson_lower_bound',
        '',
        'OQ4 confirmed by the user: wilson_lower_bound',
      ]),
    );
    const before = docBytes();
    assert.equal(refusal(freezePrereg(options())).reason, 'citation_criterion_unconfirmed');
    assert.equal(docBytes(), before);
  });

  test('citation criterion: a line outside the Approvals section does not confirm', () => {
    const text = documentText(draftPrereg(), []).replace('## Design\n', '## Design\n\nOQ4 confirmed by the user: wilson_lower_bound\n');
    setup(text);
    assert.equal(refusal(freezePrereg(options())).reason, 'citation_criterion_unconfirmed');
  });

  test('a Stage B freeze of a Draft Stage A document refuses: Stage B needs a frozen Stage A', () => {
    setup();
    assert.equal(refusal(freezePrereg(options({ stage: 'B', buildCommand: OK_BUILD }))).reason, 'stage_a_not_frozen');
  });

  test('an empty reviewer name refuses', () => {
    setup();
    assert.equal(refusal(freezePrereg(options({ approvedBy: '  ' }))).reason, 'invalid_reviewer');
  });

  test('a document that is not a Draft Stage A block with one Status line refuses as invalid_document', () => {
    setup(documentText(draftPrereg()).replace('Status: Draft\n', ''));
    assert.equal(refusal(freezePrereg(options())).reason, 'invalid_document');
  });
});

describe('freezePrereg, Stage B', () => {
  const SKILL_TEXT = '---\nname: gsd-atlas\n---\n\n# stand-in skill\n';

  function optionsB(overrides: Partial<FreezeOptions> = {}): FreezeOptions {
    return {
      root,
      path: DEFAULT_PREREG_PATH,
      stage: 'B',
      approvedBy: 'Test Reviewer',
      now: new Date('2026-11-02T09:00:00Z'),
      buildCommand: OK_BUILD,
      ...overrides,
    };
  }

  /** A repository whose Stage A is frozen and committed, with the skill file committed beside it. */
  function setupStageB(): void {
    setup();
    assert.equal(freezePrereg(options()).ok, true);
    writeFile(SKILL_PATH, SKILL_TEXT);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'stage A frozen, skill');
  }

  const head = (): string => git('rev-parse', 'HEAD').trim();

  test('records the skill hash (CRLF read as LF) and the HEAD commit, adds the Stage B status line, and verifyPrereg passes', () => {
    setup();
    assert.equal(freezePrereg(options()).ok, true);
    writeFile(SKILL_PATH, SKILL_TEXT.replace(/\n/g, '\r\n'));
    git('add', '--all');
    git('commit', '--quiet', '-m', 'stage A frozen, skill (CRLF)');
    const result = freezePrereg(optionsB());
    assert.equal(result.ok, true, JSON.stringify(result));
    const text = docBytes();
    const lines = text.split('\n').filter((line) => line.startsWith('Status:'));
    assert.deepEqual(lines, ['Status: Frozen (Stage A, 2026-10-18, by Test Reviewer)', 'Status: Frozen (Stage B, 2026-11-02, by Test Reviewer)']);
    const prereg = readPrereg(abs(DEFAULT_PREREG_PATH));
    assert.equal(prereg.stage, 'B');
    assert.equal(prereg.status, 'Frozen');
    assert.match(prereg.stageB?.skillSha256 ?? '', /^[0-9a-f]{64}$/);
    writeFile('skill-lf.txt', SKILL_TEXT);
    assert.equal(prereg.stageB?.skillSha256, hashFile(abs('skill-lf.txt')));
    assert.equal(prereg.stageB?.atlasCommit, head());
    // The sixteen Stage A hashes are exactly what Stage A recorded.
    for (const rel of STAGE_A_FILES) assert.equal(prereg.files[rel], hashFile(abs(rel)), rel);
    const verified = verifyPrereg(abs(DEFAULT_PREREG_PATH), root);
    assert.deepEqual(verified.problems, []);
    assert.match(text, /^## Approvals$/m);
  });

  test('after the freeze, one changed byte of the skill makes verifyPrereg fail and name the skill path', () => {
    setupStageB();
    assert.equal(freezePrereg(optionsB()).ok, true);
    fs.appendFileSync(abs(SKILL_PATH), ' ');
    const verified = verifyPrereg(abs(DEFAULT_PREREG_PATH), root);
    assert.equal(verified.ok, false);
    assert.ok(verified.problems.some((problem) => problem.includes(SKILL_PATH)), verified.problems.join('\n'));
  });

  test('stage_a_not_frozen: a Draft document refuses and is left unchanged', () => {
    setup();
    writeFile(SKILL_PATH, SKILL_TEXT);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'skill');
    const before = docBytes();
    assert.equal(refusal(freezePrereg(optionsB())).reason, 'stage_a_not_frozen');
    assert.equal(docBytes(), before);
  });

  test('stage_a_not_frozen: a Stage A document whose registered file changed since the freeze refuses and names the file', () => {
    setupStageB();
    fs.appendFileSync(abs('scripts/eval/oracle.ts'), '// changed after Stage A\n');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'edit a registered file');
    const before = docBytes();
    const refused = refusal(freezePrereg(optionsB()));
    assert.equal(refused.reason, 'stage_a_not_frozen');
    assert.ok(refused.details.some((line) => line.includes('scripts/eval/oracle.ts')), refused.details.join('\n'));
    assert.equal(docBytes(), before);
  });

  test('skill_missing: no skill file refuses', () => {
    setup();
    assert.equal(freezePrereg(options()).ok, true);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'stage A frozen');
    const before = docBytes();
    assert.equal(refusal(freezePrereg(optionsB())).reason, 'skill_missing');
    assert.equal(docBytes(), before);
  });

  test('skill_dirty: a modified, an untracked and a staged-only skill all refuse', () => {
    setupStageB();
    const before = docBytes();
    fs.appendFileSync(abs(SKILL_PATH), 'edited\n');
    assert.equal(refusal(freezePrereg(optionsB())).reason, 'skill_dirty');
    git('checkout', '--', SKILL_PATH);
    git('rm', '--quiet', '--cached', SKILL_PATH);
    git('commit', '--quiet', '-m', 'untrack the skill');
    const untracked = refusal(freezePrereg(optionsB()));
    assert.equal(untracked.reason, 'skill_dirty');
    assert.ok(untracked.details.some((line) => line.includes(SKILL_PATH)));
    assert.equal(docBytes(), before);
  });

  test('dirty_registered_file: a modified Stage A file refuses even though the skill is clean', () => {
    setupStageB();
    fs.appendFileSync(abs('scripts/eval/harness.ts'), '// uncommitted\n');
    const refused = refusal(freezePrereg(optionsB()));
    assert.ok(['dirty_registered_file', 'stage_a_not_frozen'].includes(refused.reason), refused.reason);
    assert.ok(refused.details.some((line) => line.includes('scripts/eval/harness.ts')), refused.details.join('\n'));
  });

  test('tree_dirty: any other uncommitted or untracked file refuses, because the build must be of HEAD', () => {
    setupStageB();
    writeFile('src/new-file.ts', 'export const x = 1;\n');
    const refused = refusal(freezePrereg(optionsB()));
    assert.equal(refused.reason, 'tree_dirty');
    assert.ok(refused.details.some((line) => line.includes('src/new-file.ts')), refused.details.join('\n'));
  });

  test('an untracked node_modules (a link to the main checkout in a worktree) does not count as dirty', () => {
    setupStageB();
    writeFile('node_modules/pkg/index.js', 'module.exports = 1;\n');
    assert.equal(freezePrereg(optionsB()).ok, true);
  });

  test('build_failed: a failing build refuses, shows its output and leaves the document unchanged', () => {
    setupStageB();
    const before = docBytes();
    const refused = refusal(freezePrereg(optionsB({ buildCommand: BAD_BUILD })));
    assert.equal(refused.reason, 'build_failed');
    assert.ok(refused.details.some((line) => line.includes('TS0000')), refused.details.join('\n'));
    assert.equal(docBytes(), before);
  });

  test('already_frozen_b: a second Stage B freeze refuses and changes nothing', () => {
    setupStageB();
    assert.equal(freezePrereg(optionsB()).ok, true);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'stage B');
    const frozen = docBytes();
    const refused = refusal(freezePrereg(optionsB({ now: new Date('2027-01-01T00:00:00Z'), approvedBy: 'Someone Else' })));
    assert.equal(refused.reason, 'already_frozen_b');
    assert.equal(docBytes(), frozen);
  });

  test('an empty reviewer name refuses', () => {
    setupStageB();
    assert.equal(refusal(freezePrereg(optionsB({ approvedBy: '' }))).reason, 'invalid_reviewer');
  });

  test('the Stage B record changes nothing but the block and one status line', () => {
    setupStageB();
    const before = docBytes();
    assert.equal(freezePrereg(optionsB()).ok, true);
    const after = docBytes();
    const strip = (text: string): string => text.replace(/```prereg-json[\s\S]*?```/, '').replace(/^Status: Frozen \(Stage B[^\n]*\n/m, '');
    assert.equal(strip(after), strip(before));
  });
});

// ---------------------------------------------------------------------------------------------
// Plan 03-38: reopen a frozen Stage A record to a CI-safe Draft, and re-freeze it as a revision

describe('reopen and revise a frozen Stage A record (plan 03-38)', () => {
  const REOPEN_LINE = 'OQ4 re-confirmed by the user at Revision 1: wilson_lower_bound';

  function reopenOptions(over: Partial<ReopenOptions> = {}): ReopenOptions {
    return { root, path: DEFAULT_PREREG_PATH, revision: 1, approvedBy: 'Test Reviewer', reason: 'the atlas arm needs the Skill tool', now: NOW, ...over };
  }

  function commitAll(message: string): void {
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
  }

  /** A repository whose Stage A is frozen and committed; returns the id of the commit that froze it. */
  function setupFrozenA(): string {
    setup();
    assert.equal(freezePrereg(options()).ok, true);
    commitAll('stage A frozen');
    return git('rev-parse', 'HEAD').trim();
  }

  /** setupFrozenA, then the reopen, committed. */
  function setupReopened(): string {
    const frozenCommit = setupFrozenA();
    const result = reopenPrereg(reopenOptions());
    assert.equal(result.ok, true, JSON.stringify(result));
    commitAll('reopen');
    return frozenCommit;
  }

  interface Fill {
    /** The `Changed registered files:` line; null: leave the line out. */
    changed?: string | null;
    /** Lines of the Approvals (Revision 1) section. */
    approvals?: string[];
    /** A heading to remove from the section. */
    dropHeading?: string;
    /** A heading whose body stays the reopen's placeholder. */
    keepPlaceholder?: string;
  }

  /** Writes the six sections the way Task 3 and Task 5 of the plan do, over the Draft the reopen left. */
  function fillRevision(fill: Fill = {}): void {
    let text = docBytes();
    const changed = fill.changed === undefined ? 'scripts/eval/arms.ts, scripts/eval/harness.ts' : fill.changed;
    const body = (heading: string): string => {
      if (heading === 'What changed') return `The atlas arm gains the Skill tool.${changed === null ? '' : `\n\nChanged registered files: ${changed}`}`;
      if (heading === 'Why') return 'The model could not see the skill under the registered tools.';
      if (heading === 'What did not change') return 'Every parameter, the question set, the keys, the oracle and the scorer.';
      return 'No scored session has run.';
    };
    for (const heading of ['What changed', 'Why', 'What did not change', 'No scored data']) {
      if (fill.keepPlaceholder === heading) continue;
      text = text.replace(`### ${heading}\n\n${REVISION_PLACEHOLDER}\n`, `### ${heading}\n\n${body(heading)}\n`);
    }
    const approvals = fill.approvals ?? ['> approve oq4=wilson_lower_bound', '', REOPEN_LINE];
    text = text.replace(/### Approvals \(Revision 1\)\n*$/, `### Approvals (Revision 1)\n\n${approvals.join('\n')}\n`);
    if (fill.dropHeading !== undefined) text = text.replace(`### ${fill.dropHeading}\n`, '');
    fs.writeFileSync(abs(DEFAULT_PREREG_PATH), text);
  }

  /** A reopened, filled-in Draft whose arms.ts and harness.ts changed after the first freeze, all committed. */
  function setupRevision(fill: Fill = {}): string {
    const frozenCommit = setupReopened();
    fs.appendFileSync(abs('scripts/eval/arms.ts'), '// revision 1\n');
    fs.appendFileSync(abs('scripts/eval/harness.ts'), '// revision 1\n');
    fillRevision(fill);
    commitAll('revision 1 draft');
    return frozenCommit;
  }

  const strip = (text: string): string =>
    text
      .replace(/```prereg-json[\s\S]*?```/, '')
      .replace(/^Status:[^\n]*\n/m, '')
      .replace(/\n+## Revision 1 \([^\n]*\n[\s\S]*$/, '')
      .trimEnd();

  test('reopen then revise then Stage B', () => {
    const frozenCommit = setupFrozenA();
    const frozen = readPrereg(abs(DEFAULT_PREREG_PATH));
    const before = docBytes();

    // 1. The reopen: a CI-safe Draft that carries the old record.
    const reopened = reopenPrereg(reopenOptions());
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    const draftText = docBytes();
    assert.deepEqual(draftText.split('\n').filter((line) => line.startsWith('Status:')), ['Status: Draft']);
    assert.doesNotMatch(draftText, /^Status: Frozen/m, 'the old status line never starts a line');
    assert.equal(strip(draftText), strip(before), 'every byte outside the status line, the block and the appended section is unchanged');
    const draft = readPrereg(abs(DEFAULT_PREREG_PATH));
    assert.equal(draft.status, 'Draft');
    assert.equal(draft.stage, 'A');
    assert.equal(draft.revision, 1);
    assert.deepEqual(draft.files, {});
    assert.deepEqual(draft.params, frozen.params);
    assert.deepEqual(draft.questionSet, frozen.questionSet);
    assert.equal(draft.supersedes?.length, 1);
    const old = draft.supersedes?.[0];
    assert.equal(old?.revision, 0);
    assert.equal(old?.status, 'Status: Frozen (Stage A, 2026-10-18, by Test Reviewer)');
    assert.equal(old?.frozenAtCommit, frozenCommit);
    assert.deepEqual(old?.params, frozen.params);
    assert.deepEqual(old?.questionSet, frozen.questionSet);
    assert.deepEqual(old?.files, frozen.files, 'the old hashes are those of the blobs at the freezing commit');
    assert.match(draftText, /^## Revision 1 \(2026-10-18\)$/m);
    for (const heading of ['What changed', 'Why', 'What did not change', 'No scored data', 'Superseded records', 'Approvals (Revision 1)']) {
      assert.match(draftText, new RegExp(`^### ${heading.replace(/[()]/g, '\\$&')}$`, 'm'), heading);
    }
    assert.ok(draftText.includes(frozenCommit), 'the table names the freezing commit');
    for (const rel of STAGE_A_FILES) assert.ok(draftText.includes(frozen.files[rel] as string), `the table holds the old hash of ${rel}`);
    assert.ok(draftText.includes('Status: Frozen (Stage A, 2026-10-18, by Test Reviewer)'), 'the table holds the old status line');
    assert.equal(verifyPrereg(abs(DEFAULT_PREREG_PATH), root).ok, true);
    assert.equal(verifyPrereg(abs(DEFAULT_PREREG_PATH), root, { draft: true }).ok, true);
    commitAll('reopen');

    // 2. The revision: two run-configuration files change, the sections are written, the user re-confirms OQ4.
    fs.appendFileSync(abs('scripts/eval/arms.ts'), '// revision 1\n');
    fs.appendFileSync(abs('scripts/eval/harness.ts'), '// revision 1\n');
    fillRevision();
    commitAll('revision 1 draft');
    const revised = freezePrereg(options());
    assert.equal(revised.ok, true, JSON.stringify(revised));
    const text = docBytes();
    assert.deepEqual(text.split('\n').filter((line) => line.startsWith('Status:')), ['Status: Frozen (Stage A, revision 1, 2026-10-18, by Test Reviewer)']);
    const record = readPrereg(abs(DEFAULT_PREREG_PATH));
    assert.equal(record.status, 'Frozen');
    assert.equal(record.revision, 1);
    assert.deepEqual(record.supersedes, draft.supersedes, 'the supersedes chain is kept as the reopen wrote it');
    for (const rel of STAGE_A_FILES) assert.equal(record.files[rel], hashFile(abs(rel)), rel);
    const changedNow = STAGE_A_FILES.filter((rel) => record.files[rel] !== old?.files[rel]);
    assert.deepEqual(changedNow, ['scripts/eval/arms.ts', 'scripts/eval/harness.ts'], 'exactly the declared files differ from the superseded record');
    assert.equal(verifyPrereg(abs(DEFAULT_PREREG_PATH), root).ok, true);
    assert.match(text, /^OQ4 confirmed by the user: wilson_lower_bound$/m, 'the first approval line is untouched');
    commitAll('revision 1 frozen');

    // 3. Stage B on top of the revision: its line goes below the revision line.
    writeFile(SKILL_PATH, '---\nname: gsd-atlas\n---\n\n# stand-in skill\n');
    commitAll('skill');
    const stageB = freezePrereg({ root, path: DEFAULT_PREREG_PATH, stage: 'B', approvedBy: 'Test Reviewer', now: new Date('2026-11-02T09:00:00Z'), buildCommand: OK_BUILD });
    assert.equal(stageB.ok, true, JSON.stringify(stageB));
    assert.deepEqual(docBytes().split('\n').filter((line) => line.startsWith('Status:')), [
      'Status: Frozen (Stage A, revision 1, 2026-10-18, by Test Reviewer)',
      'Status: Frozen (Stage B, 2026-11-02, by Test Reviewer)',
    ]);
    const b = readPrereg(abs(DEFAULT_PREREG_PATH));
    assert.equal(b.stage, 'B');
    assert.equal(b.revision, 1);
    assert.deepEqual(b.supersedes, draft.supersedes);
    assert.equal(verifyPrereg(abs(DEFAULT_PREREG_PATH), root).ok, true);
  });

  describe('reopen refusals', () => {
    test('reopen_not_frozen_a: a Draft and an absent document refuse', () => {
      setup();
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_not_frozen_a');
      assert.equal(docBytes(), before);
      assert.equal(refusal(reopenPrereg(reopenOptions({ path: 'docs/eval/nope.md' }))).reason, 'reopen_not_frozen_a');
    });

    test('reopen_stage_b_recorded: a Stage B record refuses and is left unchanged', () => {
      setupFrozenA();
      writeFile(SKILL_PATH, '# skill\n');
      commitAll('skill');
      assert.equal(freezePrereg({ root, path: DEFAULT_PREREG_PATH, stage: 'B', approvedBy: 'Test Reviewer', now: NOW, buildCommand: OK_BUILD }).ok, true);
      commitAll('stage B');
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_stage_b_recorded');
      assert.equal(docBytes(), before);
    });

    test('reopen_results_present: a committed results file refuses', () => {
      setupFrozenA();
      writeFile('docs/eval/results/results.jsonl', '{"questionId":"q-001"}\n');
      commitAll('a results file');
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_results_present');
      assert.equal(docBytes(), before);
    });

    test('reopen_tree_dirty: an untracked and a modified file refuse, node_modules does not count', () => {
      setupFrozenA();
      const before = docBytes();
      writeFile('src/new-file.ts', 'export const x = 1;\n');
      const untracked = refusal(reopenPrereg(reopenOptions()));
      assert.equal(untracked.reason, 'reopen_tree_dirty');
      assert.ok(untracked.details.some((line) => line.includes('src/new-file.ts')), untracked.details.join('\n'));
      fs.rmSync(abs('src'), { recursive: true });
      fs.appendFileSync(abs('scripts/eval/stats.ts'), '// edited\n');
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_tree_dirty');
      assert.equal(docBytes(), before);
      git('checkout', '--', 'scripts/eval/stats.ts');
      writeFile('node_modules/pkg/index.js', 'module.exports = 1;\n');
      assert.equal(reopenPrereg(reopenOptions()).ok, true);
    });

    test('reopen_already_open: a second reopen of an open revision refuses, and so does a revision number that is not the next one', () => {
      setupReopened();
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_already_open');
      assert.equal(refusal(reopenPrereg(reopenOptions({ revision: 2 }))).reason, 'reopen_already_open');
      assert.equal(docBytes(), before);
    });

    test('reopen_already_open: a revision that is already frozen cannot be opened again under the same number', () => {
      setupRevision();
      assert.equal(freezePrereg(options()).ok, true);
      commitAll('revision 1 frozen');
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_already_open');
      assert.equal(docBytes(), before);
    });

    test('reopen_record_unverified: a recorded hash that is not the blob at the freezing commit refuses', () => {
      setupFrozenA();
      const prereg = readPrereg(abs(DEFAULT_PREREG_PATH));
      const forged = replacePreregBlock(docBytes(), { ...prereg, files: { ...prereg.files, 'scripts/eval/stats.ts': 'f'.repeat(64) } });
      fs.writeFileSync(abs(DEFAULT_PREREG_PATH), forged);
      commitAll('a record that does not match its blobs');
      const before = docBytes();
      const refused = refusal(reopenPrereg(reopenOptions()));
      assert.equal(refused.reason, 'reopen_record_unverified');
      assert.ok(refused.details.some((line) => line.includes('scripts/eval/stats.ts')), refused.details.join('\n'));
      assert.equal(docBytes(), before);
    });

    test('reopen_record_unverified: a document that no commit holds has no freezing commit and refuses', () => {
      setupFrozenA();
      git('rm', '--quiet', '--cached', DEFAULT_PREREG_PATH);
      writeFile('.gitignore', 'docs/eval/preregistration.md\n');
      commitAll('the document is not in git');
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions())).reason, 'reopen_record_unverified');
      assert.equal(docBytes(), before);
    });

    test('an empty reviewer name and a reason with a line break refuse', () => {
      setupFrozenA();
      const before = docBytes();
      assert.equal(refusal(reopenPrereg(reopenOptions({ approvedBy: ' ' }))).reason, 'invalid_reviewer');
      assert.equal(refusal(reopenPrereg(reopenOptions({ reason: 'line one\nStatus: Frozen' }))).reason, 'invalid_document');
      assert.equal(docBytes(), before);
    });
  });

  describe('revision mode refusals', () => {
    test('revision_oq4_unconfirmed: no line, two lines, another value and the original line used instead all refuse', () => {
      const cases: Array<[string, string[]]> = [
        ['no line', ['> approve']],
        ['two lines', [REOPEN_LINE, '', REOPEN_LINE]],
        ['another value', ['OQ4 re-confirmed by the user at Revision 1: point_estimate']],
        ['an invalid value', ['OQ4 re-confirmed by the user at Revision 1: whichever']],
        ['the original line instead', ['OQ4 confirmed by the user: wilson_lower_bound']],
      ];
      for (const [name, approvals] of cases) {
        fs.rmSync(root, { recursive: true, force: true });
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-prereg-')));
        setupRevision({ approvals });
        const before = docBytes();
        const refused = refusal(freezePrereg(options()));
        assert.equal(refused.reason, 'revision_oq4_unconfirmed', `${name}: ${refused.details.join('; ')}`);
        assert.equal(docBytes(), before, name);
      }
    });

    test('revision_oq4_unconfirmed: a line outside the Approvals (Revision 1) section does not confirm', () => {
      setupRevision({ approvals: ['> approve'] });
      const text = docBytes().replace('### Why\n', `### Why\n\n${REOPEN_LINE}\n`);
      fs.writeFileSync(abs(DEFAULT_PREREG_PATH), text);
      commitAll('a line in the wrong section');
      assert.equal(refusal(freezePrereg(options())).reason, 'revision_oq4_unconfirmed');
    });

    test('revision_params_changed: a registered parameter or the question set that differs from the superseded record refuses', () => {
      setupRevision();
      const prereg = readPrereg(abs(DEFAULT_PREREG_PATH));
      fs.writeFileSync(abs(DEFAULT_PREREG_PATH), replacePreregBlock(docBytes(), { ...prereg, params: { ...prereg.params, model: 'claude-other-model' } }));
      commitAll('model changed');
      const before = docBytes();
      const refused = refusal(freezePrereg(options()));
      assert.equal(refused.reason, 'revision_params_changed');
      assert.ok(refused.details.some((line) => line.includes('model')), refused.details.join('\n'));
      assert.equal(docBytes(), before);
      fs.writeFileSync(
        abs(DEFAULT_PREREG_PATH),
        replacePreregBlock(docBytes(), { ...prereg, questionSet: { count: 4, byCategory: { callers: 1, emit: 2, abstain: 1 } } }),
      );
      commitAll('question set changed');
      assert.equal(refusal(freezePrereg(options())).reason, 'revision_params_changed');
    });

    test('revision_immutable_file_changed: a changed oracle or answers file refuses and names it, even when it is named as changed', () => {
      for (const rel of ['scripts/eval/oracle.ts', ANSWERS_PATH]) {
        fs.rmSync(root, { recursive: true, force: true });
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-prereg-')));
        setupRevision({ changed: `scripts/eval/arms.ts, scripts/eval/harness.ts, ${rel}` });
        fs.appendFileSync(abs(rel), ' ');
        commitAll(`edit ${rel}`);
        const before = docBytes();
        const refused = refusal(freezePrereg(options()));
        assert.equal(refused.reason, 'revision_immutable_file_changed', rel);
        assert.ok(refused.details.some((line) => line.includes(rel)), refused.details.join('\n'));
        assert.equal(docBytes(), before);
      }
    });

    test('revision_changes_undeclared: a changed file that is not named, a named file that did not change, and no line at all refuse', () => {
      const cases: Array<[string, string | null]> = [
        ['a changed file not named', 'scripts/eval/arms.ts'],
        ['a named file that did not change', 'scripts/eval/arms.ts, scripts/eval/harness.ts, scripts/eval/claude-session.ts'],
        ['no line', null],
      ];
      for (const [name, changed] of cases) {
        fs.rmSync(root, { recursive: true, force: true });
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-prereg-')));
        setupRevision({ changed });
        const before = docBytes();
        const refused = refusal(freezePrereg(options()));
        assert.equal(refused.reason, 'revision_changes_undeclared', `${name}: ${refused.details.join('; ')}`);
        assert.equal(docBytes(), before, name);
      }
    });

    test('revision_text_rewritten: a sentence of the original text that was edited refuses', () => {
      setupRevision();
      fs.writeFileSync(abs(DEFAULT_PREREG_PATH), docBytes().replace('Prose that mentions', 'Prose that now mentions'));
      commitAll('rewrite the first freeze');
      const before = docBytes();
      assert.equal(refusal(freezePrereg(options())).reason, 'revision_text_rewritten');
      assert.equal(docBytes(), before);
    });

    test('revision_text_rewritten: text added before the appended section refuses too', () => {
      setupRevision();
      fs.writeFileSync(abs(DEFAULT_PREREG_PATH), docBytes().replace('## Approvals\n', '## Approvals\n\nA new paragraph.\n'));
      commitAll('add to the first freeze');
      assert.equal(refusal(freezePrereg(options())).reason, 'revision_text_rewritten');
    });

    test('revision_sections_missing: a removed heading and a section left at the placeholder refuse', () => {
      for (const fill of [{ dropHeading: 'Why' }, { dropHeading: 'Superseded records' }, { keepPlaceholder: 'What did not change' }, { keepPlaceholder: 'No scored data' }] as Fill[]) {
        fs.rmSync(root, { recursive: true, force: true });
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-prereg-')));
        setupRevision(fill);
        const before = docBytes();
        const refused = refusal(freezePrereg(options()));
        assert.equal(refused.reason, 'revision_sections_missing', `${JSON.stringify(fill)}: ${refused.details.join('; ')}`);
        assert.equal(docBytes(), before);
      }
    });

    test('the Stage A refusals stay in revision mode: dirty_registered_file and tests_failed', () => {
      setupRevision();
      fs.appendFileSync(abs('scripts/eval/arms.ts'), '// uncommitted\n');
      const dirty = refusal(freezePrereg(options()));
      assert.equal(dirty.reason, 'dirty_registered_file');
      assert.ok(dirty.details.some((line) => line.includes('scripts/eval/arms.ts')));
      git('checkout', '--', 'scripts/eval/arms.ts');
      const before = docBytes();
      assert.equal(refusal(freezePrereg(options({ testCommand: BAD_TESTS }))).reason, 'tests_failed');
      assert.equal(docBytes(), before);
    });

    test('a revision freeze is not repeated: the frozen revision refuses with already_frozen', () => {
      setupRevision();
      assert.equal(freezePrereg(options()).ok, true);
      assert.equal(refusal(freezePrereg(options())).reason, 'already_frozen');
    });
  });

  describe('command', () => {
    function io(): { out: string[]; err: string[]; sinks: { out: (t: string) => void; err: (t: string) => void } } {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, sinks: { out: (t) => out.push(t), err: (t) => err.push(t) } };
    }

    test('--reopen --revision 1 --by --reason: exits 0 and prints the Draft and the revision', () => {
      setupFrozenA();
      const sink = io();
      const code = runCli(['--reopen', '--revision', '1', '--by', 'Tester', '--reason', 'the Skill tool'], sink.sinks, root, { now: NOW });
      assert.equal(code, 0, sink.err.join(''));
      assert.match(sink.out.join(''), /Draft/);
      assert.match(sink.out.join(''), /revision 1/);
    });

    test('--reopen: a refusal exits 1 with its reason; missing or conflicting options exit 2', () => {
      setup();
      const refused = io();
      assert.equal(runCli(['--reopen', '--revision', '1', '--by', 'Tester', '--reason', 'x'], refused.sinks, root, { now: NOW }), 1);
      assert.match(refused.err.join(''), /reopen_not_frozen_a/);
      const sink = io();
      assert.equal(runCli(['--reopen', '--by', 'Tester', '--reason', 'x'], sink.sinks, root, {}), 2);
      assert.equal(runCli(['--reopen', '--revision', '1', '--by', 'Tester'], sink.sinks, root, {}), 2);
      assert.equal(runCli(['--reopen', '--revision', 'one', '--by', 'Tester', '--reason', 'x'], sink.sinks, root, {}), 2);
      assert.equal(runCli(['--reopen', '--revision', '0', '--by', 'Tester', '--reason', 'x'], sink.sinks, root, {}), 2);
      assert.equal(runCli(['--reopen', '--stage', 'A', '--revision', '1', '--by', 'Tester', '--reason', 'x'], sink.sinks, root, {}), 2);
      assert.equal(runCli(['--stage', 'A', '--revision', '1', '--by', 'Tester'], sink.sinks, root, {}), 2);
    });

    test('--stage A on a reopened record freezes it as revision 1', () => {
      setupRevision();
      const sink = io();
      const code = runCli(['--stage', 'A', '--by', 'Tester'], sink.sinks, root, { approved: APPROVED, testCommand: OK_TESTS, now: NOW });
      assert.equal(code, 0, sink.err.join(''));
      assert.match(sink.out.join(''), /Frozen \(Stage A, revision 1, 2026-10-18, by Tester\)/);
    });
  });
});

describe('oq4Confirmation', () => {
  test('reads one value from the Approvals section only', () => {
    const doc = documentText(draftPrereg(), ['OQ4 confirmed by the user: point_estimate']);
    assert.deepEqual(oq4Confirmation(doc), { values: ['point_estimate'], problems: [] });
  });

  test('reports missing, invalid, duplicated and misplaced lines as problems', () => {
    assert.equal(oq4Confirmation(documentText(draftPrereg(), [])).values.length, 0);
    assert.ok(oq4Confirmation(documentText(draftPrereg(), [])).problems.length > 0);
    assert.ok(oq4Confirmation(documentText(draftPrereg(), ['OQ4 confirmed by the user: both'])).problems.length > 0);
    assert.ok(oq4Confirmation('no approvals heading\nOQ4 confirmed by the user: point_estimate\n').problems.length > 0);
  });
});

describe('checkParams', () => {
  test('equal to the approved constants: no problems', () => {
    assert.deepEqual(checkParams(draftPrereg(), APPROVED), []);
  });

  test('every approved value is compared', () => {
    const cases: Array<[Partial<Prereg['params']>, string]> = [
      [{ marginPoints: 4 }, 'marginPoints'],
      [{ intervalLevel: 0.9 }, 'intervalLevel'],
      [{ resamples: 5000 }, 'resamples'],
      [{ seed: 1 }, 'seed'],
      [{ runsPerCell: 2 }, 'runsPerCell'],
      [{ citationRate: 0.9 }, 'citationRate'],
      [{ concurrency: 3 }, 'concurrency'],
      [{ maxBudgetUsdPerSession: 1 }, 'maxBudgetUsdPerSession'],
      [{ sessionWallClockMs: 60000 }, 'sessionWallClockMs'],
    ];
    for (const [override, name] of cases) {
      const problems = checkParams(draftPrereg(override), APPROVED);
      assert.ok(problems.some((line) => line.includes(name)), `${name}: ${problems.join('; ')}`);
    }
  });

  test('a question count below the approved floor is a problem', () => {
    const problems = checkParams(draftPrereg({}, { count: 2, byCategory: { callers: 2 } }), { ...APPROVED, scoredQuestions: 2 });
    assert.ok(problems.some((line) => line.includes('minQuestions') || line.includes('at least')), problems.join('; '));
  });
});

describe('readApprovedConstants', () => {
  const TABLE = [
    '# Phase 3 Constants',
    '',
    'Status: Approved (2026-10-18, by the user)',
    '',
    '| Key | Proposed value | Consumed by plan | Basis |',
    '|-----|----------------|------------------|-------|',
    '| `eval.marginPoints` | 5 | 03-05, 03-16 | D-04, locked |',
    '| `eval.runsPerCell` | 3 | 03-10 | locked |',
    '| `eval.minQuestions` | 50 | 03-09 | locked |',
    '| `eval.citationRate` | 0.8 | 03-05 | locked |',
    '| `eval.intervalLevel` | 90 percent two-sided (the 5th percentile is the one-sided 95 percent lower bound) | 03-05 | registered |',
    '| `eval.bootstrapResamples` | 10000 | 03-05 | planner-added |',
    '| `eval.bootstrapSeed` | 20261017 | 03-05 | planner-added |',
    '| `eval.concurrency` | 2 | 03-10 | research |',
    '| `eval.maxBudgetUsdPerSession` | 3 (USD) | 03-14 | approved by reply |',
    '| `eval.sessionWallClockMs` | 900000 | 03-14 | approved by reply |',
    '| `eval.scoredQuestions` | 75 | 03-14 | recorded |',
    '',
  ].join('\n');

  test('reads the eval rows of an Approved constants file', () => {
    const file = abs('constants.md');
    writeFile('constants.md', TABLE);
    assert.deepEqual(readApprovedConstants(file), {
      marginPoints: 5,
      intervalLevel: 0.95,
      resamples: 10000,
      seed: 20261017,
      runsPerCell: 3,
      citationRate: 0.8,
      concurrency: 2,
      maxBudgetUsdPerSession: 3,
      sessionWallClockMs: 900000,
      scoredQuestions: 75,
      minQuestions: 50,
    });
  });

  test('refuses a file that is not Approved, a missing row and an unparseable value', () => {
    writeFile('proposed.md', TABLE.replace('Status: Approved', 'Status: Proposed'));
    assert.throws(() => readApprovedConstants(abs('proposed.md')), /Approved/);
    writeFile('missing.md', TABLE.replace('| `eval.concurrency` | 2 | 03-10 | research |\n', ''));
    assert.throws(() => readApprovedConstants(abs('missing.md')), /eval\.concurrency/);
    writeFile('bad.md', TABLE.replace('| `eval.bootstrapSeed` | 20261017 |', '| `eval.bootstrapSeed` | soon |'));
    assert.throws(() => readApprovedConstants(abs('bad.md')), /eval\.bootstrapSeed/);
  });
});

describe('replacePreregBlock', () => {
  test('replaces only the block, keeps the prose and the line endings', () => {
    const before = draftPrereg();
    const text = documentText(before).replace(/\n/g, '\r\n');
    const after: Prereg = { ...before, status: 'Frozen', files: { 'a.ts': 'f'.repeat(64) } };
    const out = replacePreregBlock(text, after);
    assert.ok(out.startsWith('# Pre-registration (test)\r\n'));
    assert.ok(!/[^\r]\n/.test(out), 'every line ending stays CRLF');
    const file = abs('crlf.md');
    writeFile('crlf.md', out);
    assert.deepEqual(readPrereg(file), after);
    assert.equal(out.split('## Approvals')[0], text.split('## Approvals')[0]);
  });

  test('throws when there is no block', () => {
    assert.throws(() => replacePreregBlock('# nothing\n', draftPrereg()), /prereg-json/);
  });
});

describe('runCli', () => {
  function io(): { out: string[]; err: string[]; sinks: { out: (t: string) => void; err: (t: string) => void } } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, sinks: { out: (t) => out.push(t), err: (t) => err.push(t) } };
  }

  test('usage errors exit 2', () => {
    const sink = io();
    assert.equal(runCli(['--stage', 'A'], sink.sinks, root, {}), 2);
    assert.equal(runCli(['--stage', 'C', '--by', 'x'], sink.sinks, root, {}), 2);
    assert.equal(runCli(['--by', 'x'], sink.sinks, root, {}), 2);
    assert.ok(sink.err.join('').includes('usage'));
  });

  test('a refusal exits 1 and prints its reason', () => {
    setup(documentText(draftPrereg(), []));
    const sink = io();
    const code = runCli(['--stage', 'A', '--by', 'Tester'], sink.sinks, root, { approved: APPROVED, testCommand: OK_TESTS, now: NOW });
    assert.equal(code, 1);
    assert.match(sink.err.join(''), /citation_criterion_unconfirmed/);
  });

  test('a freeze exits 0 and prints the status line', () => {
    setup();
    const sink = io();
    const code = runCli(['--stage', 'A', '--by', 'Tester'], sink.sinks, root, { approved: APPROVED, testCommand: OK_TESTS, now: NOW });
    assert.equal(code, 0);
    assert.match(sink.out.join(''), /Frozen \(Stage A, 2026-10-18, by Tester\)/);
  });

  test('--stage B: exits 0 and prints the status line, the skill hash and the commit; needs no constants file', () => {
    setup();
    assert.equal(runCli(['--stage', 'A', '--by', 'Tester'], io().sinks, root, { approved: APPROVED, testCommand: OK_TESTS, now: NOW }), 0);
    writeFile(SKILL_PATH, '# skill\n');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'stage A, skill');
    const sink = io();
    const code = runCli(['--stage', 'B', '--by', 'Tester'], sink.sinks, root, { buildCommand: OK_BUILD, now: new Date('2026-11-02T00:00:00Z') });
    assert.equal(code, 0, sink.err.join(''));
    const out = sink.out.join('');
    assert.match(out, /Frozen \(Stage B, 2026-11-02, by Tester\)/);
    assert.match(out, /skillSha256 [0-9a-f]{64}/);
    assert.match(out, /atlasCommit [0-9a-f]{40}/);
  });

  test('--stage B: a refusal exits 1 and prints its reason', () => {
    setup();
    const sink = io();
    const code = runCli(['--stage', 'B', '--by', 'Tester'], sink.sinks, root, { buildCommand: OK_BUILD });
    assert.equal(code, 1);
    assert.match(sink.err.join(''), /stage_a_not_frozen/);
  });
});

describe('the committed pre-registration draft', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const docPath = path.join(repoRoot, DEFAULT_PREREG_PATH);
  const constantsPath = path.join(repoRoot, APPROVED_CONSTANTS_PATH);
  const available = fs.existsSync(docPath) && fs.existsSync(constantsPath);

  test('its registered parameters equal the approved constants and its question set equals the question file', { skip: !available }, () => {
    const prereg = readPrereg(docPath);
    const approved = readApprovedConstants(constantsPath);
    assert.deepEqual(checkParams(prereg, approved), []);
    const questions = JSON.parse(fs.readFileSync(path.join(repoRoot, QUESTIONS_PATH), 'utf8')) as {
      corpusSha: string;
      questions: Array<{ category: string }>;
    };
    assert.equal(prereg.params.corpusSha, questions.corpusSha);
    assert.equal(prereg.questionSet.count, questions.questions.length);
    const byCategory: Record<string, number> = {};
    for (const question of questions.questions) byCategory[question.category] = (byCategory[question.category] ?? 0) + 1;
    assert.deepEqual(prereg.questionSet.byCategory, byCategory);
  });

  test('it has every section, a literal model id, Claude Code version and corpus sha, and no outcome language', { skip: !available }, () => {
    const text = fs.readFileSync(docPath, 'utf8');
    for (const heading of [
      'Purpose',
      'Hypotheses',
      'Design',
      'Corpus',
      'Questions',
      'Scoring',
      'Analysis',
      'Run configuration',
      'Stages',
      'Deviations policy',
      'Approvals',
    ]) {
      assert.match(text, new RegExp(`^## ${heading}\\s*$`, 'm'), heading);
    }
    const prereg = readPrereg(docPath);
    assert.notEqual(prereg.params.model, '');
    assert.match(prereg.params.claudeVersion, /^\d+\.\d+\.\d+$/);
    assert.match(prereg.params.corpusSha, /^[0-9a-f]{40}$/);
    assert.ok(text.includes(prereg.params.model));
    assert.ok(text.includes(prereg.params.claudeVersion));
    assert.ok(text.includes(prereg.params.corpusSha));
    assert.doesNotMatch(text, /\b(TBD|TODO|FIXME|<placeholder>)\b/);
  });
});
