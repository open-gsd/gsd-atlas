import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { analyzeAccuracy, analyzeResults, configFromPrereg, renderReport, runCli } from './analyze.ts';
import type { Analysis, AnalysisConfig, CompleteAnalysis, ExpectedCells } from './analyze.ts';
import { PREREG_BLOCK_LABEL } from './prereg.ts';
import type { Prereg } from './prereg.ts';
import type { Category } from './questions.ts';
import { ResultRowSchema } from './rows.ts';
import type { Arm, ResultRow, SessionStatus } from './rows.ts';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'results-small.jsonl');

function loadFixture(): ResultRow[] {
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ResultRowSchema.parse(JSON.parse(line)));
}

const CONFIG: AnalysisConfig = {
  marginPoints: 5,
  intervalLevel: 0.95,
  resamples: 2000,
  seed: 7,
  tokenCriterion: 'point',
  citationRate: 0.8,
  citationJudgedOn: 'point_estimate',
  zForWilson: 1.96,
};

/** Every (question, arm, run) cell the rows are expected to cover. */
function expectedOf(rows: readonly ResultRow[], runsPerCell = 2): ExpectedCells {
  const ids = [...new Set(rows.map((row) => row.questionId))].sort();
  return { questionIds: ids, arms: ['atlas', 'grep'], runsPerCell };
}

function complete(analysis: Analysis): CompleteAnalysis {
  assert.equal(analysis.complete, true, 'expected a complete analysis');
  return analysis as CompleteAnalysis;
}

function run(rows: readonly ResultRow[], config: AnalysisConfig = CONFIG, runsPerCell = 2): CompleteAnalysis {
  return complete(analyzeResults(rows, config, expectedOf(rows, runsPerCell)));
}

/** Replaces one row of a row set. */
function withRow(rows: readonly ResultRow[], questionId: string, arm: Arm, runNumber: number, change: Partial<ResultRow>): ResultRow[] {
  return rows.map((row) => (row.questionId === questionId && row.arm === arm && row.run === runNumber ? { ...row, ...change } : row));
}

interface Make {
  questionId: string;
  arm: Arm;
  run?: number;
  category?: Category;
  correct?: boolean;
  status?: SessionStatus;
  input?: number;
  hasVerifiable?: boolean;
}

/** A row whose only token field is `input`, so billableTokens equals it. */
function make(o: Make): ResultRow {
  const input = o.input ?? 100;
  const abstain = o.category === 'abstain';
  return {
    questionId: o.questionId,
    category: o.category ?? 'callers',
    arm: o.arm,
    run: o.run ?? 1,
    status: o.status ?? 'ok',
    answered: 'found',
    correct: o.correct ?? true,
    citation: {
      applicable: !abstain,
      total: o.hasVerifiable === true ? 1 : 0,
      verified: o.hasVerifiable === true ? 1 : 0,
      hasVerifiable: o.hasVerifiable ?? false,
    },
    usage: { input, output: 0, cacheCreation: 0, cacheRead: 0 },
    billableTokens: input,
    toolCalls: 1,
    toolCallsByName: { Read: 1 },
    atlasToolCalls: 0,
    wallMs: 1000,
    costUsd: null,
  };
}

/** 50 non-abstain questions (the first `ok` with a verifiable atlas citation) plus 2 abstain questions, one run each. */
function citationRows(ok: number, grepOk = 50): ResultRow[] {
  const rows: ResultRow[] = [];
  for (let i = 1; i <= 52; i += 1) {
    const questionId = `q-${String(i).padStart(3, '0')}`;
    const category: Category = i <= 50 ? 'callers' : 'abstain';
    rows.push(make({ questionId, arm: 'atlas', category, hasVerifiable: i <= ok }));
    rows.push(make({ questionId, arm: 'grep', category, hasVerifiable: i <= grepOk }));
  }
  return rows;
}

