import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  ALLOWED_SHELL,
  ARMS,
  ATLAS_SETTINGS,
  ATLAS_TOOL_NAMES,
  PLUGIN_NAME,
  SKILL_NAME,
  allowedToolsFor,
  buildPluginDir,
  checkInit,
  expectedToolSet,
} from './arms.ts';
import type { InitEvent } from './claude-session.ts';
import { ATLAS_BUILD_INPUTS, buildPrompt, checkAtlasBuild, isInfrastructureFailure, runAll, runCell, runCli, runningCostUsd } from './harness.ts';
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
  const answersFile = path.join(root, 'fake-answers.json');
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

  it('Skill tool tracer (atlas): the argv carries the Skill tool and its one allow rule, the init event lists it, a Skill call lands in the row', async () => {
    const env = makeEnv({ FAKE_TOOL_NAMES: JSON.stringify(['Skill', 'mcp__gsd-atlas__code_find', 'Bash']) }, { keepSessions: true });
    const cell = { questionId: 'q-1', arm: 'atlas', run: 1 } as const;
    const result = await runCell(cell, env.deps);
    assert.equal(result.outcome, 'done', `checkInit must be clean: ${(result.diffs ?? []).join('; ')}`);
    const argv = resultEventOf(env, cellId(cell))['fake_argv'] as string[];
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash,Read,Skill');
    const allowed = (argv[argv.indexOf('--allowedTools') + 1] ?? '').split(',');
    assert.deepEqual(allowed.filter((t) => t.startsWith('Skill')), ['Skill(gsd-atlas-eval:gsd-atlas)']);
    assert.equal(argv[argv.indexOf('--settings') + 1], ATLAS_SETTINGS, 'the atlas session carries the bundled-skill settings');
    assert.equal(argv.filter((a) => a === '--settings').length, 1);
    const init = metaOf(env).find((m) => m.kind === 'session' && m.cellId === cellId(cell))?.['init'] as { tools: string[]; skills: string[] };
    assert.ok(init.tools.includes('Skill'));
    assert.ok(init.skills.includes('gsd-atlas-eval:gsd-atlas'));
    const row = ResultRowSchema.parse(readLines(path.join(env.out, 'results.jsonl'))[0]);
    assert.equal(row.toolCallsByName['Skill'], 1);
    assert.equal(row.atlasToolCalls, 1);
    assert.equal(row.toolCalls, 3);
  });

  it('Skill tool tracer (grep): no Skill token anywhere in the argv, and a Skill tool in the init event is contamination', async () => {
    const env = makeEnv({}, { keepSessions: true });
    const cell = { questionId: 'q-1', arm: 'grep', run: 1 } as const;
    assert.equal((await runCell(cell, env.deps)).outcome, 'done');
    const argv = resultEventOf(env, cellId(cell))['fake_argv'] as string[];
    assert.ok(!argv.some((a) => a.includes('Skill')), 'no Skill token in the grep argv');
    assert.ok(!argv.includes('--settings'), 'the grep session carries no settings');
    const dirty = makeEnv({ FAKE_INIT_EXTRA_TOOLS: JSON.stringify(['Skill']) });
    const contaminated = await runCell({ questionId: 'q-1', arm: 'grep', run: 1 }, dirty.deps);
    assert.equal(contaminated.outcome, 'contaminated');
    assert.ok((contaminated.diffs ?? []).includes('extra tool: Skill'));
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
  tools: ['Bash', 'Read', 'Skill', 'mcp__gsd-atlas__code_find', 'mcp__gsd-atlas__code_refs'],
  mcpServers: [{ name: 'gsd-atlas', status: 'connected' }],
  skills: ['gsd-atlas-eval:gsd-atlas'],
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
    // The two arms differ in exactly the atlas tools and the one Skill rule (plan 03-38, Revision 1).
    assert.deepEqual(
      allowedToolsFor('atlas').filter((t) => !t.startsWith('mcp__') && !t.startsWith('Skill(')),
      allowedToolsFor('grep'),
    );
  });

  // The grep arm is pinned against literal copies of its pre-revision values (plan 03-38): any change
  // to it fails here, whatever the code under change says.
  it('the grep arm is byte for byte what it was before Revision 1', () => {
    assert.deepEqual([...ARMS.grep.builtinTools], ['Bash', 'Read']);
    assert.deepEqual(allowedToolsFor('grep'), [
      'Bash(rg:*)',
      'Bash(git grep:*)',
      'Bash(git ls-files:*)',
      'Bash(grep:*)',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(wc:*)',
      'Bash(ls:*)',
      'Bash(find:*)',
      'Bash(sort:*)',
      'Bash(uniq:*)',
      'Read',
    ]);
    assert.deepEqual([...ARMS.grep.atlasToolNames], []);
    assert.deepEqual(expectedToolSet('grep'), { tools: ['Bash', 'Read'], mcpServers: [] });
    assert.ok(!allowedToolsFor('grep').some((t) => t.includes('Skill')), 'the grep arm has no Skill rule');
  });

  it('the atlas arm adds the Skill built-in and exactly one Skill rule, built from the plugin and skill names', () => {
    assert.deepEqual([...ARMS.atlas.builtinTools], ['Bash', 'Read', 'Skill']);
    const rules = allowedToolsFor('atlas').filter((t) => t === 'Skill' || t.startsWith('Skill('));
    assert.deepEqual(rules, [`Skill(${PLUGIN_NAME}:${SKILL_NAME})`]);
    assert.deepEqual(rules, ['Skill(gsd-atlas-eval:gsd-atlas)']);
    assert.deepEqual(allowedToolsFor('atlas').slice(0, 13), allowedToolsFor('grep'), 'the shell patterns and Read come first, unchanged');
    assert.deepEqual(allowedToolsFor('atlas').slice(13), ['Skill(gsd-atlas-eval:gsd-atlas)', ...ATLAS_TOOL_NAMES]);
  });

  // The ladder outcome (docs/eval/skill-visibility.md): rung one, through --settings. Deny rules by name
  // did not hide a skill from the model's list; `disableBundledSkills` hid all but three, which
  // `skillOverrides` "off" hides; the model then sees the registered skill and nothing else.
  it('the atlas arm designs the bundled skills out of the model view through --settings; the grep arm gets no settings', () => {
    assert.equal(
      ATLAS_SETTINGS,
      '{"disableBundledSkills":true,"skillOverrides":{"plugin-authoring":"off","design":"off","doctor":"off"}}',
    );
    assert.equal(ARMS.atlas.settings, ATLAS_SETTINGS);
    assert.equal(ARMS.grep.settings, undefined);
    assert.ok(!allowedToolsFor('atlas').includes('Skill'), 'no bare Skill allow rule: only the registered skill is open');
  });

  it('expectedToolSet: Bash and Read (and Skill for the atlas arm) exactly, a server only for the atlas arm', () => {
    assert.deepEqual(expectedToolSet('grep'), { tools: ['Bash', 'Read'], mcpServers: [] });
    assert.deepEqual(expectedToolSet('atlas'), { tools: ['Bash', 'Read', 'Skill'], mcpServers: ['gsd-atlas'] });
  });

  it('checkInit accepts the registered environments, including a subset of the atlas tools', () => {
    assert.deepEqual(checkInit('grep', GREP_INIT()), []);
    assert.deepEqual(checkInit('atlas', ATLAS_INIT()), []);
    assert.deepEqual(checkInit('atlas', ATLAS_INIT({ tools: ['Bash', 'Read', 'Skill', 'mcp__gsd-atlas__code_find'] })), []);
  });

  it('checkInit requires the Skill tool and the skill in the atlas arm only', () => {
    assert.deepEqual(checkInit('atlas', ATLAS_INIT({ tools: [...ATLAS_INIT().tools, 'StructuredOutput'] })), []);
    assert.ok(checkInit('atlas', ATLAS_INIT({ tools: ['Bash', 'Read', 'mcp__gsd-atlas__code_find'] })).includes('missing tool: Skill'));
    assert.ok(checkInit('atlas', ATLAS_INIT({ skills: ['update-config'] })).includes('skill absent: gsd-atlas-eval:gsd-atlas'));
    assert.ok(checkInit('grep', GREP_INIT({ tools: ['Bash', 'Read', 'Skill'] })).includes('extra tool: Skill'));
    assert.ok(checkInit('grep', GREP_INIT({ skills: ['gsd-atlas-eval:gsd-atlas'] })).includes('unexpected skill: gsd-atlas'));
    assert.deepEqual(checkInit('grep', GREP_INIT()), [], 'the registered grep environment is still accepted');
  });

  it('checkInit names every other skill in the atlas arm: only the registered skill may be listed', () => {
    const diffs = checkInit('atlas', ATLAS_INIT({ skills: ['gsd-atlas-eval:gsd-atlas', 'update-config', 'plugin-authoring'] }));
    assert.deepEqual(diffs, ['unexpected skill: update-config', 'unexpected skill: plugin-authoring']);
    assert.deepEqual(checkInit('atlas', ATLAS_INIT({ skills: ['gsd-atlas'] })), [], 'the bare skill name counts as the registered skill');
  });

  it('checkInit accepts the StructuredOutput tool that --json-schema adds, in both arms, and still names other extras', () => {
    assert.deepEqual(checkInit('grep', GREP_INIT({ tools: ['Bash', 'Read', 'StructuredOutput'] })), []);
    assert.deepEqual(checkInit('atlas', ATLAS_INIT({ tools: [...ATLAS_INIT().tools, 'StructuredOutput'] })), []);
    assert.ok(checkInit('grep', GREP_INIT({ tools: ['Bash', 'Read', 'StructuredOutput', 'WebSearch'] })).includes('extra tool: WebSearch'));
    assert.ok(checkInit('grep', GREP_INIT({ tools: ['Bash', 'StructuredOutput'] })).includes('missing tool: Read'));
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

  it('cost stop: no session starts once the running cost has reached the line, and the stop is reported', async () => {
    const env = makeEnv();
    const cells = makeSchedule(['q-1', 'q-2'], ['atlas', 'grep'], 1, 5);
    // The fake reports 0.01 USD per session: the line at 0.015 is passed by the second session.
    const summary = await runAll({ cells, concurrency: 1, deps: env.deps, stopAtCostUsd: 0.015 });
    assert.equal(summary.done, 2);
    assert.equal(summary.stopped, true);
    assert.equal(summary.costStopped, true);
    assert.ok(Math.abs(summary.costUsd - 0.02) < 1e-9);
    assert.equal(env.store.all().length, 2);
    assert.equal((readLines(env.eventsFile) as Array<{ kind: string }>).filter((e) => e.kind === 'start').length, 2);
  });

  it('cost stop counts the rows already on disk, so a restart cannot spend the allowance twice', async () => {
    const env = makeEnv();
    const cells = makeSchedule(['q-1', 'q-2'], ['atlas', 'grep'], 1, 5);
    assert.equal((await runAll({ cells, concurrency: 1, deps: env.deps, stopAtCostUsd: 0.015 })).done, 2);
    const again = await runAll({ cells, concurrency: 1, deps: env.deps, stopAtCostUsd: 0.015 });
    assert.equal(again.done, 0);
    assert.equal(again.costStopped, true);
    assert.equal(env.store.all().length, 2);
  });

  it('cost stop is not reported when every cell finished under the line, and is off when no line is given', async () => {
    const env = makeEnv();
    const cells = makeSchedule(['q-1', 'q-2'], ['atlas', 'grep'], 1, 5);
    const summary = await runAll({ cells, concurrency: 1, deps: env.deps, stopAtCostUsd: 1 });
    assert.equal(summary.done, 4);
    assert.equal(summary.costStopped, false);
    assert.equal(summary.stopped, false);
    const free = makeEnv();
    assert.equal((await runAll({ cells, concurrency: 1, deps: free.deps })).done, 4);
  });

  it('cost stop counts a session without a reported cost at its budget cap', async () => {
    const rows = [aRow({ costUsd: 0.5 }), aRow({ run: 2, costUsd: null })];
    assert.equal(runningCostUsd(rows, 3), 3.5);
  });

  it('the command line takes --stop-at-cost-usd and prints it in the plan', async () => {
    const env = makeEnv();
    const files = writeQuestionFiles(env.root);
    const c = capture();
    const code = await runCli(['plan', '--questions', files.questions, '--runs', '1', '--stop-at-cost-usd', '32'], c.io, { env: env.deps.env ?? {} });
    assert.equal(code, 0, c.err());
    assert.match(c.out(), /stop-at-cost-usd: 32/);
    const bad = capture();
    assert.equal(await runCli(['plan', '--questions', files.questions, '--stop-at-cost-usd', '0'], bad.io, {}), 2);
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
function makeRegistered(options: { status?: 'Draft' | 'Frozen'; stage?: 'A' | 'B'; model?: string; atlasCommit?: string } = {}): Registered {
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
    ...(stage === 'B' ? { stageB: { skillSha256: hashFile(skill), atlasCommit: options.atlasCommit ?? 'b'.repeat(40) } } : {}),
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
    assert.match(text, /tools: .*Bash,Read.*atlas arm adds .*Skill tool/s, 'the plan says the atlas arm adds the Skill tool');
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
    // These cases use a fake atlas binary that is in no checkout of its own; the atlas build gate has its own cases below.
    atlasBuildCheck: (): string[] => [],
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

// ---------------------------------------------------------------------------------------------
// Task 3: the run summary, the pilot projection and interrupt safety

/** A row with a usage that adds up: `fresh` input tokens and `cached` cache-read tokens. */
const usageRow = (
  questionId: string,
  arm: 'atlas' | 'grep',
  run: number,
  correct: boolean,
  over: { fresh?: number; cached?: number; cost?: number | null; tools?: number; wallMs?: number; status?: ResultRow['status'] } = {},
): ResultRow => {
  const fresh = over.fresh ?? 100;
  const cached = over.cached ?? 0;
  return aRow({
    questionId,
    arm,
    run,
    correct,
    status: over.status ?? 'ok',
    usage: { input: fresh, output: 0, cacheCreation: 0, cacheRead: cached },
    billableTokens: fresh + cached,
    toolCalls: over.tools ?? 2,
    toolCallsByName: { Bash: over.tools ?? 2 },
    wallMs: over.wallMs ?? 1000,
    costUsd: over.cost === undefined ? 0.01 : over.cost,
  });
};

function writeRows(dir: string, rows: readonly ResultRow[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

// ---------------------------------------------------------------------------------------------
// Plan 03-38: the atlas build under test is the build that Stage B registered (T-03-334)

describe('atlas build gate (T-03-334)', () => {
  interface AtlasRepo {
    dir: string;
    bin: string;
    git: (...args: string[]) => string;
    head: () => string;
    write: (rel: string, text: string) => void;
    commit: (message: string) => string;
  }

  /** A repository holding every build input, a docs file and a built (ignored) `dist/bin/gsd-atlas.js` newer than the sources. */
  function makeAtlasRepo(): AtlasRepo {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-build-')));
    roots.push(dir);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    const commit = (message: string): string => {
      git('add', '--all');
      git('commit', '--quiet', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    };
    git('init', '--quiet');
    write('.gitignore', 'dist/\n');
    write('src/a.ts', 'export const a = 1;\n');
    write('modules/m.ts', 'export const m = 1;\n');
    write('schemas/s.json', '{}\n');
    write('diagnostics/d.json', '{}\n');
    write('package.json', '{"name":"x"}\n');
    write('package-lock.json', '{"lockfileVersion":3}\n');
    write('tsconfig.json', '{}\n');
    write('tsconfig.build.json', '{}\n');
    write('docs/notes.md', 'notes\n');
    commit('initial');
    const bin = path.join(dir, 'dist', 'bin', 'gsd-atlas.js');
    write('dist/bin/gsd-atlas.js', '// built\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(bin, later, later);
    return { dir, bin, git, head: () => git('rev-parse', 'HEAD').trim(), write, commit };
  }

  it('the build inputs are exactly the eight the plan names', () => {
    assert.deepEqual([...ATLAS_BUILD_INPUTS], ['src', 'modules', 'schemas', 'diagnostics', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']);
  });

  it('atlas build matches the Stage B commit: HEAD is that commit, nothing changed, the binary is newer', () => {
    const repo = makeAtlasRepo();
    assert.deepEqual(checkAtlasBuild(repo.bin, repo.head()), []);
  });

  it('atlas build matches the Stage B commit when HEAD is a later commit that changed no build input (the Stage B commit itself)', () => {
    const repo = makeAtlasRepo();
    const registered = repo.head();
    repo.write('docs/notes.md', 'notes after Stage B\n');
    repo.commit('docs only');
    assert.notEqual(repo.head(), registered);
    assert.deepEqual(checkAtlasBuild(repo.bin, registered), []);
  });

  it('atlas build from another commit: the registered commit is neither HEAD nor an ancestor of it', () => {
    const repo = makeAtlasRepo();
    const base = repo.head();
    repo.git('checkout', '--quiet', '-b', 'other');
    repo.write('docs/notes.md', 'another line of history\n');
    const other = repo.commit('other history');
    repo.git('checkout', '--quiet', base);
    const problems = checkAtlasBuild(repo.bin, other);
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0] ?? '', /another commit|not HEAD or an ancestor/);
  });

  it('the registered commit is not in the checkout at all', () => {
    const repo = makeAtlasRepo();
    const problems = checkAtlasBuild(repo.bin, 'd'.repeat(40));
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0] ?? '', /not in the checkout|does not exist/);
  });

  it('a binary that is not inside a git checkout is refused with the cause named', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-plain-')));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bin', 'gsd-atlas.js'), '// built\n');
    const problems = checkAtlasBuild(path.join(dir, 'dist', 'bin', 'gsd-atlas.js'), 'a'.repeat(40));
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0] ?? '', /git checkout/);
  });

  it('build input changed since the Stage B commit: each input is caught and the message names the first changed path', () => {
    for (const rel of ['src/a.ts', 'modules/m.ts', 'schemas/s.json', 'diagnostics/d.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) {
      const repo = makeAtlasRepo();
      const registered = repo.head();
      repo.write(rel, `${fs.readFileSync(path.join(repo.dir, rel), 'utf8')}\n`);
      repo.commit(`change ${rel}`);
      const later = new Date(Date.now() + 120_000);
      fs.utimesSync(repo.bin, later, later); // the binary is newer than every source: only the commit comparison can catch it
      const problems = checkAtlasBuild(repo.bin, registered);
      assert.equal(problems.length, 1, `${rel}: ${problems.join('; ')}`);
      assert.ok((problems[0] ?? '').includes(rel), `${rel}: ${problems[0] ?? ''}`);
    }
  });

  it('build input has an uncommitted change: a modified, a staged and an untracked file all refuse', () => {
    const modified = makeAtlasRepo();
    modified.write('src/a.ts', 'export const a = 2;\n');
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(modified.bin, later, later);
    const m = checkAtlasBuild(modified.bin, modified.head());
    assert.equal(m.length, 1, m.join('; '));
    assert.ok((m[0] ?? '').includes('src/a.ts'));
    const staged = makeAtlasRepo();
    staged.write('package.json', '{"name":"y"}\n');
    staged.git('add', 'package.json');
    fs.utimesSync(staged.bin, later, later);
    assert.ok((checkAtlasBuild(staged.bin, staged.head())[0] ?? '').includes('package.json'));
    const untracked = makeAtlasRepo();
    untracked.write('modules/new.ts', 'export const n = 1;\n');
    fs.utimesSync(untracked.bin, later, later);
    assert.ok((checkAtlasBuild(untracked.bin, untracked.head())[0] ?? '').includes('modules/new.ts'));
  });

  it('a change outside the build inputs is not a problem', () => {
    const repo = makeAtlasRepo();
    repo.write('docs/notes.md', 'uncommitted note\n');
    repo.write('scripts/other.ts', 'export {};\n');
    assert.deepEqual(checkAtlasBuild(repo.bin, repo.head()), []);
  });

  it('atlas binary older than a build input: the build is stale', () => {
    const repo = makeAtlasRepo();
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(repo.bin, old, old);
    const problems = checkAtlasBuild(repo.bin, repo.head());
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0] ?? '', /older than/);
  });

  describe('in the scored gate', () => {
    const baseArgs = (env: Env, reg: Registered, bin: string): string[] => {
      const files = writeQuestionFiles(env.root);
      return [
        'run', '--scored', '--dry-run', '--questions', files.questions, '--answers', files.answers, '--corpus-dir', CORPUS,
        '--out-dir', path.join(env.root, 'scored-out'), '--atlas-bin', bin, '--skill', reg.skill,
        '--prereg', reg.prereg, '--scratch-dir', env.scratch,
      ];
    };
    const depsFor = (env: Env, reg: Registered) => ({
      repoRoot: reg.root,
      env: { ...(env.deps.env ?? {}), PATH: path.join(env.root, 'no-bin') },
      claudeVersion: () => Promise.resolve('2.1.302 (Claude Code)'),
      readPrepared: () => ({ sha: SHA, npmCi: true }),
    });

    it('passes and says so when the build matches the Stage B commit', async () => {
      const env = makeEnv();
      const repo = makeAtlasRepo();
      const reg = makeRegistered({ atlasCommit: repo.head() });
      const c = capture();
      const code = await runCli(baseArgs(env, reg, repo.bin), c.io, depsFor(env, reg));
      assert.equal(code, 0, c.err());
      assert.match(c.out(), /gate: ok/);
      assert.match(c.out(), /atlas build matches the Stage B commit/);
    });

    it('refuses with the cause when a build input changed since the Stage B commit, and starts nothing', async () => {
      const env = makeEnv();
      const repo = makeAtlasRepo();
      const reg = makeRegistered({ atlasCommit: repo.head() });
      repo.write('src/a.ts', 'export const a = 3;\n');
      repo.commit('a later change to src');
      const later = new Date(Date.now() + 120_000);
      fs.utimesSync(repo.bin, later, later);
      const c = capture();
      assert.equal(await runCli(baseArgs(env, reg, repo.bin), c.io, depsFor(env, reg)), 2);
      assert.match(c.err(), /scored gate: .*src\/a\.ts/);
      assert.equal(fs.existsSync(env.eventsFile), false, 'no session started');
      assert.equal(fs.existsSync(path.join(env.root, 'scored-out')), false);
    });

    it('a Stage A registration is refused before the build is looked at', async () => {
      const env = makeEnv();
      const repo = makeAtlasRepo();
      const reg = makeRegistered({ stage: 'A', atlasCommit: repo.head() });
      const c = capture();
      assert.equal(await runCli(baseArgs(env, reg, repo.bin), c.io, depsFor(env, reg)), 2);
      assert.match(c.err(), /Stage B/);
    });
  });
});

describe('summary', () => {
  it('summary per arm: sessions, statuses, tokens, cache reads, tool calls, wall time, cost and disagreement', async () => {
    const env = makeEnv();
    const dir = path.join(env.root, 'summary-out');
    writeRows(dir, [
      usageRow('q-1', 'atlas', 1, true, { fresh: 100, cached: 50, cost: 0.1, tools: 4, wallMs: 2000 }),
      usageRow('q-1', 'grep', 1, false, { fresh: 300, cached: 150, cost: 0.3, tools: 8, wallMs: 4000 }),
      usageRow('q-2', 'atlas', 1, true, { fresh: 200, cached: 0, cost: 0.2, tools: 6, wallMs: 3000 }),
      usageRow('q-2', 'grep', 1, true, { fresh: 100, cached: 0, cost: null, tools: 2, wallMs: 1000, status: 'timeout' }),
    ]);
    const c = capture();
    assert.equal(await runCli(['summary', '--out-dir', dir], c.io), 0, c.err());
    const text = c.out();
    const atlas = text.slice(text.indexOf('arm atlas'), text.indexOf('arm grep'));
    const grep = text.slice(text.indexOf('arm grep'));
    assert.match(atlas, /sessions: 2/);
    assert.match(atlas, /ok: 2/);
    assert.match(atlas, /billable tokens: mean 175\.0, total 350/);
    assert.match(atlas, /cache-read tokens: mean 25\.0, total 50/);
    assert.match(atlas, /mean tool calls: 5\.0/);
    assert.match(atlas, /mean wall time: 2500 ms/);
    assert.match(atlas, /cost: total 0\.3000 USD \(2 of 2 sessions\)/);
    assert.match(grep, /sessions: 2/);
    assert.match(grep, /ok: 1/);
    assert.match(grep, /failed: timeout 1/);
    assert.match(grep, /billable tokens: mean 275\.0, total 550/);
    assert.match(grep, /cost: total 0\.3000 USD \(1 of 2 sessions\)/);
    // q-1: atlas 1.0 above 0.5, grep 0.0 not; q-2: both above 0.5.
    assert.match(text, /questions with both arms: 2/);
    assert.match(text, /disagreement: 1 of 2 questions \(50\.0%\)/);
  });

  it('prefers a pilot directory under --out-dir when the directory itself has no results', async () => {
    const env = makeEnv();
    writeRows(path.join(env.root, 'o', 'pilot'), [usageRow('q-1', 'atlas', 1, true)]);
    const c = capture();
    assert.equal(await runCli(['summary', '--out-dir', path.join(env.root, 'o')], c.io), 0, c.err());
    assert.match(c.out(), /rows: 1/);
  });

  it('duplicate cell reported: a hand-made duplicate row is an error and exit 1', async () => {
    const env = makeEnv();
    const dir = path.join(env.root, 'dup-out');
    writeRows(dir, [usageRow('q-1', 'atlas', 1, true), usageRow('q-1', 'atlas', 1, false)]);
    const c = capture();
    assert.equal(await runCli(['summary', '--out-dir', dir], c.io), 1);
    assert.match(c.err(), /duplicate cell q-1\|atlas\|1/);
  });

  it('reports a missing results file and a row that breaks the schema', async () => {
    const env = makeEnv();
    const none = capture();
    assert.equal(await runCli(['summary', '--out-dir', path.join(env.root, 'nothing-here')], none.io), 2);
    assert.match(none.err(), /no results/);
    const dir = path.join(env.root, 'bad-out');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'results.jsonl'), `${JSON.stringify({ ...usageRow('q-1', 'atlas', 1, true), billableTokens: 1 })}\n`);
    const bad = capture();
    assert.equal(await runCli(['summary', '--out-dir', dir], bad.io), 1);
    assert.match(bad.err(), /billableTokens/);
  });
});

