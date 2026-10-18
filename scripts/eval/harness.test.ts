import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ALLOWED_SHELL, ARMS, ATLAS_TOOL_NAMES, allowedToolsFor, buildPluginDir, checkInit, expectedToolSet } from './arms.ts';
import type { InitEvent } from './claude-session.ts';
import { buildPrompt, isInfrastructureFailure, runAll, runCell, runCli } from './harness.ts';
import type { CellDeps, Io } from './harness.ts';
import { STAGE_A_FILES, hashFile } from './prereg.ts';
import { ResultsStore } from './results.ts';
import { ResultRowSchema } from './rows.ts';
import type { ResultRow } from './rows.ts';
import { cellId, makeSchedule, partition } from './schedule.ts';
import type { Cell } from './schedule.ts';
import type { AnswerKey, Question } from './questions.ts';

// ---------------------------------------------------------------------------------------------
// Shared setup: the fakes, a two-question set built from the oracle fixture, scratch directories

const here = import.meta.dirname;
const fixtureDir = path.join(here, '__fixtures__');
const FAKE_CLAUDE = path.join(fixtureDir, 'fake-claude-answer.mjs');
const FAKE_ATLAS = path.join(fixtureDir, 'fake-atlas.mjs');
const CORPUS = path.join(fixtureDir, 'oracle-repo');
const SKILL = path.resolve(here, '..', '..', 'skills', 'gsd-atlas', 'SKILL.md');
const ANSWER_SCHEMA = JSON.stringify(JSON.parse(fs.readFileSync(path.join(here, 'answer-schema.json'), 'utf8')));

const Q1: Question = {
  id: 'q-1',
  category: 'definition',
  text: 'Where is the function compute defined?',
  key: { kind: 'definition', symbol: 'compute', definedIn: 'src/lib.cts', granularity: 'file+line', equality: 'exact-set' },
};
const Q2: Question = {
  id: 'q-2',
  category: 'definition',
  text: 'Where is the function helper defined?',
  key: { kind: 'definition', symbol: 'helper', definedIn: 'src/lib.cts', granularity: 'file+line', equality: 'exact-set' },
};
const keyFor = (question: Question, line: number, symbol: string): AnswerKey => ({
  questionId: question.id,
  kind: 'definition',
  abstain: false,
  items: [{ file: 'src/lib.cts', line, symbol }],
  granularity: 'file+line',
  equality: 'exact-set',
  needles: [symbol],
  unexplained: [],
  notes: {},
  oracleVersion: 'test',
});
const K1 = keyFor(Q1, 2, 'compute');
const K2 = keyFor(Q2, 15, 'helper');
const PERFECT: Record<string, unknown> = {
  [Q1.text]: { answer: 'found', items: [{ file: 'src/lib.cts', line: 2, symbol: 'compute' }], summary: 'compute is defined in src/lib.cts' },
  [Q2.text]: { answer: 'found', items: [{ file: 'src/lib.cts', line: 15, symbol: 'helper' }], summary: 'helper is defined in src/lib.cts' },
};

const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

interface Env {
  root: string;
  out: string;
  scratch: string;
  atlasRecord: string;
  eventsFile: string;
  store: ResultsStore;
  deps: CellDeps;
}

function makeEnv(fakeEnv: Record<string, string> = {}, overrides: Partial<CellDeps> = {}): Env {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harness-test-'));
  roots.push(root);
  const out = path.join(root, 'out');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const answersFile = path.join(root, 'answers.json');
  fs.writeFileSync(answersFile, JSON.stringify(PERFECT));
  const atlasRecord = path.join(root, 'atlas-record.jsonl');
  const eventsFile = path.join(root, 'events.jsonl');
  const store = new ResultsStore(out);
  const deps: CellDeps = {
    questions: new Map([[Q1.id, Q1], [Q2.id, Q2]]),
    keys: new Map([[K1.questionId, K1], [K2.questionId, K2]]),
    corpusDir: CORPUS,
    scratchRoot: scratch,
    store,
    atlasBin: FAKE_ATLAS,
    skillPath: SKILL,
    answerSchema: ANSWER_SCHEMA,
    model: 'fake-model',
    maxBudgetUsd: 1,
    wallClockMs: 20_000,
    claude: { executable: process.execPath, prefixArgs: [FAKE_CLAUDE] },
    env: {
      FAKE_ANSWERS_FILE: answersFile,
      FAKE_ATLAS_RECORD: atlasRecord,
      FAKE_EVENTS_FILE: eventsFile,
      ...fakeEnv,
    },
    ...overrides,
  };
  return { root, out, scratch, atlasRecord, eventsFile, store, deps };
}

const readLines = (file: string): unknown[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as unknown)
    : [];

interface AtlasCall {
  subcommand: string;
  args: string[];
  cwd: string;
  store: string;
  user: string;
}
const atlasCalls = (env: Env): AtlasCall[] => readLines(env.atlasRecord) as AtlasCall[];

interface MetaRecord {
  kind: string;
  cellId?: string;
  [key: string]: unknown;
}
const metaOf = (env: Env): MetaRecord[] => readLines(path.join(env.out, 'sessions.meta.jsonl')) as MetaRecord[];

/** The `result` event the fake printed, read back from the raw stream the harness kept. */
function resultEventOf(env: Env, id: string): Record<string, unknown> {
  const session = metaOf(env).find((m) => m.kind === 'session' && m.cellId === id);
  assert.ok(session !== undefined, `no session meta record for ${id}`);
  const streamPath = session['rawStreamPath'];
  assert.equal(typeof streamPath, 'string');
  const events = readLines(streamPath as string) as Array<Record<string, unknown>>;
  const result = events.find((e) => e['type'] === 'result');
  assert.ok(result !== undefined, 'no result event in the raw stream');
  return result;
}

