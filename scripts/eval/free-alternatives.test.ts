// Structure checks for docs/eval/free-alternatives.md (EVL-01, D-05) and the scan inputs and
// outputs that document links to. These tests read committed files only: no network, no model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { billableTokens } from './claude-session.ts';
import {
  SCAN_MAX_BUDGET_USD_PER_SESSION,
  SCAN_SESSION_WALL_CLOCK_MS,
  applyGapNotes,
  loadScanQuestions,
  loadScanRun,
  markAnswer,
  parseAnswer,
  runScan,
  scanQuestionToQuestion,
  type ParsedAnswer,
} from './scan.ts';
import type { AnswerKey } from './questions.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const docPath = path.join(repoRoot, 'docs', 'eval', 'free-alternatives.md');
const docDir = path.dirname(docPath);
const questionsDocPath = path.join(repoRoot, 'docs', 'eval', 'scan-questions.md');
const questionsJsonPath = path.join(repoRoot, 'scripts', 'eval', 'scan-questions.json');
const constantsPath = path.join(
  repoRoot,
  '.planning',
  'phases',
  '03-typescript-module-and-mvp-eval',
  '03-CONSTANTS.md',
);

/** The five rows of the comparison table, in the order the plan fixes. */
const TOOL_ROWS = [
  'mcp-language-server and Serena (LSP-wrapping MCP servers)',
  'Aider repo-map (agent repo-map)',
  'colbymchenry/codegraph',
  'Claude Code LSP plugin',
  'Memtrace',
] as const;

const REQUIRED_SECTIONS = ['Desk review', 'Install plan', 'Method', 'Gap summary'] as const;
const REQUIRED_TOPICS = ['worktree', 'ADR', '.cts', 'degraded', 'file:line'] as const;

function readDoc(): string {
  return fs.readFileSync(docPath, 'utf8');
}

function statusOf(text: string): string | undefined {
  const head = text.split('\n').slice(0, 12);
  for (const line of head) {
    const match = /^Status:\s*(\S+)/.exec(line);
    if (match !== null) return match[1];
  }
  return undefined;
}

interface TableRow {
  cells: string[];
}

/** The data rows of the first markdown table that has a "Tool and version" header cell. */
function comparisonTable(text: string): TableRow[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^\|\s*Tool and version\s*\|/.test(line));
  assert.ok(start >= 0, 'comparison table header "Tool and version" not found');
  const rows: TableRow[] = [];
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    rows.push({ cells });
  }
  return rows;
}

function sectionBody(text: string, title: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#{1,3}\\s+${title}\\s*$`).test(line));
  assert.ok(start >= 0, `section "${title}" not found`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

describe('free-alternatives.md structure', () => {
  const text = readDoc();
  const status = statusOf(text);

  it('has a top-line Status of Draft or Final', () => {
    assert.ok(status === 'Draft' || status === 'Final', `Status line is ${String(status)}`);
  });

  it('has exactly five data rows whose first cells match the tool names in order', () => {
    const rows = comparisonTable(text);
    assert.equal(rows.length, TOOL_ROWS.length);
    TOOL_ROWS.forEach((name, index) => {
      assert.ok(
        rows[index].cells[0].startsWith(name),
        `row ${index + 1} first cell "${rows[index].cells[0]}" does not start with "${name}"`,
      );
    });
  });

  it('has seven non-empty cells in every row', () => {
    for (const row of comparisonTable(text)) {
      assert.equal(row.cells.length, 7, `row "${row.cells[0]}" has ${row.cells.length} cells`);
      for (const cell of row.cells) assert.notEqual(cell, '', `empty cell in row "${row.cells[0]}"`);
    }
  });

  it('live-run cells link to scan-run files that exist and parse, or name a reason', () => {
    for (const row of comparisonTable(text)) {
      const cell = row.cells[4];
      const links = [...cell.matchAll(/\]\((scan-runs\/[^)\s]+)\)/g)].map((m) => m[1]);
      if (links.length > 0) {
        for (const link of links) {
          const file = path.join(docDir, link);
          assert.ok(fs.existsSync(file), `${link} does not exist`);
          loadScanRun(file);
        }
        continue;
      }
      const reason = /^(desk-only|could not run|pending):\s*(\S.*)$/.exec(cell);
      assert.ok(reason !== null, `live-run cell of "${row.cells[0]}" is neither a scan-runs link nor a reasoned prefix: ${cell}`);
      if (reason[1] === 'pending') assert.equal(status, 'Draft', 'a pending cell is allowed only under Status: Draft');
    }
  });

  it('marks the Memtrace row desk-only', () => {
    const rows = comparisonTable(text);
    assert.match(rows[4].cells[4], /^desk-only:\s*\S/);
  });

  it('names the required topics', () => {
    for (const topic of REQUIRED_TOPICS) assert.ok(text.includes(topic), `topic "${topic}" missing`);
  });

  it('has the required sections', () => {
    for (const title of REQUIRED_SECTIONS) sectionBody(text, title);
  });

  it('has a Gap summary of at least three sentences', () => {
    const body = sectionBody(text, 'Gap summary').replace(/\s+/g, ' ').trim();
    const sentences = body.split(/[.!?](?:\s|$)/).filter((s) => s.trim().length > 0);
    assert.ok(sentences.length >= 3, `Gap summary has ${sentences.length} sentences`);
  });

  it('under Status: Final has no pending cell and a gap paragraph per tool plus a closing one', () => {
    if (status !== 'Final') return;
    for (const row of comparisonTable(text)) {
      for (const cell of row.cells) assert.ok(!/^pending:/.test(cell), `pending cell remains in "${row.cells[0]}"`);
    }
    const paragraphs = sectionBody(text, 'Gap summary')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    assert.ok(paragraphs.length >= TOOL_ROWS.length + 1, `Gap summary has ${paragraphs.length} paragraphs`);
  });
});