describe('ResultRowSchema', () => {
  test('ResultRowSchema accepts every row of the fixture', () => {
    assert.equal(loadFixture().length, 8);
  });

  test('ResultRowSchema rejects a row whose billableTokens is not the sum of the four usage fields', () => {
    const [row] = loadFixture();
    assert.ok(row);
    const result = ResultRowSchema.safeParse({ ...row, billableTokens: row.billableTokens + 1 });
    assert.equal(result.success, false);
    assert.match(JSON.stringify(result.error?.issues), /billableTokens/);
  });

  test('ResultRowSchema accepts a null costUsd and rejects an unknown key and run 0', () => {
    const [row] = loadFixture();
    assert.ok(row);
    assert.equal(ResultRowSchema.safeParse({ ...row, costUsd: null }).success, true);
    assert.equal(ResultRowSchema.safeParse({ ...row, extra: 1 }).success, false);
    assert.equal(ResultRowSchema.safeParse({ ...row, run: 0 }).success, false);
  });

  test('ResultRowSchema rejects more verified citations than cited ones', () => {
    const [row] = loadFixture();
    assert.ok(row);
    const bad = { ...row, citation: { ...row.citation, total: 1, verified: 2 } };
    assert.equal(ResultRowSchema.safeParse(bad).success, false);
  });
});

describe('analyzeResults accuracy', () => {
  test('observed difference matches the hand computation (q-1: 1 - 0.5, q-2: 1 - 1, mean 0.25)', () => {
    assert.equal(run(loadFixture()).accuracy.observedDiff, 0.25);
  });

  test('passing variant: lower is 0 (the 5th percentile of {0, 0.25, 0.5}) so accuracyNonInferior is true', () => {
    const { accuracy } = run(loadFixture());
    assert.equal(accuracy.lower, 0);
    assert.equal(accuracy.upper, 0.5);
    assert.equal(accuracy.accuracyNonInferior, accuracy.lower > -0.05);
    assert.equal(accuracy.accuracyNonInferior, true);
  });

  test('failing variant: one more wrong atlas answer on q-2 gives lower -0.5 and accuracyNonInferior false', () => {
    const { accuracy } = run(withRow(loadFixture(), 'q-2', 'atlas', 2, { correct: false, status: 'error' }));
    assert.equal(accuracy.observedDiff, 0); // differences 0.5 and -0.5
    assert.equal(accuracy.lower, -0.5);
    assert.equal(accuracy.accuracyNonInferior, accuracy.lower > -0.05);
    assert.equal(accuracy.accuracyNonInferior, false);
  });

  test('the margin is read from the config: a zero margin makes lower 0 not above -0', () => {
    const { accuracy } = run(loadFixture(), { ...CONFIG, marginPoints: 0 });
    assert.equal(accuracy.lower, 0);
    assert.equal(accuracy.accuracyNonInferior, false); // the rule is strictly above minus the margin
  });

  test('a wide margin passes the failing variant', () => {
    const rows = withRow(loadFixture(), 'q-2', 'atlas', 2, { correct: false });
    assert.equal(run(rows, { ...CONFIG, marginPoints: 60 }).accuracy.accuracyNonInferior, true);
  });

  test('analyzeAccuracy throws a RangeError for a question with rows in only one arm and for no rows', () => {
    const rows = loadFixture().filter((row) => !(row.questionId === 'q-2' && row.arm === 'grep'));
    assert.throws(() => analyzeAccuracy(rows, CONFIG), RangeError);
    assert.throws(() => analyzeAccuracy([], CONFIG), RangeError);
  });

  test('the same config gives the same result twice, whatever the order of the rows', () => {
    const rows = loadFixture();
    assert.deepEqual(run(rows), run([...rows].reverse()));
  });
});

