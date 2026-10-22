import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildClaudeArgs } from '../eval/claude-session.ts';
import {
  CONDITIONS,
  PREMISE,
  answerFromStream,
  authOk,
  buildSchedule,
  calibrationBatch,
  calibrationSummary,
  chunkCheck,
  chunkSchedule,
  closedBookJobs,
  closedBookSpec,
  compareAnswer,
  parseCap,
  renderDryRun,
  resolveConcurrency,
  type PilotRecord,
} from './pilot-plan.ts';

const QIDS = Array.from({ length: 16 }, (_, i) => `p-${String(201 + i)}`);
const CATS: Record<string, string> = Object.fromEntries(QIDS.map((id, i) => [id, i < 5 ? 'callers' : i < 8 ? 'references' : i < 11 ? 'heritage' : i < 13 ? 'impact' : i < 15 ? 'definition' : 'abstain']));
const QUESTIONS = QIDS.map((id) => ({ id, category: CATS[id]! }));

describe('buildSchedule', () => {
  it('is 16 questions x 3 conditions x 2 runs = 96 sessions, one adjacent group of three per (question, run)', () => {
    const jobs = buildSchedule(QIDS);
    assert.equal(jobs.length, 96);
    assert.deepEqual(CONDITIONS.map((c) => [c.id, c.config]), [['G', 'grep'], ['A-ts', 'atlas-noskill-ts'], ['A-reg', 'atlas']]);
    assert.equal(new Set(jobs.map((j) => j.jobId)).size, 96);
    for (let g = 0; g < 32; g += 1) {
      const triple = jobs.slice(g * 3, g * 3 + 3);
      assert.equal(new Set(triple.map((j) => `${j.questionId}|${String(j.run)}`)).size, 1);
      assert.deepEqual(triple.map((j) => j.condition).sort(), ['A-reg', 'A-ts', 'G']);
      assert.ok(triple.every((j) => j.group === g));
    }
  });
  it('is a pure function of the seed (default 20261021)', () => {
    const a = buildSchedule(QIDS).map((j) => j.jobId);
    assert.deepEqual(a, buildSchedule([...QIDS]).map((j) => j.jobId));
    assert.notDeepEqual(a, buildSchedule(QIDS, { seed: 1 }).map((j) => j.jobId));
    assert.match(a[0]!, /^ang-(G|A-ts|A-reg)-p-\d+-r[12]$/);
  });
});

describe('chunkSchedule', () => {
  it('chunks of at most 16 sessions made of whole groups (5 groups = 15 sessions)', () => {
    const chunks = chunkSchedule(buildSchedule(QIDS), 16);
    assert.deepEqual(chunks.map((c) => c.length), [15, 15, 15, 15, 15, 15, 6]);
    for (const c of chunks) assert.equal(c.length % 3, 0);
    assert.equal(chunks.flat().length, 96);
  });
});

describe('calibrationBatch', () => {
  it('is 4 questions x 3 conditions x 1 run = 12 sessions: two callers, one references, one heritage', () => {
    const b = calibrationBatch(QUESTIONS);
    assert.equal(b.jobs.length, 12);
    assert.equal(b.questionIds.length, 4);
    assert.deepEqual(b.questionIds.map((id) => CATS[id]).sort(), ['callers', 'callers', 'heritage', 'references']);
    assert.ok(b.jobs.every((j) => j.run === 1 && j.jobId.startsWith('cal-')));
    assert.deepEqual(b.jobs.map((j) => j.jobId), calibrationBatch(QUESTIONS).jobs.map((j) => j.jobId));
    assert.ok(b.measures.length >= 3);
  });
});

describe('closed-book control', () => {
  it('is the 16 questions once, with no tools, no MCP server and no skill', () => {
    const jobs = closedBookJobs(QIDS);
    assert.equal(jobs.length, 16);
    assert.ok(jobs.every((j) => j.jobId.startsWith('cb-')));
    const spec = closedBookSpec({ mcpConfigPath: '/x/mcp.json', answerSchema: '{}', model: 'claude-sonnet-5-5', maxBudgetUsd: 0.5, wallClockMs: 1000 });
    const args = buildClaudeArgs({ ...spec, prompt: 'q', cwd: '/tmp/empty' });
    const at = args.indexOf('--tools');
    assert.equal(args[at + 1], '');
    assert.ok(!args.join(' ').includes('Bash'));
    assert.ok(!args.join(' ').includes('Read'));
    assert.ok(!args.includes('--allowedTools'));
    assert.ok(!args.includes('--plugin-dir'));
  });
});