describe('scan run files', () => {
  const runsDir = path.join(docDir, 'scan-runs');
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : [];

  it('exist for at least the codegraph tracer', () => {
    assert.ok(files.includes('codegraph.json'));
  });

  for (const name of files) {
    it(`${name}: parses, sums billable tokens per row and carries no home path`, () => {
      const file = path.join(runsDir, name);
      const run = loadScanRun(file);
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(!raw.includes(os.homedir()), 'run file contains the home directory');
      assert.ok(!raw.includes('/Users/'), 'run file contains a /Users/ path');
      assert.ok(!raw.includes('/private/tmp'), 'run file contains a scratch path');
      if (run.couldNotRun !== null) {
        assert.equal(run.rows.length, 0);
        assert.ok(run.couldNotRun.reason.length > 0);
        return;
      }
      assert.equal(run.rows.length, 8);
      for (const row of run.rows) {
        assert.equal(row.tokens.billable, billableTokens(row.tokens));
      }
      assert.ok(run.tool.version.length > 0);
      assert.ok(run.claudeCodeVersion.length > 0);
      assert.ok(run.model.length > 0);
      assert.equal(run.limits.maxBudgetUsdPerSession, SCAN_MAX_BUDGET_USD_PER_SESSION);
      assert.equal(run.limits.sessionWallClockMs, SCAN_SESSION_WALL_CLOCK_MS);
    });
  }

  it('codegraph.json used only the tools the file lists', () => {
    const run = loadScanRun(path.join(runsDir, 'codegraph.json'));
    for (const row of run.rows) {
      for (const used of Object.keys(row.toolCallsByName)) {
        assert.ok(row.initTools.includes(used), `session ${row.questionId} used ${used}, which its init list lacks`);
      }
    }
  });
});

describe('scan questions', () => {
  it('holds eight valid questions s-001 to s-008 with embedded oracle keys', () => {
    const file = loadScanQuestions(questionsJsonPath);
    assert.deepEqual(
      file.questions.map((q) => q.id),
      ['s-001', 's-002', 's-003', 's-004', 's-005', 's-006', 's-007', 's-008'],
    );
    for (const q of file.questions) {
      assert.equal(q.expected.questionId, q.id);
      assert.equal(q.expected.kind, q.key.kind);
      scanQuestionToQuestion(q);
    }
  });

  it('covers the planned categories: callers 2, heritage, emit, adr, impact, definition, abstain', () => {
    const counts = new Map<string, number>();
    for (const q of loadScanQuestions(questionsJsonPath).questions) {
      counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(counts), {
      callers: 2,
      heritage: 1,
      emit: 1,
      adr: 1,
      impact: 1,
      definition: 1,
      abstain: 1,
    });
  });

  it('is described in prose in docs/eval/scan-questions.md', () => {
    const prose = fs.readFileSync(questionsDocPath, 'utf8');
    for (const q of loadScanQuestions(questionsJsonPath).questions) {
      assert.ok(prose.includes(q.id), `${q.id} missing from scan-questions.md`);
      assert.ok(prose.includes(q.text), `text of ${q.id} differs between the JSON and the prose file`);
    }
  });
});

describe('scan constants', () => {
  it('match the approved scan.* rows of 03-CONSTANTS.md', () => {
    const constants = fs.readFileSync(constantsPath, 'utf8');
    assert.match(constants, /^Status: Approved/m);
    const budget = /\|\s*`scan\.maxBudgetUsdPerSession`\s*\|\s*([0-9.]+)\s*\|/.exec(constants);
    const clock = /\|\s*`scan\.sessionWallClockMs`\s*\|\s*([0-9]+)\s*\|/.exec(constants);
    assert.ok(budget !== null && clock !== null);
    assert.equal(SCAN_MAX_BUDGET_USD_PER_SESSION, Number(budget[1]));
    assert.equal(SCAN_SESSION_WALL_CLOCK_MS, Number(clock[1]));
  });
});