describe('analyzeResults tokens', () => {
  /** q-1: atlas 1000 vs grep 1100 (difference -100); q-2: atlas 1110 vs grep 1100 (+10); two runs each. */
  function mixed(): ResultRow[] {
    const rows: ResultRow[] = [];
    for (const runNumber of [1, 2]) {
      rows.push(make({ questionId: 'q-1', arm: 'atlas', run: runNumber, input: 1000 }));
      rows.push(make({ questionId: 'q-1', arm: 'grep', run: runNumber, input: 1100 }));
      rows.push(make({ questionId: 'q-2', arm: 'atlas', run: runNumber, input: 1110 }));
      rows.push(make({ questionId: 'q-2', arm: 'grep', run: runNumber, input: 1100 }));
    }
    return rows;
  }

  test('tokens point criterion: the observed mean difference -45 is below zero so fewerTokens is true', () => {
    const { tokens } = run(mixed(), { ...CONFIG, tokenCriterion: 'point' });
    assert.equal(tokens.observedDiff, -45); // (-100 + 10) / 2
    assert.equal(tokens.fewerTokens, true);
  });

  test('tokens upper-bound criterion: the 95th percentile is 10 (not below zero) so fewerTokens is false', () => {
    const { tokens } = run(mixed(), { ...CONFIG, tokenCriterion: 'upper-bound' });
    assert.equal(tokens.lower, -100); // resampled means are -100, -45 or 10 with probabilities 1/4, 1/2, 1/4
    assert.equal(tokens.upper, 10);
    assert.equal(tokens.fewerTokens, false);
  });

  test('tokens upper-bound criterion passes when every question difference is negative (fixture)', () => {
    const { tokens } = run(loadFixture(), { ...CONFIG, tokenCriterion: 'upper-bound' });
    // q-1: atlas (1350 + 1400) / 2 = 1375 vs grep (2900 + 3000) / 2 = 2950 -> -1575; q-2: 1210 vs 2270 -> -1060
    assert.equal(tokens.observedDiff, -1317.5);
    assert.equal(tokens.upper, -1060);
    assert.equal(tokens.fewerTokens, true);
  });

  test('tokens are paired by question: a heavy question does not outweigh a light one', () => {
    const rows = [
      make({ questionId: 'q-1', arm: 'atlas', input: 10 }),
      make({ questionId: 'q-1', arm: 'grep', input: 20 }),
      make({ questionId: 'q-2', arm: 'atlas', input: 1_000_000 }),
      make({ questionId: 'q-2', arm: 'grep', input: 999_990 }),
    ];
    const { tokens } = complete(analyzeResults(rows, CONFIG, expectedOf(rows, 1)));
    assert.equal(tokens.observedDiff, 0); // (-10 + 10) / 2
    assert.equal(tokens.fewerTokens, false); // not below zero
  });
});