const aRow = (over: Partial<ResultRow> = {}): ResultRow => ({
  questionId: 'q-1',
  category: 'definition',
  arm: 'atlas',
  run: 1,
  status: 'ok',
  answered: 'found',
  correct: true,
  citation: { applicable: true, total: 1, verified: 1, hasVerifiable: true },
  usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
  billableTokens: 10,
  toolCalls: 1,
  toolCallsByName: { Bash: 1 },
  atlasToolCalls: 0,
  wallMs: 5,
  costUsd: 0.01,
  ...over,
});

// ---------------------------------------------------------------------------------------------
// Task 1: the tracer

describe('ResultsStore', () => {
  it('appends exactly one validated line per row and nothing for an invalid row', () => {
    const env = makeEnv();
    env.store.append(aRow());
    const text = fs.readFileSync(path.join(env.out, 'results.jsonl'), 'utf8');
    assert.equal(text.split('\n').length, 2, 'one line and the empty tail after its newline');
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(ResultRowSchema.parse(JSON.parse(text)), aRow());
    assert.throws(() => env.store.append(aRow({ questionId: 'q-2', billableTokens: 11 })));
    assert.equal(readLines(path.join(env.out, 'results.jsonl')).length, 1);
    assert.equal(env.store.has(cellId(aRow())), true);
    assert.equal(env.store.has('q-2|atlas|1'), false);
  });

  it('refuses to append a cell that already has a row', () => {
    const env = makeEnv();
    env.store.append(aRow());
    assert.throws(() => env.store.append(aRow()), /already has a row/);
    assert.equal(env.store.all().length, 1);
  });

  it('drops an incomplete final line when it opens, so the next append cannot join it', () => {
    const env = makeEnv();
    env.store.append(aRow());
    const file = path.join(env.out, 'results.jsonl');
    fs.appendFileSync(file, '{"questionId":"q-2","category":"defi'); // a write cut off mid-line
    const reopened = new ResultsStore(env.out);
    assert.equal(reopened.all().length, 1);
    assert.equal(reopened.has('q-2|atlas|1'), false);
    reopened.append(aRow({ questionId: 'q-2' }));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2);
    for (const line of lines) ResultRowSchema.parse(JSON.parse(line));
  });
});