describe('compareAnswer', () => {
  const key = (granularity: 'file' | 'file+symbol' | 'file+line', items: { file: string; line?: number; symbol?: string }[], abstain = false) => ({ abstain, granularity, items });
  it('file granularity: exact-set equality with matched, missing and extra counts', () => {
    const k = key('file', [{ file: 'a.ts', line: 1 }, { file: 'a.ts', line: 9 }, { file: 'b.ts' }]);
    assert.deepEqual(compareAnswer({ answer: 'found', items: [{ file: 'b.ts' }, { file: 'a.ts', line: 4 }] }, k), { equal: true, matched: 2, missing: 0, extra: 0, answered: 'found' });
    assert.deepEqual(compareAnswer({ answer: 'found', items: [{ file: 'a.ts' }, { file: 'c.ts' }] }, k), { equal: false, matched: 1, missing: 1, extra: 1, answered: 'found' });
  });
  it('file+symbol and file+line (slack of two lines)', () => {
    const s = key('file+symbol', [{ file: 'a.ts', symbol: 'Foo' }]);
    assert.equal(compareAnswer({ answer: 'found', items: [{ file: 'a.ts', symbol: 'Foo' }] }, s).equal, true);
    assert.equal(compareAnswer({ answer: 'found', items: [{ file: 'a.ts', symbol: 'Bar' }] }, s).equal, false);
    const l = key('file+line', [{ file: 'a.ts', line: 10 }]);
    assert.equal(compareAnswer({ answer: 'found', items: [{ file: 'a.ts', line: 12 }] }, l).equal, true);
    assert.equal(compareAnswer({ answer: 'found', items: [{ file: 'a.ts', line: 13 }] }, l).equal, false);
  });
  it('abstain: correct only for not_found with no items; not_found elsewhere is wrong', () => {
    const a = key('file', [], true);
    assert.equal(compareAnswer({ answer: 'not_found', items: [] }, a).equal, true);
    assert.equal(compareAnswer({ answer: 'found', items: [{ file: 'x.ts' }] }, a).equal, false);
    assert.equal(compareAnswer({ answer: 'not_found', items: [] }, key('file', [{ file: 'a.ts' }])).equal, false);
  });
});

describe('answerFromStream', () => {
  it('reads the structured output of the result event and strips the checkout root', () => {
    const text = [
      '{"type":"system","subtype":"init"}',
      JSON.stringify({ type: 'result', is_error: false, structured_output: { answer: 'found', items: [{ file: '/work/repo/a.ts', line: 3 }, { file: './b.ts' }], summary: 's' } }),
    ].join('\n');
    assert.deepEqual(answerFromStream(text, ['/work/repo']), { answer: 'found', items: [{ file: 'a.ts', line: 3 }, { file: 'b.ts' }] });
    assert.equal(answerFromStream('{"type":"result","result":"no json"}', []), null);
    assert.deepEqual(answerFromStream(JSON.stringify({ type: 'result', result: '{"answer":"not_found","items":[],"summary":""}' }), []), { answer: 'not_found', items: [] });
  });
});

const rec = (over: Partial<PilotRecord> = {}): PilotRecord => ({
  jobId: 'ang-G-p-201-r1',
  condition: 'G',
  status: 'ok',
  claudeCodeVersion: '2.1.305',
  apiKeySource: 'none',
  initMcpToolCount: 0,
  atlasCalls: 0,
  usage: { billable: 70000 },
  costUsd: 0.1,
  rate: { fiveHour: 0.2, sevenDay: 0.15, isUsingOverage: false, overageStatus: 'rejected' },
  ...over,
});
const ctx = { capUsd: 4, spentBefore: 0, nextMaxUsd: 1.5, expectedVersion: '2.1.305' };