describe('project', () => {
  const pilotRows = (): ResultRow[] => {
    // Per-question atlas minus grep accuracy over two runs: 1, 0, 0.5, -0.5.
    const plan: Array<[string, boolean[], boolean[]]> = [
      ['q-1', [true, true], [false, false]],
      ['q-2', [true, true], [true, true]],
      ['q-3', [true, true], [true, false]],
      ['q-4', [true, false], [true, true]],
    ];
    const rows: ResultRow[] = [];
    for (const [id, atlas, grep] of plan) {
      atlas.forEach((ok, i) => rows.push(usageRow(id, 'atlas', i + 1, ok, { cost: 0.02 })));
      grep.forEach((ok, i) => rows.push(usageRow(id, 'grep', i + 1, ok, { cost: 0.01 })));
    }
    return rows;
  };

  it('projection offsets: sessions and cost per arm as an estimate, and 1.645 * sd / sqrt(N) for N = 50, 75, 100', async () => {
    const env = makeEnv();
    const dir = path.join(env.root, 'pilot-out');
    writeRows(dir, pilotRows());
    const c = capture();
    assert.equal(await runCli(['project', '--out-dir', dir, '--questions', '50', '--runs', '3'], c.io), 0, c.err());
    const text = c.out();
    assert.match(text, /estimate/);
    assert.match(text, /atlas: 0\.0200 USD per session x 150 sessions = 3\.00 USD/);
    assert.match(text, /grep: 0\.0100 USD per session x 150 sessions = 1\.50 USD/);
    assert.match(text, /total: 300 sessions, 4\.50 USD/);
    const sd = Math.sqrt(1.25 / 3);
    assert.match(text, new RegExp(`paired difference sd: ${sd.toFixed(4)} over 4 questions`));
    for (const n of [50, 75, 100]) {
      const offset = ((1.645 * sd) / Math.sqrt(n)) * 100;
      assert.match(text, new RegExp(`N = ${String(n)}: ${offset.toFixed(2)} points`), `offset for N = ${String(n)}`);
    }
  });

  it('says so when the pilot cannot give a standard deviation or a cost', async () => {
    const env = makeEnv();
    const dir = path.join(env.root, 'thin-out');
    writeRows(dir, [usageRow('q-1', 'atlas', 1, true, { cost: null }), usageRow('q-1', 'grep', 1, true, { cost: null })]);
    const c = capture();
    assert.equal(await runCli(['project', '--out-dir', dir, '--questions', '50', '--runs', '3'], c.io), 0, c.err());
    assert.match(c.out(), /no cost reported/);
    assert.match(c.out(), /needs at least 2 paired questions/);
  });

  it('refuses arguments that are not whole numbers', async () => {
    const env = makeEnv();
    const dir = path.join(env.root, 'args-out');
    writeRows(dir, pilotRows());
    for (const args of [['--questions', 'fifty', '--runs', '3'], ['--questions', '50'], ['--runs', '3']]) {
      const c = capture();
      assert.equal(await runCli(['project', '--out-dir', dir, ...args], c.io), 2);
    }
  });
});

