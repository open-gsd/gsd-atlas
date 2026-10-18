import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  APPROVED_CONSTANTS_PATH,
  checkParams,
  freezePrereg,
  oq4Confirmation,
  readApprovedConstants,
  runCli,
} from './freeze-prereg.ts';
import type { ApprovedConstants, FreezeOptions, FreezeResult } from './freeze-prereg.ts';
import { DEFAULT_PREREG_PATH, hashFile, PREREG_BLOCK_LABEL, readPrereg, replacePreregBlock, STAGE_A_FILES } from './prereg.ts';
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

  test('a Stage B freeze is not this tool: it refuses with stage_unsupported', () => {
    setup();
    assert.equal(refusal(freezePrereg(options({ stage: 'B' }))).reason, 'stage_unsupported');
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
    writeFile('constants.md', 'unused');
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