describe('chunkCheck', () => {
  it('passes a clean chunk', () => {
    assert.deepEqual(chunkCheck([rec(), rec({ condition: 'A-ts', initMcpToolCount: 7, atlasCalls: 2 })], ctx), { stop: false, reasons: [], infraFailures: 0, spentUsd: 0.2 });
  });
  it('stops on any infrastructure failure', () => {
    const r = chunkCheck([rec(), rec({ status: 'no_result/ok' })], ctx);
    assert.equal(r.stop, true);
    assert.equal(r.infraFailures, 1);
    assert.match(r.reasons.join(' '), /infrastructure/);
  });
  it('stops at 0.60 on either rate-limit window, not below', () => {
    assert.equal(chunkCheck([rec({ rate: { fiveHour: 0.59, sevenDay: 0.59, isUsingOverage: false, overageStatus: 'rejected' } })], ctx).stop, false);
    assert.equal(chunkCheck([rec({ rate: { fiveHour: 0.6, sevenDay: 0.1, isUsingOverage: false, overageStatus: 'rejected' } })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ rate: { fiveHour: 0.1, sevenDay: 0.61, isUsingOverage: false, overageStatus: 'rejected' } })], ctx).stop, true);
  });
  it('stops unless overage is off and rejected in every reading, and when there is no reading at all', () => {
    assert.equal(chunkCheck([rec({ rate: { fiveHour: 0.1, sevenDay: 0.1, isUsingOverage: true, overageStatus: 'rejected' } })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ rate: { fiveHour: 0.1, sevenDay: 0.1, isUsingOverage: false, overageStatus: 'allowed' } })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ rate: { fiveHour: null, sevenDay: null, isUsingOverage: null, overageStatus: null } })], ctx).stop, true);
  });
  it('stops on an API key, a different Claude Code version, or a condition that differs from its environment', () => {
    assert.equal(chunkCheck([rec({ apiKeySource: 'ANTHROPIC_API_KEY' })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ apiKeySource: null })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ claudeCodeVersion: '2.1.302' })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ atlasCalls: 1 })], ctx).stop, true);
    assert.equal(chunkCheck([rec({ condition: 'A-reg', initMcpToolCount: 0 })], ctx).stop, true);
  });
  it('stops when the next session could pass the notional cap', () => {
    assert.equal(chunkCheck([rec()], { ...ctx, spentBefore: 2.5 }).stop, true);
    assert.equal(chunkCheck([rec()], { ...ctx, spentBefore: 2.3 }).stop, false);
  });
});

describe('authOk', () => {
  it('accepts only the four-field subscription filter', () => {
    const ok = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };
    assert.equal(authOk(ok), true);
    assert.equal(authOk({ ...ok, loggedIn: false }), false);
    assert.equal(authOk({ ...ok, authMethod: 'api_key' }), false);
    assert.equal(authOk({ ...ok, apiProvider: 'bedrock' }), false);
    assert.equal(authOk({ ...ok, subscriptionType: 'pro' }), false);
    assert.equal(authOk(null), false);
  });
});

describe('parseCap and resolveConcurrency', () => {
  it('the notional cap defaults low and is raised only explicitly, never above the 30 USD ceiling', () => {
    assert.equal(parseCap(undefined), 4);
    assert.equal(parseCap('12.5'), 12.5);
    assert.throws(() => parseCap('31'), /ceiling/);
    assert.throws(() => parseCap('0'), /positive/);
    assert.throws(() => parseCap('lots'), /number/);
  });
  it('runs sequentially, or 2 at a time only for a grep-only chunk', () => {
    const jobs = buildSchedule(QIDS);
    assert.equal(resolveConcurrency(1, jobs.slice(0, 3)), 1);
    assert.equal(resolveConcurrency(2, jobs.slice(0, 3)), 1);
    assert.equal(resolveConcurrency(2, jobs.filter((j) => j.condition === 'G').slice(0, 4)), 2);
    assert.throws(() => resolveConcurrency(3, jobs), /1 or 2/);
  });
});