describe('runCell tracer', () => {
  it('one cell end to end: clone, build, session, score, one result line', async () => {
    const env = makeEnv();
    const cell = { questionId: 'q-1', arm: 'atlas', run: 1 } as const;
    const result = await runCell(cell, env.deps);
    assert.equal(result.outcome, 'done');
    const lines = readLines(path.join(env.out, 'results.jsonl'));
    assert.equal(lines.length, 1);
    const row = ResultRowSchema.parse(lines[0]);
    assert.equal(row.correct, true);
    assert.equal(row.status, 'ok');
    assert.equal(row.arm, 'atlas');
    assert.equal(row.billableTokens, row.usage.input + row.usage.output + row.usage.cacheCreation + row.usage.cacheRead);
    assert.equal(row.billableTokens, 100);
    assert.equal(row.toolCalls, 1);

    const calls = atlasCalls(env);
    assert.deepEqual(calls.map((c) => c.subcommand), ['build', 'maintain']);
    assert.equal(calls[1]?.args[0], 'resolve');
    const event = resultEventOf(env, cellId(cell));
    // The session ran in the clone, never in the prepared checkout.
    assert.equal(calls[0]?.cwd, event['fake_cwd'], 'the build and the session run in the same clone');
    assert.equal(event['fake_cwd'], path.join(env.scratch, 'q-1.atlas.1', 'repo'));
    assert.ok((event['fake_cwd'] as string).startsWith(env.scratch + path.sep));
    assert.notEqual(event['fake_cwd'], CORPUS);
    // The session directory is gone once the row is written.
    assert.deepEqual(fs.readdirSync(env.scratch), []);
  });

  it('second run skips the cell and appends nothing', async () => {
    const env = makeEnv();
    const cell = { questionId: 'q-1', arm: 'atlas', run: 1 } as const;
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    const buildsBefore = atlasCalls(env).length;
    const again = await runCell(cell, env.deps);
    assert.equal(again.outcome, 'skipped');
    assert.equal(readLines(path.join(env.out, 'results.jsonl')).length, 1);
    assert.equal(atlasCalls(env).length, buildsBefore, 'a skipped cell builds nothing');
    assert.equal(readLines(env.eventsFile).length, 2, 'a skipped cell starts no session (one start, one end)');
    // A new process sees the row on disk too.
    const reopened = new ResultsStore(env.out);
    assert.equal(reopened.has(cellId(cell)), true);
  });

  it('grep arm has no server: no build, an empty server map, no plugin', async () => {
    const env = makeEnv({}, { keepSessions: true });
    const cell = { questionId: 'q-1', arm: 'grep', run: 1 } as const;
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    assert.deepEqual(atlasCalls(env), [], 'the grep arm never builds an index');
    const sessionDir = path.join(env.scratch, 'q-1.grep.1');
    const config = JSON.parse(fs.readFileSync(path.join(sessionDir, 'mcp.json'), 'utf8')) as unknown;
    assert.deepEqual(config, { mcpServers: {} });
    const event = resultEventOf(env, cellId(cell));
    const argv = event['fake_argv'] as string[];
    assert.ok(!argv.includes('--plugin-dir'));
    assert.deepEqual(argv[argv.indexOf('--tools') + 1], 'Bash,Read');
    const row = ResultRowSchema.parse(readLines(path.join(env.out, 'results.jsonl'))[0]);
    assert.equal(row.atlasToolCalls, 0);
    assert.equal(row.arm, 'grep');
  });

  it('separate stores per cell: each cell has its own store and an empty user directory inside its session directory', async () => {
    const env = makeEnv({}, { keepSessions: true });
    const first = { questionId: 'q-1', arm: 'atlas', run: 1 } as const;
    const second = { questionId: 'q-2', arm: 'atlas', run: 1 } as const;
    const third = { questionId: 'q-1', arm: 'grep', run: 1 } as const;
    for (const cell of [first, second, third]) assert.equal((await runCell(cell, env.deps)).outcome, 'done');

    const builds = atlasCalls(env).filter((c) => c.subcommand === 'build');
    assert.equal(builds.length, 2);
    assert.notEqual(builds[0]?.store, builds[1]?.store);
    assert.notEqual(builds[0]?.user, builds[1]?.user);
    for (const [index, name] of ['q-1.atlas.1', 'q-2.atlas.1'].entries()) {
      const sessionDir = path.join(env.scratch, name);
      const call = builds[index];
      assert.ok(call?.store.startsWith(sessionDir + path.sep), `${name}: store inside the session directory`);
      assert.ok(call?.user.startsWith(sessionDir + path.sep), `${name}: user dir inside the session directory`);
      assert.deepEqual(fs.readdirSync(call?.user ?? ''), [], `${name}: no user configuration`);
      assert.ok(!(call?.store ?? '').startsWith(call?.cwd ?? '/nonexistent'), `${name}: the store is not inside the checkout the agent searches`);
    }
    const grepEnv = resultEventOf(env, cellId(third))['fake_env'] as { store: string; user: string };
    assert.notEqual(grepEnv.store, builds[0]?.store, 'the grep cell does not share the atlas cell store');
    assert.ok(grepEnv.store.startsWith(path.join(env.scratch, 'q-1.grep.1') + path.sep));
  });

  it('row survives cleanup failure: the failure is logged and the row is kept', async (t) => {
    if (process.platform === 'win32' || (process.getuid?.() ?? 1) === 0) {
      t.skip('read-only directories are not enforced here');
      return;
    }
    const env = makeEnv({ FAKE_LOCK_SESSION: '1' });
    const cell = { questionId: 'q-1', arm: 'grep', run: 1 } as const;
    const sessionDir = path.join(env.scratch, 'q-1.grep.1');
    try {
      assert.equal((await runCell(cell, env.deps)).outcome, 'done');
      assert.equal(readLines(path.join(env.out, 'results.jsonl')).length, 1, 'the row is written before the removal');
      assert.ok(fs.existsSync(sessionDir), 'the directory that could not be removed is still there');
      const failure = metaOf(env).find((m) => m.kind === 'cleanup_failed');
      assert.ok(failure !== undefined);
      assert.equal(failure.cellId, cellId(cell));
      assert.equal(typeof failure['error'], 'string');
    } finally {
      const locked = path.join(sessionDir, 'repo', 'src');
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
    }
  });

  it('prepMs and the raw stream path go to the meta sidecar, not to the result row', async () => {
    const env = makeEnv();
    const cell = { questionId: 'q-2', arm: 'atlas', run: 2 } as const;
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    const session = metaOf(env).find((m) => m.kind === 'session' && m.cellId === cellId(cell));
    assert.ok(session !== undefined);
    assert.equal(typeof session['prepMs'], 'number');
    assert.ok((session['prepMs'] as number) >= 0);
    assert.equal(fs.existsSync(session['rawStreamPath'] as string), true, 'the raw stream outlives the session directory');
    const row = readLines(path.join(env.out, 'results.jsonl'))[0] as Record<string, unknown>;
    assert.ok(!('prepMs' in row));
    assert.ok(!('rawStreamPath' in row));
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: the schedule

describe('schedule', () => {
  const ids = ['q-1', 'q-2', 'q-3'];

  it('schedule balanced: arms adjacent for every (question, run), both orders occur, no cell repeats', () => {
    const cells = makeSchedule(ids, ['atlas', 'grep'], 3, 42);
    assert.equal(cells.length, 18);
    assert.equal(new Set(cells.map((c) => cellId(c))).size, 18, 'no cell repeats');
    for (let i = 0; i < cells.length; i += 2) {
      const [a, b] = [cells[i] as Cell, cells[i + 1] as Cell];
      assert.equal(a.questionId, b.questionId);
      assert.equal(a.run, b.run);
      assert.notEqual(a.arm, b.arm);
    }
    // A larger input shows both orders of the pair, and neither dominates.
    const many = makeSchedule(Array.from({ length: 30 }, (_v, i) => `q-${String(i + 1)}`), ['atlas', 'grep'], 3, 42);
    let atlasFirst = 0;
    for (let i = 0; i < many.length; i += 2) if (many[i]?.arm === 'atlas') atlasFirst += 1;
    const pairs = many.length / 2;
    assert.ok(atlasFirst > pairs * 0.25 && atlasFirst < pairs * 0.75, `atlas first in ${String(atlasFirst)} of ${String(pairs)} pairs`);
    // The pairs themselves are shuffled: the schedule is not question by question.
    assert.notDeepEqual(many.slice(0, 6).map((c) => c.questionId), ['q-1', 'q-1', 'q-1', 'q-1', 'q-1', 'q-1']);
  });

  it('schedule deterministic: the same seed gives the same list and another seed another list', () => {
    const a = makeSchedule(ids, ['atlas', 'grep'], 3, 42).map(cellId);
    assert.deepEqual(makeSchedule(ids, ['atlas', 'grep'], 3, 42).map(cellId), a);
    assert.notDeepEqual(makeSchedule(ids, ['atlas', 'grep'], 3, 43).map(cellId), a);
  });

  it('rejects input that would make a wrong schedule', () => {
    assert.throws(() => makeSchedule(ids, ['atlas', 'grep'], 0, 1), RangeError);
    assert.throws(() => makeSchedule(['q-1', 'q-1'], ['atlas', 'grep'], 1, 1), RangeError);
    assert.throws(() => makeSchedule(ids, ['atlas', 'atlas'], 1, 1), RangeError);
    assert.throws(() => makeSchedule(ids, [], 1, 1), RangeError);
  });

  it('partition deals every cell to exactly one worker and keeps each worker in schedule order', () => {
    const cells = makeSchedule(ids, ['atlas', 'grep'], 3, 42);
    const lanes = partition(cells, 4);
    assert.equal(lanes.length, 4);
    assert.deepEqual(lanes.flat().map(cellId).sort(), cells.map(cellId).sort());
    for (const lane of lanes) {
      const positions = lane.map((cell) => cells.indexOf(cell));
      assert.deepEqual(positions, [...positions].sort((x, y) => x - y));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: the arms

const ATLAS_INIT = (over: Partial<InitEvent> = {}): InitEvent => ({
  tools: ['Bash', 'Read', 'mcp__gsd-atlas__code_find', 'mcp__gsd-atlas__code_refs'],
  mcpServers: [{ name: 'gsd-atlas', status: 'connected' }],
  skills: ['update-config', 'gsd-atlas-eval:gsd-atlas'],
  plugins: [],
  agents: [],
  model: 'm',
  cwd: '/x',
  ...over,
});
const GREP_INIT = (over: Partial<InitEvent> = {}): InitEvent => ({
  tools: ['Bash', 'Read'],
  mcpServers: [],
  skills: ['update-config'],
  plugins: [],
  agents: [],
  model: 'm',
  cwd: '/x',
  ...over,
});

describe('arms', () => {
  it('lists the read-only shell patterns and the seven atlas tools', () => {
    assert.ok(ALLOWED_SHELL.includes('Bash(rg:*)'));
    assert.ok(ALLOWED_SHELL.includes('Bash(git grep:*)'));
    assert.ok(ATLAS_TOOL_NAMES.includes('mcp__gsd-atlas__code_refs'));
    assert.equal(ATLAS_TOOL_NAMES.length, 7);
    for (const forbidden of ['Edit', 'Write', 'Task', 'WebSearch', 'WebFetch']) {
      assert.ok(!ARMS.atlas.builtinTools.includes(forbidden), `${forbidden} is not an eval tool`);
      assert.ok(!ARMS.grep.builtinTools.includes(forbidden));
    }
    assert.deepEqual(allowedToolsFor('grep').filter((t) => t.startsWith('mcp__')), []);
    assert.deepEqual(allowedToolsFor('atlas').filter((t) => t.startsWith('mcp__')), [...ATLAS_TOOL_NAMES]);
    // The two arms differ in exactly the atlas tools.
    assert.deepEqual(allowedToolsFor('atlas').filter((t) => !t.startsWith('mcp__')), allowedToolsFor('grep'));
  });

  it('expectedToolSet: Bash and Read exactly, a server only for the atlas arm', () => {
    assert.deepEqual(expectedToolSet('grep'), { tools: ['Bash', 'Read'], mcpServers: [] });
    assert.deepEqual(expectedToolSet('atlas'), { tools: ['Bash', 'Read'], mcpServers: ['gsd-atlas'] });
  });

  it('checkInit accepts the registered environments, including a subset of the atlas tools', () => {
    assert.deepEqual(checkInit('grep', GREP_INIT()), []);
    assert.deepEqual(checkInit('atlas', ATLAS_INIT()), []);
    assert.deepEqual(checkInit('atlas', ATLAS_INIT({ tools: ['Bash', 'Read', 'mcp__gsd-atlas__code_find'] })), []);
  });

  it('checkInit names every difference', () => {
    assert.deepEqual(checkInit('grep', null), ['init event absent']);
    assert.ok(checkInit('grep', GREP_INIT({ tools: ['Bash', 'Read', 'WebSearch'] })).includes('extra tool: WebSearch'));
    assert.ok(checkInit('grep', GREP_INIT({ tools: ['Bash'] })).includes('missing tool: Read'));
    assert.ok(checkInit('grep', GREP_INIT({ mcpServers: [{ name: 'codegraph', status: 'connected' }] })).includes('unexpected mcp server: codegraph'));
    assert.ok(checkInit('grep', GREP_INIT({ tools: ['Bash', 'Read', 'mcp__gsd-atlas__code_find'] })).includes('extra tool: mcp__gsd-atlas__code_find'));
    assert.ok(checkInit('grep', GREP_INIT({ skills: ['gsd-atlas-eval:gsd-atlas'] })).includes('unexpected skill: gsd-atlas'));
    assert.ok(checkInit('atlas', ATLAS_INIT({ mcpServers: [] })).includes('mcp server absent: gsd-atlas'));
    assert.ok(checkInit('atlas', ATLAS_INIT({ tools: ['Bash', 'Read'] })).includes('no atlas tool in the init event'));
    assert.ok(checkInit('atlas', ATLAS_INIT({ tools: [...ATLAS_INIT().tools, 'mcp__codegraph__codegraph_explore'] })).includes('extra tool: mcp__codegraph__codegraph_explore'));
    assert.ok(checkInit('atlas', ATLAS_INIT({ skills: ['update-config'] })).some((d) => d.startsWith('skill absent')));
  });

  it('buildPluginDir copies the skill byte for byte and refuses a skill whose hash differs', () => {
    const env = makeEnv();
    const dir = buildPluginDir(env.root, SKILL, hashFile(SKILL));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string };
    assert.equal(manifest.name, 'gsd-atlas-eval');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'skills', 'gsd-atlas', 'SKILL.md')), fs.readFileSync(SKILL));
    assert.throws(() => buildPluginDir(path.join(env.root, 'other'), SKILL, 'f'.repeat(64)), /registered/);
    assert.equal(fs.existsSync(path.join(env.root, 'other')), false, 'nothing is written for a refused skill');
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: failure and retry rules

const resultEvent = (over: Record<string, unknown> = {}): Parameters<typeof isInfrastructureFailure>[0] =>
  ({
    isError: true,
    subtype: 'success',
    text: 'API Error: 429 rate_limit_error',
    usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    totalCostUsd: 0,
    numTurns: 1,
    durationMs: 1,
    raw: { type: 'result' },
    ...over,
  }) as Parameters<typeof isInfrastructureFailure>[0];

describe('isInfrastructureFailure', () => {
  it('is true for a rate limit or an overload with no tool call', () => {
    assert.equal(isInfrastructureFailure(resultEvent(), 0), true);
    assert.equal(isInfrastructureFailure(resultEvent({ text: 'Overloaded', raw: { api_error_status: 529 } }), 0), true);
    assert.equal(isInfrastructureFailure(resultEvent({ text: 'x', raw: { api_error_status: 429 } }), 0), true);
  });
  it('is false once a tool was called, for a session that did not fail, for other errors and for no result', () => {
    assert.equal(isInfrastructureFailure(resultEvent(), 1), false);
    assert.equal(isInfrastructureFailure(resultEvent({ isError: false }), 0), false);
    assert.equal(isInfrastructureFailure(resultEvent({ text: 'budget exceeded', subtype: 'error_max_budget_usd' }), 0), false);
    assert.equal(isInfrastructureFailure(resultEvent({ text: 'error during execution' }), 0), false);
    assert.equal(isInfrastructureFailure(null, 0), false);
  });
});

describe('runCell failure rules', () => {
  const cell = { questionId: 'q-1', arm: 'grep', run: 1 } as const;
  const attemptsOf = (env: Env): MetaRecord[] => readLines(path.join(env.out, 'attempts.jsonl')) as MetaRecord[];
  const rowsOf = (env: Env): ResultRow[] => readLines(path.join(env.out, 'results.jsonl')).map((r) => ResultRowSchema.parse(r));

  it('contaminated init: the difference is stored, nothing is scored', async () => {
    const env = makeEnv({ FAKE_INIT_EXTRA_TOOLS: '["WebSearch"]' });
    const result = await runCell(cell, env.deps);
    assert.equal(result.outcome, 'contaminated');
    assert.ok(result.diffs?.includes('extra tool: WebSearch'));
    assert.deepEqual(rowsOf(env), []);
    const record = metaOf(env).find((m) => m.kind === 'contaminated');
    assert.ok(record !== undefined);
    assert.equal(record.cellId, cellId(cell));
    assert.ok((record['diffs'] as string[]).includes('extra tool: WebSearch'));
    assert.equal(env.store.has(cellId(cell)), false, 'the cell has no row and runs again after the fix');
  });

  it('a missing init event is contamination too', async () => {
    const env = makeEnv({ FAKE_NO_INIT: '1' });
    const result = await runCell(cell, env.deps);
    assert.equal(result.outcome, 'contaminated');
    assert.deepEqual(result.diffs, ['init event absent']);
  });

  it('garbage not retried: an unparseable answer is a final incorrect row', async () => {
    const env = makeEnv({ FAKE_ANSWER_MODE: 'garbage' });
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    const [row] = rowsOf(env);
    assert.equal(row?.correct, false);
    assert.equal(row?.answered, 'none');
    assert.equal(row?.status, 'ok');
    assert.equal(attemptsOf(env).length, 1, 'one attempt, no retry');
  });

  it('a wrong answer and a gave-up answer are final incorrect rows', async () => {
    for (const mode of ['wrong', 'not_found']) {
      const env = makeEnv({ FAKE_ANSWER_MODE: mode });
      assert.equal((await runCell(cell, env.deps)).outcome, 'done');
      assert.equal(rowsOf(env)[0]?.correct, false);
      assert.equal(attemptsOf(env).length, 1);
    }
  });

  it('a timeout is a final incorrect row that keeps the tokens it used', async () => {
    const env = makeEnv({ FAKE_ANSWER_MODE: 'timeout' }, { wallClockMs: 1_500 });
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    const [row] = rowsOf(env);
    assert.equal(row?.status, 'timeout');
    assert.equal(row?.correct, false);
    assert.equal(row?.billableTokens, 10, 'the usage of the one assistant message in the stream');
    assert.equal(row?.costUsd, null);
    assert.equal(attemptsOf(env).length, 1, 'a session that reached the model is never retried');
  });

  it('ratelimit retried twice: three attempts, each logged, then a final error row', async () => {
    const waits: number[] = [];
    const env = makeEnv(
      { FAKE_ANSWER_MODE: 'ratelimit' },
      { retryDelayMs: 7, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } },
    );
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    const attempts = attemptsOf(env);
    assert.deepEqual(attempts.map((a) => a['attempt']), [1, 2, 3]);
    assert.deepEqual(attempts.map((a) => a['retried']), [true, true, false]);
    assert.ok(attempts.every((a) => a['infrastructureFailure'] === true && a.cellId === cellId(cell)));
    assert.deepEqual(waits, [7, 7], 'the delay applies before each retry only');
    const rows = rowsOf(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'error');
    assert.equal(rows[0]?.correct, false);
    assert.equal(readLines(path.join(env.out, 'sessions.meta.jsonl')).filter((m) => (m as MetaRecord).kind === 'session').length, 3);
  });

  it('a rate limit that clears is retried into a normal row', async () => {
    const env = makeEnv(
      { FAKE_FAIL_FIRST: '1', FAKE_COUNTER_FILE: path.join(os.tmpdir(), `fake-counter-${String(process.pid)}-${String(Date.now())}`) },
      { retryDelayMs: 0, sleep: () => Promise.resolve() },
    );
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    assert.deepEqual(attemptsOf(env).map((a) => a['retried']), [true, false]);
    const [row] = rowsOf(env);
    assert.equal(row?.status, 'ok');
    assert.equal(row?.correct, true);
  });

  it('an error after at least one tool call is final immediately', async () => {
    const env = makeEnv({ FAKE_ANSWER_MODE: 'ratelimit-after-tool' }, { retryDelayMs: 0, sleep: () => Promise.reject(new Error('must not wait')) });
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    assert.equal(attemptsOf(env).length, 1);
    const [row] = rowsOf(env);
    assert.equal(row?.status, 'error');
    assert.equal(row?.toolCalls, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: concurrency and the run loop

describe('runAll', () => {
  const overlap = (eventsFile: string): number => {
    let live = 0;
    let max = 0;
    for (const e of readLines(eventsFile) as Array<{ kind: string }>) {
      live += e.kind === 'start' ? 1 : -1;
      max = Math.max(max, live);
    }
    return max;
  };

  it('concurrency bound: never more than two sessions at once, every cell has its own directories, ten complete lines', async () => {
    const env = makeEnv({ FAKE_DELAY_MS: '150' }, { keepSessions: true });
    const cells = makeSchedule(['q-1', 'q-2'], ['atlas', 'grep'], 3, 5).slice(0, 10);
    const summary = await runAll({ cells, concurrency: 2, deps: env.deps });
    assert.equal(summary.done, 10);
    assert.equal(summary.stopped, false);
    assert.equal(overlap(env.eventsFile), 2, 'two sessions overlap, never three');
    const text = fs.readFileSync(path.join(env.out, 'results.jsonl'), 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.equal(text.split('\n').filter((l) => l !== '').length, 10);
    assert.equal(new Set(env.store.all().map(cellId)).size, 10);
    assert.equal(fs.readdirSync(env.scratch).length, 10, 'one session directory per cell');
    const stores = atlasCalls(env).filter((c) => c.subcommand === 'build').map((c) => c.store);
    assert.equal(new Set(stores).size, stores.length, 'no two atlas cells share a store');
    for (const store of stores) assert.ok(store.startsWith(env.scratch + path.sep));
  });

  it('a rerun of the same schedule runs nothing and reports every cell skipped', async () => {
    const env = makeEnv();
    const cells = makeSchedule(['q-1', 'q-2'], ['atlas', 'grep'], 1, 5);
    assert.equal((await runAll({ cells, concurrency: 2, deps: env.deps })).done, 4);
    const again = await runAll({ cells, concurrency: 2, deps: env.deps });
    assert.equal(again.done, 0);
    assert.equal(again.skipped, 4);
    assert.equal(env.store.all().length, 4);
  });

  it('contaminated init stops scheduling, lets the cells in flight finish and scores none', async () => {
    for (const concurrency of [1, 2]) {
      const env = makeEnv({ FAKE_INIT_EXTRA_SERVERS: '["codegraph"]', FAKE_DELAY_MS: '100' });
      const cells = makeSchedule(['q-1', 'q-2'], ['atlas', 'grep'], 3, 5);
      const summary = await runAll({ cells, concurrency, deps: env.deps });
      assert.equal(summary.stopped, true);
      assert.ok(summary.contaminated.length >= 1 && summary.contaminated.length <= concurrency);
      assert.ok(summary.contaminated[0]?.diffs.includes('unexpected mcp server: codegraph'));
      assert.equal(env.store.all().length, 0);
      const started = (readLines(env.eventsFile) as Array<{ kind: string }>).filter((e) => e.kind === 'start').length;
      assert.ok(started <= concurrency, `${String(started)} sessions started with concurrency ${String(concurrency)}`);
    }
  });

  it('a failed index build stops the run and is reported, not scored', async () => {
    const env = makeEnv({ FAKE_ATLAS_BUILD_EXIT: '3' });
    const cells: Cell[] = [{ questionId: 'q-1', arm: 'atlas', run: 1 }, { questionId: 'q-2', arm: 'atlas', run: 1 }];
    const summary = await runAll({ cells, concurrency: 1, deps: env.deps });
    assert.equal(summary.stopped, true);
    assert.equal(summary.prepFailed.length, 1);
    assert.match(summary.prepFailed[0]?.detail ?? '', /gsd-atlas build exited 3/);
    assert.equal(env.store.all().length, 0);
    assert.equal(readLines(env.eventsFile).length, 0, 'no session starts after a failed build');
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: the command line, the prompt and the scored-run gate

const SHA = 'a'.repeat(40);

function writeQuestionFiles(root: string): { questions: string; answers: string } {
  const questions = path.join(root, 'questions.json');
  const answers = path.join(root, 'answers.json');
  fs.writeFileSync(questions, JSON.stringify({ corpusId: 'fixture', corpusSha: SHA, questions: [Q1, Q2] }));
  fs.writeFileSync(answers, JSON.stringify({ oracleVersion: 'test', repoSha: SHA, answers: [K1, K2] }));
  return { questions, answers };
}

interface Captured {
  io: Io;
  out: () => string;
  err: () => string;
}
function capture(): Captured {
  let out = '';
  let err = '';
  return { io: { out: (t) => { out += t; }, err: (t) => { err += t; } }, out: () => out, err: () => err };
}

interface Registered {
  root: string;
  prereg: string;
  skill: string;
}

/** A repository root with every Stage A file, a skill and a Frozen Stage B registration of them. */
function makeRegistered(options: { status?: 'Draft' | 'Frozen'; stage?: 'A' | 'B'; model?: string } = {}): Registered {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harness-reg-'));
  roots.push(root);
  for (const rel of STAGE_A_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `// registered ${rel}\n`);
  }
  const skill = path.join(root, 'skills', 'gsd-atlas', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'The registered skill.\n');
  const files = Object.fromEntries(STAGE_A_FILES.map((rel) => [rel, hashFile(path.join(root, rel))]));
  const stage = options.stage ?? 'B';
  const block = {
    stage,
    status: options.status ?? 'Frozen',
    params: {
      marginPoints: 5,
      intervalLevel: 0.95,
      resamples: 10000,
      seed: 20261017,
      runsPerCell: 3,
      citationRate: 0.8,
      citationJudgedOn: 'point_estimate',
      wilsonZ: 1.96,
      tokenCriterion: 'point',
      failureRule: 'incorrect-keep-tokens',
      concurrency: 2,
      maxBudgetUsdPerSession: 1,
      sessionWallClockMs: 20000,
      model: options.model ?? 'fake-model',
      claudeVersion: '2.1.302',
      corpusSha: SHA,
      npmCiRan: true,
    },
    files,
    questionSet: { count: 2, byCategory: { definition: 2 } },
    ...(stage === 'B' ? { stageB: { skillSha256: hashFile(skill), atlasCommit: 'b'.repeat(40) } } : {}),
  };
  const prereg = path.join(root, 'docs', 'eval', 'preregistration.md');
  fs.mkdirSync(path.dirname(prereg), { recursive: true });
  fs.writeFileSync(prereg, `# Pre-registration\n\n\`\`\`prereg-json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`);
  return { root, prereg, skill };
}

describe('command line', () => {
  it('same prompt both arms: a fixed preamble line, a blank line, the question text, byte for byte', () => {
    const atlas = buildPrompt(Q1, 'atlas');
    const grep = buildPrompt(Q1, 'grep');
    assert.equal(Buffer.compare(Buffer.from(atlas), Buffer.from(grep)), 0);
    const [preamble, blank, ...rest] = atlas.split('\n');
    assert.ok((preamble ?? '').length > 0);
    assert.equal(blank, '');
    assert.equal(rest.join('\n'), Q1.text);
    // And what the session receives is exactly that text, in both arms.
    assert.notEqual(buildPrompt(Q2, 'atlas'), atlas);
  });

  it('the prompt that reaches each arm is the same text', async () => {
    const env = makeEnv();
    await runCell({ questionId: 'q-1', arm: 'atlas', run: 1 }, env.deps);
    await runCell({ questionId: 'q-1', arm: 'grep', run: 1 }, env.deps);
    const prompts = ['atlas', 'grep'].map((arm) => resultEventOf(env, `q-1|${arm}|1`)['fake_prompt']);
    assert.equal(prompts[0], prompts[1]);
    assert.equal(prompts[0], buildPrompt(Q1, 'atlas'));
  });

  it('plan prints the counts per arm, the first ten cells, the flags and the values it read, and starts nothing', async () => {
    const env = makeEnv();
    const files = writeQuestionFiles(env.root);
    const c = capture();
    const code = await runCli(['plan', '--questions', files.questions, '--runs', '1', '--arms', 'atlas,grep'], c.io, { env: env.deps.env ?? {} });
    assert.equal(code, 0, c.err());
    const text = c.out();
    assert.match(text, /cells: 4/);
    assert.match(text, /atlas: 2/);
    assert.match(text, /grep: 2/);
    for (const id of ['q-1|atlas|1', 'q-1|grep|1', 'q-2|atlas|1', 'q-2|grep|1']) assert.ok(text.includes(id), `${id} is listed`);
    assert.match(text, /first 10 cells/);
    assert.match(text, /seed: 20261017/);
    assert.match(text, /concurrency: 2/);
    assert.match(text, /no session started/);
    assert.equal(fs.existsSync(env.eventsFile), false);
    assert.equal(fs.existsSync(env.out) && fs.readdirSync(env.out).length > 0, false, 'plan writes no results');
  });

  it('pilot runs without a preregistration and writes under a pilot directory; a second start only skips', async () => {
    const env = makeEnv();
    const files = writeQuestionFiles(env.root);
    const outDir = path.join(env.root, 'cli-out');
    const argv = [
      'pilot', '--questions', files.questions, '--answers', files.answers, '--corpus-dir', CORPUS, '--out-dir', outDir,
      '--arms', 'atlas,grep', '--runs', '1', '--concurrency', '2', '--seed', '7', '--model', 'fake-model',
      '--max-budget-usd', '1', '--wall-clock-ms', '20000', '--atlas-bin', FAKE_ATLAS, '--skill', SKILL,
      '--scratch-dir', env.scratch, '--retry-delay-ms', '0', '--claude-executable', process.execPath, '--claude-prefix-arg', FAKE_CLAUDE,
    ];
    const deps = { repoRoot: path.join(env.root, 'no-such-root'), env: env.deps.env ?? {} };
    const first = capture();
    assert.equal(await runCli(argv, first.io, deps), 0, first.err());
    const results = path.join(outDir, 'pilot', 'results.jsonl');
    const rows = readLines(results).map((r) => ResultRowSchema.parse(r));
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.correct));
    const second = capture();
    assert.equal(await runCli(argv, second.io, deps), 0, second.err());
    assert.equal(readLines(results).length, 4, 'a restart does not repeat finished cells');
    assert.match(second.out(), /skipped: 4/);
  });

  it('run needs exactly one of --scored and --pilot', async () => {
    const env = makeEnv();
    const files = writeQuestionFiles(env.root);
    const c = capture();
    assert.equal(await runCli(['run', '--questions', files.questions], c.io, {}), 2);
    assert.match(c.err(), /--scored|--pilot/);
    const both = capture();
    assert.equal(await runCli(['run', '--scored', '--pilot', '--questions', files.questions], both.io, {}), 2);
  });
});

describe('scored gate', () => {
  const baseArgs = (env: Env, reg: Registered, extra: string[] = []): string[] => {
    const files = writeQuestionFiles(env.root);
    return [
      'run', '--scored', '--questions', files.questions, '--answers', files.answers, '--corpus-dir', CORPUS,
      '--out-dir', path.join(env.root, 'scored-out'), '--atlas-bin', FAKE_ATLAS, '--skill', reg.skill,
      '--prereg', reg.prereg, '--scratch-dir', env.scratch, ...extra,
    ];
  };
  // A path that finds no `claude`, so a gate that wrongly let a run through could not reach the real program.
  const depsFor = (env: Env, reg: Registered, over: Record<string, unknown> = {}) => ({
    repoRoot: reg.root,
    env: { ...(env.deps.env ?? {}), PATH: path.join(env.root, 'no-bin') },
    claudeVersion: () => Promise.resolve('2.1.302 (Claude Code)'),
    readPrepared: () => ({ sha: SHA, npmCi: true }),
    ...over,
  });
  const refuses = async (env: Env, reg: Registered, extra: string[] = [], over: Record<string, unknown> = {}): Promise<string> => {
    const c = capture();
    assert.equal(await runCli(baseArgs(env, reg, extra), c.io, depsFor(env, reg, over)), 2, c.err());
    assert.equal(fs.existsSync(env.eventsFile), false, 'no session started');
    assert.equal(fs.existsSync(path.join(env.root, 'scored-out')), false, 'no results directory was created');
    return c.err();
  };

  it('scored gate passes for a Frozen Stage B registration of the files on disk, and a dry run starts nothing', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    const c = capture();
    const code = await runCli(baseArgs(env, reg, ['--dry-run']), c.io, depsFor(env, reg));
    assert.equal(code, 0, c.err());
    assert.match(c.out(), /gate: ok/);
    assert.match(c.out(), /cells: 12/, 'runs per cell come from the registration');
    assert.match(c.out(), /seed: 20261017/);
    assert.match(c.out(), /model: fake-model/);
    assert.equal(fs.existsSync(path.join(env.root, 'scored-out')), false);
  });

  it('scored gate refuses a missing registration', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    fs.rmSync(reg.prereg);
    assert.match(await refuses(env, reg), /preregistration/);
  });

  it('scored gate refuses a Draft registration', async () => {
    const env = makeEnv();
    assert.match(await refuses(env, makeRegistered({ status: 'Draft' })), /Frozen/);
  });

  it('scored gate refuses a Stage A registration, which has no skill hash yet', async () => {
    const env = makeEnv();
    assert.match(await refuses(env, makeRegistered({ stage: 'A' })), /Stage B/);
  });

  it('scored gate refuses a registered file that changed', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    fs.appendFileSync(path.join(reg.root, 'scripts', 'eval', 'harness.ts'), '// edited after the freeze\n');
    assert.match(await refuses(env, reg), /changed file: scripts\/eval\/harness\.ts/);
  });

  it('scored gate refuses a skill whose hash differs from the Stage B hash', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    fs.writeFileSync(reg.skill, 'A different skill.\n');
    assert.match(await refuses(env, reg), /skill/i);
  });

  it('scored gate refuses flags that differ from the registration and a fake claude', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    assert.match(await refuses(env, reg, ['--model', 'another-model']), /model/);
    assert.match(await refuses(env, reg, ['--runs', '2']), /runs/);
    assert.match(await refuses(env, reg, ['--claude-executable', process.execPath]), /claude-executable/);
  });

  it('scored gate refuses another Claude Code version or a checkout prepared at another commit', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    assert.match(await refuses(env, reg, [], { claudeVersion: () => Promise.resolve('9.9.9 (Claude Code)') }), /2\.1\.302/);
    assert.match(await refuses(env, reg, [], { readPrepared: () => ({ sha: 'c'.repeat(40), npmCi: true }) }), /sha/i);
  });

  it('scored gate refuses to write into a pilot directory', async () => {
    const env = makeEnv();
    const reg = makeRegistered();
    const c = capture();
    const argv = baseArgs(env, reg).map((a) => (a.endsWith('scored-out') ? path.join(env.root, 'pilot') : a));
    assert.equal(await runCli(argv, c.io, depsFor(env, reg)), 2);
    assert.match(c.err(), /pilot/);
  });
});

// <<tests-continue>>