describe('interrupt safety', () => {
  it('interrupt leaves complete lines: SIGKILL mid-run, then a second start finishes the remaining cells exactly once', async () => {
    const env = makeEnv();
    const files = writeQuestionFiles(env.root);
    const outDir = path.join(env.root, 'kill-out');
    const results = path.join(outDir, 'pilot', 'results.jsonl');
    const argv = [
      path.join(here, 'harness.ts'),
      'pilot', '--questions', files.questions, '--answers', files.answers, '--corpus-dir', CORPUS, '--out-dir', outDir,
      '--arms', 'atlas,grep', '--runs', '2', '--concurrency', '1', '--seed', '3', '--model', 'fake-model',
      '--max-budget-usd', '1', '--wall-clock-ms', '20000', '--atlas-bin', FAKE_ATLAS, '--skill', SKILL,
      '--scratch-dir', env.scratch, '--retry-delay-ms', '0', '--claude-executable', process.execPath, '--claude-prefix-arg', FAKE_CLAUDE,
    ];
    const total = 8;
    const childEnv = (delay: string): NodeJS.ProcessEnv => ({ ...process.env, ...env.deps.env, FAKE_DELAY_MS: delay });
    const first = spawn(process.execPath, argv, { env: childEnv('400'), stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => first.on('exit', () => resolve()));
    const started = Date.now();
    while (readLines(results).length < 2) {
      assert.ok(Date.now() - started < 30_000, 'the first run produced no rows');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    first.kill('SIGKILL');
    await exited;

    const text = fs.readFileSync(results, 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.pop(), '', 'the file ends with a newline: only complete lines');
    for (const line of lines) ResultRowSchema.parse(JSON.parse(line));
    assert.ok(lines.length >= 2 && lines.length < total, `${String(lines.length)} rows after the kill`);

    const second = spawn(process.execPath, argv, { env: childEnv('0'), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.on('exit', (c) => resolve(c)));
    assert.equal(code, 0);
    const rows = readLines(results).map((r) => ResultRowSchema.parse(r));
    assert.equal(rows.length, total);
    assert.equal(new Set(rows.map(cellId)).size, total, 'no cell twice');
  });
});

// <<tests-continue>>