describe('analyzeResults citations', () => {
  /** Hand calculation, Wilson at 46 of 50, z 1.96: centre 0.89003, half-width 0.07842, lower 0.8116 (above 0.8). */
  test('citation point_estimate: 45 of 50 is 0.90, at or above 0.8, so citationOk is true', () => {
    const rows = citationRows(45);
    const { citations } = complete(analyzeResults(rows, { ...CONFIG, citationJudgedOn: 'point_estimate' }, expectedOf(rows, 1)));
    assert.equal(citations.byArm.atlas.sessions, 50); // the two abstain questions are not counted
    assert.equal(citations.byArm.atlas.verifiable, 45);
    assert.equal(citations.byArm.atlas.point, 0.9);
    assert.equal(citations.citationOk, true);
  });

  /** Hand calculation, Wilson at 45 of 50, z 1.96: centre 0.87146, half-width 0.08507, lower 0.7864 (below 0.8). */
  test('citation wilson_lower_bound: 45 of 50 has a lower bound near 0.7864, below 0.8, so citationOk is false', () => {
    const rows = citationRows(45);
    const { citations } = complete(analyzeResults(rows, { ...CONFIG, citationJudgedOn: 'wilson_lower_bound' }, expectedOf(rows, 1)));
    assert.ok(Math.abs(citations.byArm.atlas.lower - 0.7864) < 0.001);
    assert.equal(citations.citationOk, false);
  });

  test('citation wilson_lower_bound: 46 of 50 has a lower bound near 0.8116, above 0.8, so citationOk is true', () => {
    const rows = citationRows(46);
    const { citations } = complete(analyzeResults(rows, { ...CONFIG, citationJudgedOn: 'wilson_lower_bound' }, expectedOf(rows, 1)));
    assert.ok(Math.abs(citations.byArm.atlas.lower - 0.8115) < 0.001);
    assert.equal(citations.citationOk, true);
  });

  test('both citation rules reported: 45 of 50 passes the point rule and fails the Wilson rule, and the registered one decides', () => {
    const rows = citationRows(45);
    const expected = expectedOf(rows, 1);
    const asPoint = complete(analyzeResults(rows, { ...CONFIG, citationJudgedOn: 'point_estimate' }, expected)).citations;
    const asWilson = complete(analyzeResults(rows, { ...CONFIG, citationJudgedOn: 'wilson_lower_bound' }, expected)).citations;
    for (const citations of [asPoint, asWilson]) {
      assert.equal(citations.citationOkPointEstimate, true);
      assert.equal(citations.citationOkWilsonLowerBound, false);
    }
    assert.equal(asPoint.citationOk, true);
    assert.equal(asWilson.citationOk, false);
    assert.equal(asPoint.judgedOn, 'point_estimate');
    assert.equal(asWilson.judgedOn, 'wilson_lower_bound');
  });

  test('both citation rules reported: 46 of 50 passes both', () => {
    const rows = citationRows(46);
    const { citations } = complete(analyzeResults(rows, CONFIG, expectedOf(rows, 1)));
    assert.equal(citations.citationOkPointEstimate, true);
    assert.equal(citations.citationOkWilsonLowerBound, true);
  });

  test('citations are reported for both arms with a Wilson interval', () => {
    const rows = citationRows(46, 40);
    const { citations } = complete(analyzeResults(rows, CONFIG, expectedOf(rows, 1)));
    assert.equal(citations.byArm.grep.verifiable, 40);
    assert.equal(citations.byArm.grep.point, 0.8);
    assert.ok(citations.byArm.grep.lower < 0.8 && citations.byArm.grep.upper > 0.8);
    assert.equal(citations.judgedArm, 'atlas');
  });

  test('a failed session never counts as a verifiable citation', () => {
    const rows = withRow(citationRows(50), 'q-001', 'atlas', 1, { status: 'timeout' });
    const { citations } = complete(analyzeResults(rows, CONFIG, expectedOf(rows, 1)));
    assert.equal(citations.byArm.atlas.verifiable, 49);
  });

  test('missing citationJudgedOn throws, with no default branch', () => {
    const { citationJudgedOn: _omitted, ...rest } = CONFIG;
    const rows = loadFixture();
    assert.throws(() => analyzeResults(rows, rest as unknown as AnalysisConfig, expectedOf(rows)), /citationJudgedOn/);
  });

  test('unknown citationJudgedOn value throws', () => {
    const rows = loadFixture();
    for (const bad of ['both', 'Wilson_Lower_Bound', '', 'wilson']) {
      assert.throws(
        () => analyzeResults(rows, { ...CONFIG, citationJudgedOn: bad as unknown as AnalysisConfig['citationJudgedOn'] }, expectedOf(rows)),
        /citationJudgedOn/,
        `value ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('analyzeResults failures and completeness', () => {
  test('failed session counts as incorrect and keeps its tokens, even when its row says correct', () => {
    const base = run(loadFixture());
    const rows = withRow(loadFixture(), 'q-2', 'atlas', 2, { status: 'timeout', correct: true });
    const result = run(rows);
    // atlas accuracy: q-1 1.0 and q-2 (1 + 0) / 2 = 0.5, mean 0.75 (it was 1.0)
    assert.equal(base.arms.atlas.accuracy, 1);
    assert.equal(result.arms.atlas.accuracy, 0.75);
    assert.equal(result.arms.atlas.tokens.total, base.arms.atlas.tokens.total); // 5170 either way
    assert.equal(result.arms.atlas.tokens.total, 5170);
    assert.equal(result.arms.atlas.failedSessions, 1);
    assert.deepEqual(result.failedSessions, [{ questionId: 'q-2', arm: 'atlas', run: 2, status: 'timeout' }]);
  });

  test('incomplete run: a missing cell is listed and no verdict exists', () => {
    const rows = loadFixture().filter((row) => !(row.questionId === 'q-2' && row.arm === 'grep' && row.run === 2));
    const analysis = analyzeResults(rows, CONFIG, expectedOf(loadFixture()));
    assert.equal(analysis.complete, false);
    assert.ok(!analysis.complete);
    assert.deepEqual(analysis.missing, [{ questionId: 'q-2', arm: 'grep', run: 2 }]);
    assert.equal(analysis.expectedCells, 8);
    assert.equal(analysis.presentCells, 7);
    assert.equal('verdicts' in analysis, false);
    const report = renderReport(analysis);
    assert.match(report, /INCOMPLETE/);
    assert.match(report, /q-2/);
    assert.doesNotMatch(report, /MVP met|non-inferior|CITATIONS:|TOKENS:/);
  });

  test('incomplete run: a whole missing question lists every one of its cells in order', () => {
    const rows = loadFixture().filter((row) => row.questionId !== 'q-2');
    const analysis = analyzeResults(rows, CONFIG, expectedOf(loadFixture()));
    assert.ok(!analysis.complete);
    assert.deepEqual(
      analysis.missing.map((cell) => `${cell.questionId}/${cell.arm}/${String(cell.run)}`),
      ['q-2/atlas/1', 'q-2/atlas/2', 'q-2/grep/1', 'q-2/grep/2'],
    );
  });

  test('duplicate cell throws an error that names the cell', () => {
    const rows = [...loadFixture(), loadFixture()[0] as ResultRow];
    assert.throws(() => analyzeResults(rows, CONFIG, expectedOf(rows)), /duplicate.*q-1.*atlas.*1/i);
  });

  test('a row outside the expected cells throws instead of being dropped', () => {
    const rows = [...loadFixture(), make({ questionId: 'q-1', arm: 'atlas', run: 3 })];
    assert.throws(() => analyzeResults(rows, CONFIG, expectedOf(loadFixture())), /unexpected.*q-1.*atlas.*3/i);
    const stranger = [...loadFixture(), make({ questionId: 'q-9', arm: 'grep', run: 1 })];
    assert.throws(() => analyzeResults(stranger, CONFIG, expectedOf(loadFixture())), /unexpected.*q-9/i);
  });
});

describe('analyzeResults per-arm summaries', () => {
  test('tokens per arm: total, input, output, cache creation and cache read are their own columns', () => {
    const { arms } = run(loadFixture());
    assert.deepEqual(arms.atlas.tokens, { total: 5170, mean: 1292.5, input: 420, output: 210, cacheCreation: 700, cacheRead: 3840 });
    assert.deepEqual(arms.grep.tokens, { total: 10440, mean: 2610, input: 1090, output: 410, cacheCreation: 1800, cacheRead: 7140 });
  });

  test('tool calls, wall time and atlas share per arm match the hand totals', () => {
    const { arms } = run(loadFixture());
    assert.deepEqual(arms.atlas.toolCalls, { total: 15, mean: 3.75 }); // 4 + 5 + 3 + 3
    assert.deepEqual(arms.grep.toolCalls, { total: 30, mean: 7.5 }); // 8 + 9 + 6 + 7
    assert.deepEqual(arms.atlas.wallMs, { total: 39000, mean: 9750 });
    assert.deepEqual(arms.grep.wallMs, { total: 73000, mean: 18250 });
    assert.equal(arms.atlas.atlasToolShare, 11 / 15); // 3 + 4 + 2 + 2 atlas calls out of 15
    assert.equal(arms.grep.atlasToolShare, 0);
  });

  test('mean cost is taken over the sessions that report one', () => {
    const { arms } = run(loadFixture());
    assert.ok(arms.atlas.costUsd !== null);
    assert.ok(Math.abs(arms.atlas.costUsd.total - 0.39) < 1e-9); // 0.10 + 0.12 + 0.08 + 0.09
    assert.ok(Math.abs(arms.atlas.costUsd.mean - 0.0975) < 1e-9);
    const rows = loadFixture().map((row) => (row.arm === 'atlas' && row.run === 2 ? { ...row, costUsd: null } : row));
    const partial = run(rows).arms.atlas.costUsd;
    assert.ok(partial !== null);
    assert.equal(partial.sessionsWithCost, 2);
    assert.ok(Math.abs(partial.mean - 0.09) < 1e-9); // (0.10 + 0.08) / 2
    const none = run(rows.map((row) => ({ ...row, costUsd: null }))).arms.grep.costUsd;
    assert.equal(none, null);
  });
});

describe('renderReport', () => {
  test('report prints the verdict lines, the parameters and the per-arm tables for the fixture', () => {
    const report = renderReport(analyzeResults(loadFixture(), CONFIG, expectedOf(loadFixture())));
    assert.match(report, /^# /);
    assert.match(report, /ACCURACY: non-inferior/);
    assert.match(report, /TOKENS: fewer/);
    assert.match(report, /CITATIONS: ok/);
    assert.match(report, /OVERALL: MVP met/);
    assert.match(report, /\| citationJudgedOn \| point_estimate \|/);
    assert.match(report, /\| marginPoints \| 5 \|/);
    assert.match(report, /cache read/i);
  });

  test('report says NOT non-inferior, not fewer, below threshold and MVP not met when each rule fails', () => {
    const failing = withRow(loadFixture(), 'q-2', 'atlas', 2, { correct: false });
    const accuracy = renderReport(analyzeResults(failing, CONFIG, expectedOf(failing)));
    assert.match(accuracy, /ACCURACY: NOT non-inferior/);
    assert.match(accuracy, /OVERALL: MVP not met/);
    const wilson = renderReport(analyzeResults(loadFixture(), { ...CONFIG, citationJudgedOn: 'wilson_lower_bound' }, expectedOf(loadFixture())));
    assert.match(wilson, /CITATIONS: below threshold/); // 4 of 4 has a Wilson lower bound near 0.51
    assert.match(wilson, /OVERALL: MVP not met/);
    const heavy = loadFixture().map((row) => (row.arm === 'atlas' ? { ...row, usage: { ...row.usage, input: row.usage.input + 9000 }, billableTokens: row.billableTokens + 9000 } : row));
    assert.match(renderReport(analyzeResults(heavy, CONFIG, expectedOf(heavy))), /TOKENS: not fewer/);
  });

  test('report lists failed sessions by question id', () => {
    const rows = withRow(loadFixture(), 'q-2', 'atlas', 2, { status: 'timeout', correct: false });
    const report = renderReport(analyzeResults(rows, CONFIG, expectedOf(rows)));
    assert.match(report, /q-2 \| atlas \| 2 \| timeout/);
  });

  test('report is deterministic: the same analysis renders byte-identical markdown whatever the row order', () => {
    const rows = loadFixture();
    const first = renderReport(analyzeResults(rows, CONFIG, expectedOf(rows)));
    const again = renderReport(analyzeResults(rows, CONFIG, expectedOf(rows)));
    const shuffled = renderReport(analyzeResults([...rows].reverse(), CONFIG, expectedOf(rows)));
    assert.equal(first, again);
    assert.equal(first, shuffled);
    assert.ok(first.endsWith('\n'));
    assert.doesNotMatch(first, /-0\.0000/);
  });
});

describe('analyze command', () => {
  const PREREG: Prereg = {
    stage: 'A',
    status: 'Draft',
    params: {
      marginPoints: 5,
      intervalLevel: 0.95,
      resamples: 2000,
      seed: 7,
      runsPerCell: 2,
      citationRate: 0.8,
      citationJudgedOn: 'point_estimate',
      wilsonZ: 1.96,
      tokenCriterion: 'point',
      failureRule: 'incorrect-keep-tokens',
      concurrency: 2,
      maxBudgetUsdPerSession: 2,
      sessionWallClockMs: 600000,
      model: 'claude-test-model',
      claudeVersion: '2.1.302',
      corpusSha: 'a'.repeat(40),
      npmCiRan: true,
    },
    files: {},
    questionSet: { count: 2, byCategory: { callers: 1, definition: 1 } },
  };

  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-cli-'));
    fs.mkdirSync(path.join(root, 'docs', 'eval'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writePrereg(value: unknown): string {
    const file = path.join(root, 'docs', 'eval', 'preregistration.md');
    fs.writeFileSync(file, `# Pre-registration\n\n\`\`\`${PREREG_BLOCK_LABEL}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
    return file;
  }

  function writeResults(rows: readonly ResultRow[]): string {
    const file = path.join(root, 'results.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  async function invoke(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await runCli(argv, { out: (text) => (out += text), err: (text) => (err += text) }, root);
    return { code, out, err };
  }

  const outFile = (): string => path.join(root, 'docs', 'eval', 'analysis.md');

  test('configFromPrereg copies every parameter from the block and maps wilsonZ to zForWilson', () => {
    const config = configFromPrereg(PREREG);
    assert.deepEqual(config, {
      marginPoints: 5,
      intervalLevel: 0.95,
      resamples: 2000,
      seed: 7,
      tokenCriterion: 'point',
      citationRate: 0.8,
      citationJudgedOn: 'point_estimate',
      zForWilson: 1.96,
    });
  });

  test('the command reads its parameters from the block: exit 0 and the report echoes them', async () => {
    const prereg = writePrereg(PREREG);
    const results = writeResults(loadFixture());
    const result = await invoke([results, '--prereg', prereg, '--out', outFile()]);
    assert.equal(result.code, 0, result.err);
    const report = fs.readFileSync(outFile(), 'utf8');
    assert.match(report, /OVERALL: MVP met/);
    assert.match(report, /\| citationJudgedOn \| point_estimate \|/);
    assert.match(result.err, /Draft/); // a Draft registration is allowed but flagged
  });

  test('changing a registered parameter changes the verdict, not the code, and a complete run exits 0 whatever the verdict', async () => {
    const rows = withRow(loadFixture(), 'q-2', 'atlas', 2, { correct: false }); // lower bound -0.5
    const strict = await invoke([writeResults(rows), '--prereg', writePrereg(PREREG), '--out', outFile()]);
    assert.equal(strict.code, 0, 'a complete run exits 0 whatever the verdict');
    assert.match(fs.readFileSync(outFile(), 'utf8'), /ACCURACY: NOT non-inferior/);
    const wide = await invoke([writeResults(rows), '--prereg', writePrereg({ ...PREREG, params: { ...PREREG.params, marginPoints: 60 } }), '--out', outFile()]);
    assert.equal(wide.code, 0);
    assert.match(fs.readFileSync(outFile(), 'utf8'), /ACCURACY: non-inferior/);
  });

  test('the registered question file names the expected questions: a question with no rows at all is listed as missing', async () => {
    const question = (id: string, category: string, key: object): object => ({ id, category, text: `question ${id}`, key });
    const file = {
      corpusId: 'gsd-core',
      corpusSha: 'a'.repeat(40),
      questions: [
        question('q-1', 'callers', { kind: 'callers', symbol: 'foo', definedIn: 'src/a.ts', granularity: 'file', equality: 'exact-set' }),
        question('q-2', 'definition', { kind: 'definition', symbol: 'bar', granularity: 'file', equality: 'exact-set' }),
        question('q-3', 'definition', { kind: 'definition', symbol: 'baz', granularity: 'file', equality: 'exact-set' }),
      ],
    };
    const questionsPath = path.join(root, 'scripts', 'eval', 'questions', 'gsd-core.questions.json');
    fs.mkdirSync(path.dirname(questionsPath), { recursive: true });
    fs.writeFileSync(questionsPath, JSON.stringify(file));
    const prereg = writePrereg({ ...PREREG, questionSet: { count: 3, byCategory: { callers: 1, definition: 2 } } });
    const result = await invoke([writeResults(loadFixture()), '--prereg', prereg]);
    assert.equal(result.code, 2);
    for (const cell of ['q-3/atlas/1', 'q-3/atlas/2', 'q-3/grep/1', 'q-3/grep/2']) assert.match(result.err, new RegExp(cell));
    const wrongCount = writePrereg({ ...PREREG, questionSet: { count: 2, byCategory: { callers: 1, definition: 1 } } });
    const mismatch = await invoke([writeResults(loadFixture()), '--prereg', wrongCount]);
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.err, /question set/i);
  });

  test('the registered citation rule decides: wilson_lower_bound fails 4 of 4 against 0.8', async () => {
    const prereg = writePrereg({ ...PREREG, params: { ...PREREG.params, citationJudgedOn: 'wilson_lower_bound' } });
    const result = await invoke([writeResults(loadFixture()), '--prereg', prereg, '--out', outFile()]);
    assert.equal(result.code, 0);
    assert.match(fs.readFileSync(outFile(), 'utf8'), /CITATIONS: below threshold/);
  });

  test('incomplete run exits 2, lists the missing cell and writes a report without a verdict', async () => {
    const rows = loadFixture().filter((row) => !(row.questionId === 'q-2' && row.arm === 'grep' && row.run === 2));
    const result = await invoke([writeResults(rows), '--prereg', writePrereg(PREREG), '--out', outFile()]);
    assert.equal(result.code, 2);
    assert.match(result.err, /incomplete/i);
    assert.match(result.err, /q-2\/grep\/2/);
    const report = fs.readFileSync(outFile(), 'utf8');
    assert.match(report, /INCOMPLETE/);
    assert.doesNotMatch(report, /MVP met/);
  });

  test('a prereg without citationJudgedOn is invalid: exit 2 and an error naming the field', async () => {
    const { citationJudgedOn: _omitted, ...rest } = PREREG.params;
    const result = await invoke([writeResults(loadFixture()), '--prereg', writePrereg({ ...PREREG, params: rest })]);
    assert.equal(result.code, 2);
    assert.match(result.err, /params\.citationJudgedOn/);
  });

  test('a question set that disagrees with the registered count exits 2', async () => {
    const result = await invoke([
      writeResults(loadFixture()),
      '--prereg',
      writePrereg({ ...PREREG, questionSet: { count: 3, byCategory: { callers: 2, definition: 1 } } }),
    ]);
    assert.equal(result.code, 2);
    assert.match(result.err, /question/i);
  });

  test('a Frozen prereg that does not verify exits 2 and no verdict is written', async () => {
    const result = await invoke([writeResults(loadFixture()), '--prereg', writePrereg({ ...PREREG, status: 'Frozen' }), '--out', outFile()]);
    assert.equal(result.code, 2);
    assert.match(result.err, /verif/i);
    assert.equal(fs.existsSync(outFile()), false);
  });

  test('a results line that is not a valid row exits 2 and names the line', async () => {
    const file = path.join(root, 'results.jsonl');
    const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
    lines[2] = '{"questionId": "q-1"}';
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const result = await invoke([file, '--prereg', writePrereg(PREREG)]);
    assert.equal(result.code, 2);
    assert.match(result.err, /line 3/);
  });

  test('a duplicate cell in the results exits 2', async () => {
    const rows = [...loadFixture(), loadFixture()[0] as ResultRow];
    const result = await invoke([writeResults(rows), '--prereg', writePrereg(PREREG)]);
    assert.equal(result.code, 2);
    assert.match(result.err, /duplicate/i);
  });

  test('without --out the report goes to the output sink', async () => {
    const result = await invoke([writeResults(loadFixture()), '--prereg', writePrereg(PREREG)]);
    assert.equal(result.code, 0);
    assert.match(result.out, /OVERALL: MVP met/);
  });

  test('usage errors exit 2: no results path, an unknown flag, a missing results file', async () => {
    assert.equal((await invoke([])).code, 2);
    assert.equal((await invoke(['--nope'])).code, 2);
    assert.equal((await invoke([path.join(root, 'absent.jsonl'), '--prereg', writePrereg(PREREG)])).code, 2);
  });
});
