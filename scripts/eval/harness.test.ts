import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runCell } from './harness.ts';
import type { CellDeps } from './harness.ts';
import { ResultsStore } from './results.ts';
import { ResultRowSchema } from './rows.ts';
import type { ResultRow } from './rows.ts';
import { cellId } from './schedule.ts';
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

// <<tests-continue>>