describe('calibrationSummary', () => {
  it('measures grep mean billable tokens against the premise floor, the atlas call rate and the allowance readings', () => {
    const recs = [
      rec({ jobId: 'cal-G-a', usage: { billable: 100000 }, costUsd: 0.5, rate: { fiveHour: 0.1, sevenDay: 0.1, isUsingOverage: false, overageStatus: 'rejected' } }),
      rec({ jobId: 'cal-G-b', usage: { billable: 80000 }, costUsd: 0.5 }),
      rec({ jobId: 'cal-A-ts-a', condition: 'A-ts', initMcpToolCount: 7, atlasCalls: 0, costUsd: 0.4 }),
      rec({ jobId: 'cal-A-ts-b', condition: 'A-ts', initMcpToolCount: 7, atlasCalls: 3, costUsd: 0.4 }),
      rec({ jobId: 'cal-A-reg-a', condition: 'A-reg', initMcpToolCount: 7, atlasCalls: 2, costUsd: 0.4, rate: { fiveHour: 0.14, sevenDay: 0.12, isUsingOverage: false, overageStatus: 'rejected' } }),
    ];
    const s = calibrationSummary(recs);
    assert.equal(s.grepMeanBillable, 90000);
    assert.equal(s.premise, 'holds');
    assert.equal(s.stopLineExceeded, false);
    assert.deepEqual(s.atlasCallRate, { 'A-ts': 0.5, 'A-reg': 1 });
    assert.equal(s.spentUsd, 2.2);
    assert.deepEqual([s.rate.firstFiveHour, s.rate.lastFiveHour, s.rate.firstSevenDay, s.rate.lastSevenDay], [0.1, 0.14, 0.1, 0.12]);
    assert.equal(calibrationSummary([rec({ usage: { billable: 54000 } })]).premise, 'failed');
    assert.equal(calibrationSummary([rec({ usage: { billable: 60000 } })]).premise, 'between');
    assert.equal(calibrationSummary([rec({ usage: { billable: 200000 } })]).stopLineExceeded, true);
    assert.equal(PREMISE.floorBillable, 68000);
  });
});

describe('renderDryRun', () => {
  const text = renderDryRun({ questions: QUESTIONS, capUsd: 4, concurrency: 1, model: 'claude-sonnet-5-5', claudeVersion: '2.1.305' });
  it('prints the schedule, the chunks, the calibration batch, the closed-book control and the commands, and launches nothing', () => {
    assert.match(text, /DRY RUN: no session is launched/);
    assert.equal(text.split('\n').filter((l) => /^\s+\d{3}\s+ang-(G|A-ts|A-reg)-p-\d+-r[12]\s/.test(l)).length, 96);
    assert.equal(text.split('\n').filter((l) => /^chunk \d+ of 7/.test(l)).length, 7);
    assert.equal(text.split('\n').filter((l) => /^\s+\d{2}\s+cal-/.test(l)).length, 12);
    assert.equal(text.split('\n').filter((l) => /^\s+\d{2}\s+cb-/.test(l)).length, 16);
  });
  it('shows the command of each condition with the isolation flags, nice, the per-session budget and the closed-book form', () => {
    for (const label of ['G', 'A-ts', 'A-reg', 'closed-book']) assert.match(text, new RegExp(`command ${label}:\\s+nice -n 10 claude -p --output-format stream-json`));
    assert.match(text, /--setting-sources ''/);
    assert.match(text, /--max-budget-usd 1\.5/);
    assert.match(text, /--tools '' /);
    assert.match(text, /--tools Bash,Read,ToolSearch/);
    assert.match(text, /--model claude-sonnet-5-5/);
  });
  it('states the guards: cap, 0.60 stop, overage, API key, auth filter, concurrency', () => {
    assert.match(text, /notional cap 4\.00 USD/);
    assert.match(text, /0\.60/);
    assert.match(text, /overage/);
    assert.match(text, /no API key/);
    assert.match(text, /loggedIn true, authMethod claude\.ai, apiProvider firstParty, subscriptionType max/);
    assert.match(text, /concurrency 1/);
  });
});