describe('runScan with a stand-in claude program', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const scanKey: AnswerKey = {
    questionId: 's-001',
    kind: 'callers',
    abstain: false,
    items: [{ file: 'a.ts', line: 3 }],
    granularity: 'file',
    equality: 'exact-set',
    needles: [],
    unexplained: [],
    notes: {},
    oracleVersion: 'test',
  };

  function setup(serverStatus: string): { dir: string; repo: string; questions: string; fake: string; argvFile: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const run = (args: string[]): void => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    run(['init', '-q']);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    run(['add', 'a.ts']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const questions = path.join(dir, 'questions.json');
    fs.writeFileSync(
      questions,
      JSON.stringify({
        corpusId: 'fixture',
        corpusSha: head,
        oracleVersion: 'test',
        questions: [
          {
            id: 's-001',
            category: 'callers',
            text: 'Which files call a?',
            key: { kind: 'callers', symbol: 'a', definedIn: 'a.ts', granularity: 'file', equality: 'exact-set' },
            expected: scanKey,
          },
        ],
      }),
    );
    const argvFile = path.join(dir, 'argv.json');
    const fake = path.join(dir, 'fake-claude.mjs');
    fs.writeFileSync(
      fake,
      `import fs from 'node:fs';
for await (const chunk of process.stdin) void chunk;
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'system', subtype: 'init', tools: ['Bash', 'Read', 'mcp__fixture__explore'], mcp_servers: [{ name: 'fixture', status: ${JSON.stringify(serverStatus)} }], model: 'fake-model', skills: [], plugins: [], agents: [], cwd: ${JSON.stringify(repo)} });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__fixture__explore', input: {} }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Found it.\\n\`\`\`json\\n' + JSON.stringify({ abstain: false, items: [{ file: ${JSON.stringify(repo)} + '/a.ts' }] }) + '\\n\`\`\`', usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 }, total_cost_usd: 0.01, num_turns: 2, duration_ms: 50 });
`,
    );
    return { dir, repo, questions, fake, argvFile };
  }

  const tool = {
    id: 'fixture',
    label: 'fixture tool',
    mcpServers: () => ({ fixture: { type: 'stdio' as const, command: 'fixture-server', args: [] } }),
    allowedMcpTools: ['mcp__fixture'],
    notes: 'test',
  };

  it('runs the session with the isolation flags, marks the answer and records counts only', async () => {
    const s = setup('connected');
    try {
      const out = path.join(s.dir, 'out', 'run.json');
      const run = await runScan(tool, {
        corpusDir: s.repo,
        scratchDir: path.join(s.dir, 'scratch'),
        outPath: out,
        questionsPath: s.questions,
        executable: process.execPath,
        prefixArgs: [s.fake],
        claudeCodeVersion: '0.0.0-test',
        toolVersion: '1.2.3',
        installMethod: 'test',
        now: () => new Date('2026-10-18T00:00:00Z'),
      });
      assert.equal(run.couldNotRun, null);
      assert.equal(run.rows.length, 1);
      assert.equal(run.rows[0].correct, 'yes');
      assert.equal(run.rows[0].tokens.billable, 5 + 7 + 11 + 13);
      assert.deepEqual(run.rows[0].toolCallsByName, { mcp__fixture__explore: 1 });
      assert.equal(run.model, 'fake-model');
      assert.equal(run.date, '2026-10-18');
      assert.equal(loadScanRun(out).totals.yes, 1);
      const argv = JSON.parse(fs.readFileSync(s.argvFile, 'utf8')) as string[];
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
      assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash,Read');
      assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], String(SCAN_MAX_BUDGET_USD_PER_SESSION));
      assert.ok(argv.includes('--model'));
      assert.ok(!argv.includes('--plugin-dir'));
      const written = fs.readFileSync(out, 'utf8');
      assert.ok(!written.includes(s.dir), 'the run file names a scratch path');
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('records could-not-run, with no rows, when the tool server does not connect', async () => {
    const s = setup('failed');
    try {
      const run = await runScan(tool, {
        corpusDir: s.repo,
        scratchDir: path.join(s.dir, 'scratch'),
        questionsPath: s.questions,
        executable: process.execPath,
        prefixArgs: [s.fake],
        claudeCodeVersion: '0.0.0-test',
        toolVersion: '1.2.3',
      });
      assert.deepEqual(run.rows, []);
      assert.match(run.couldNotRun?.reason ?? '', /status failed/);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses a checkout that is not at the pinned commit', async () => {
    const s = setup('connected');
    try {
      const raw = JSON.parse(fs.readFileSync(s.questions, 'utf8')) as { corpusSha: string };
      raw.corpusSha = sha;
      fs.writeFileSync(s.questions, JSON.stringify(raw));
      await assert.rejects(
        runScan(tool, { corpusDir: s.repo, scratchDir: path.join(s.dir, 'scratch'), questionsPath: s.questions }),
        /pin/,
      );
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('writes gap notes into a run file and rejects an unknown question id', async () => {
    const s = setup('connected');
    try {
      const out = path.join(s.dir, 'run.json');
      await runScan(tool, {
        corpusDir: s.repo,
        scratchDir: path.join(s.dir, 'scratch'),
        outPath: out,
        questionsPath: s.questions,
        executable: process.execPath,
        prefixArgs: [s.fake],
        claudeCodeVersion: '0.0.0-test',
        toolVersion: '1.2.3',
      });
      applyGapNotes(out, { 's-001': `lacked a thing in ${os.homedir()}` }, path.join(s.dir, 'scratch'));
      const note = loadScanRun(out).rows[0].gapNote;
      assert.ok(note.startsWith('lacked a thing in'));
      assert.ok(!note.includes(os.homedir()));
      assert.throws(() => applyGapNotes(out, { 's-999': 'x' }, s.dir), /no row s-999/);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });
});

describe('answer parsing and marking', () => {
  const key = (over: Partial<AnswerKey>): AnswerKey => ({
    questionId: 's-001',
    kind: 'callers',
    abstain: false,
    items: [{ file: 'a.ts', line: 3 }, { file: 'b.ts', line: 9 }, { file: 'b.ts', line: 12 }],
    granularity: 'file',
    equality: 'exact-set',
    needles: [],
    unexplained: [],
    notes: {},
    oracleVersion: 'test',
    ...over,
  });
  const answer = (items: { file: string; symbol?: string }[], abstain = false): ParsedAnswer => ({ abstain, items });

  it('parses the last fenced json block of a final message', () => {
    const parsed = parseAnswer('Some text\n```json\n{"abstain": true, "items": []}\n```\nmore\n```json\n{"abstain": false, "items": [{"file": "./a.ts", "line": 2}]}\n```');
    assert.deepEqual(parsed, { abstain: false, items: [{ file: 'a.ts', line: 2 }] });
  });

  it('parses a bare json object and strips the corpus prefix from absolute paths', () => {
    const parsed = parseAnswer('{"abstain": false, "items": [{"file": "/tmp/x/a.ts"}]}', '/tmp/x');
    assert.deepEqual(parsed, { abstain: false, items: [{ file: 'a.ts' }] });
  });

  it('returns null when no answer object is present', () => {
    assert.equal(parseAnswer('I could not find it.'), null);
    assert.equal(parseAnswer('```json\n{"foo": 1}\n```'), null);
  });

  it('marks yes for an exact file set, partial for a subset or a superset, no for a miss', () => {
    assert.equal(markAnswer(key({}), answer([{ file: 'a.ts' }, { file: 'b.ts' }])), 'yes');
    assert.equal(markAnswer(key({}), answer([{ file: 'a.ts' }])), 'partial');
    assert.equal(markAnswer(key({}), answer([{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }])), 'partial');
    assert.equal(markAnswer(key({}), answer([{ file: 'z.ts' }])), 'no');
    assert.equal(markAnswer(key({}), null), 'no');
    assert.equal(markAnswer(key({}), answer([], true)), 'no');
  });

  it('marks abstain questions yes only for an empty abstaining answer', () => {
    const abstainKey = key({ kind: 'abstain', abstain: true, items: [] });
    assert.equal(markAnswer(abstainKey, answer([], true)), 'yes');
    assert.equal(markAnswer(abstainKey, answer([{ file: 'a.ts' }])), 'no');
    assert.equal(markAnswer(abstainKey, answer([{ file: 'a.ts' }], true)), 'no');
  });

  it('compares file and symbol when the key asks for file+symbol', () => {
    const symKey = key({
      kind: 'heritage',
      granularity: 'file+symbol',
      items: [{ file: 'm.ts', line: 1, symbol: 'P' }, { file: 'm.ts', line: 2, symbol: 'Q' }],
    });
    assert.equal(markAnswer(symKey, answer([{ file: 'm.ts', symbol: 'P' }, { file: 'm.ts', symbol: 'Q' }])), 'yes');
    assert.equal(markAnswer(symKey, answer([{ file: 'm.ts', symbol: 'P' }])), 'partial');
    assert.equal(markAnswer(symKey, answer([{ file: 'm.ts' }])), 'no');
  });
});
