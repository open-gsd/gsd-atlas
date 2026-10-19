import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertToolSet,
  billableTokens,
  buildClaudeArgs,
  cacheReadTokens,
  countToolCalls,
  extractInit,
  extractResult,
  parseStreamText,
  runClaudeSession,
  statusOf,
  sumToolCalls,
} from './claude-session.ts';
import type {
  ExitInfo,
  InitEvent,
  ResultEvent,
  SessionSpec,
  SessionStatus,
  StreamEvent,
  Usage,
} from './claude-session.ts';

const fixtureDir = join(import.meta.dirname, '__fixtures__');
const fakeClaude = join(fixtureDir, 'fake-claude.mjs');
const fixtureText = (name: string): string => readFileSync(join(fixtureDir, name), 'utf8');

const baseSpec = (overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  prompt: 'Reply with the single word ok.',
  cwd: process.cwd(),
  tools: [],
  allowedTools: [],
  mcpConfigPath: '/does/not/matter/mcp.json',
  pluginDirs: [],
  maxBudgetUsd: 0.5,
  wallClockMs: 10_000,
  executable: process.execPath,
  prefixArgs: [fakeClaude],
  env: { FAKE_CLAUDE_MODE: 'ok' },
  ...overrides,
});

describe('buildClaudeArgs', () => {
  it('emits the isolation flags in the documented order with an empty setting-sources value', () => {
    const args = buildClaudeArgs(
      baseSpec({
        tools: ['Bash', 'Read'],
        allowedTools: ['Bash(git grep:*)', 'Read'],
        pluginDirs: ['/p/one', '/p/two'],
        jsonSchema: '{"type":"object"}',
        model: 'claude-sonnet-5-5',
        mcpConfigPath: '/cfg/mcp.json',
      }),
    );
    assert.deepEqual(args, [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '/cfg/mcp.json',
      '--plugin-dir',
      '/p/one',
      '--plugin-dir',
      '/p/two',
      '--tools',
      'Bash,Read',
      '--allowedTools',
      'Bash(git grep:*),Read',
      '--max-budget-usd',
      '0.5',
      '--json-schema',
      '{"type":"object"}',
      '--model',
      'claude-sonnet-5-5',
      '--no-session-persistence',
    ]);
  });

  it('omits allowedTools, json-schema and model when not given, and keeps an empty tools value', () => {
    const args = buildClaudeArgs(baseSpec());
    assert.ok(!args.includes('--allowedTools'));
    assert.ok(!args.includes('--json-schema'));
    assert.ok(!args.includes('--model'));
    const at = args.indexOf('--tools');
    assert.equal(args[at + 1], '');
  });

  it('emits --settings with the given inline JSON after the plugin directories and before --tools, and only when it is given', () => {
    const json = '{"disableBundledSkills":true}';
    const args = buildClaudeArgs(baseSpec({ tools: ['Bash'], pluginDirs: ['/p/one'], settings: json }));
    const at = args.indexOf('--settings');
    assert.ok(at > args.indexOf('--plugin-dir'));
    assert.ok(at < args.indexOf('--tools'));
    assert.equal(args[at + 1], json);
    assert.equal(args.filter((a) => a === '--settings').length, 1);
    assert.ok(!buildClaudeArgs(baseSpec()).includes('--settings'), 'no --settings unless a session asks for it');
  });

  it('never carries the prompt in argv', () => {
    const args = buildClaudeArgs(baseSpec({ prompt: 'SECRET-PROMPT-MARKER' }));
    assert.ok(!args.some((a) => a.includes('SECRET-PROMPT-MARKER')));
  });
});

describe('parseStreamText', () => {
  it('parses the recorded stream without ignoring any line', () => {
    const { events, ignoredLines } = parseStreamText(fixtureText('claude-stream-ok.jsonl'));
    assert.equal(ignoredLines, 0);
    assert.deepEqual(
      events.map((e) => e.type),
      ['system', 'assistant', 'rate_limit_event', 'result'],
    );
  });

  it('keeps a final line without a newline when it is complete JSON', () => {
    const { events, ignoredLines } = parseStreamText('{"type":"system","subtype":"init"}\n{"type":"result"}');
    assert.equal(events.length, 2);
    assert.equal(ignoredLines, 0);
  });

  it('[edge EVL-03/partial-output] ignores a truncated final line, a non-JSON line and an unknown event type without throwing', () => {
    const text = [
      '{"type":"system","subtype":"init"}',
      'this line is not json',
      '{"type":"mystery_event","payload":1}',
      '[1,2,3]',
      '',
      '{"type":"assistant","message":{"content":[{"type":"te',
    ].join('\n');
    const { events, ignoredLines } = parseStreamText(text);
    assert.deepEqual(
      events.map((e) => e.type),
      ['system'],
    );
    assert.equal(ignoredLines, 4);
  });

  it('copes with CRLF line endings', () => {
    const { events } = parseStreamText('{"type":"system"}\r\n{"type":"result"}\r\n');
    assert.equal(events.length, 2);
  });
});

describe('extractInit and extractResult', () => {
  it('extractInit reads tools, mcp servers, skills, plugins, agents, model and cwd from the recorded init event', () => {
    const { events } = parseStreamText(fixtureText('claude-stream-ok.jsonl'));
    const init = extractInit(events);
    assert.ok(init);
    assert.deepEqual(init.tools, []);
    assert.deepEqual(init.mcpServers, []);
    assert.ok(init.skills.includes('simplify'));
    assert.ok(init.plugins.some((p) => p.name === 'cc-plugin-agents-md'));
    assert.ok(init.agents.includes('Explore'));
    assert.equal(init.model, 'claude-sonnet-5-5');
    assert.equal(init.cwd, '/work/work1');
  });

  it('extractInit returns null when no init event arrived', () => {
    assert.equal(extractInit([]), null);
    assert.equal(extractInit([{ type: 'system', subtype: 'other' }]), null);
  });

  it('extractResult reads the four usage numbers, cost, turns and duration', () => {
    const { events } = parseStreamText(fixtureText('claude-stream-ok.jsonl'));
    const result = extractResult(events);
    assert.ok(result);
    assert.equal(result.isError, false);
    assert.equal(result.subtype, 'success');
    assert.equal(result.text, 'ok');
    assert.deepEqual(result.usage, { input: 2, output: 4, cacheCreation: 2250, cacheRead: 649 });
    assert.equal(result.totalCostUsd, 0.0091089);
    assert.equal(result.numTurns, 1);
    assert.equal(result.durationMs, 1171);
  });

  it('extractResult returns null when no result event arrived', () => {
    assert.equal(extractResult([{ type: 'system', subtype: 'init' }]), null);
  });
});

describe('fixtures', () => {
  it('claude-stream-ok.jsonl has at least three lines and an init event', () => {
    const lines = fixtureText('claude-stream-ok.jsonl').split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length >= 3);
    assert.ok(lines.some((l) => l.includes('"subtype":"init"')));
  });

  it('[T-03-33] recorded fixtures carry no home directory, user name or absolute user path', () => {
    for (const name of ['claude-stream-ok.jsonl', 'claude-stream-tools.jsonl']) {
      const text = fixtureText(name);
      assert.ok(!text.includes(homedir()), `${name} contains the home directory`);
      assert.ok(!text.includes(`/${userInfo().username}/`), `${name} contains the account name as a path part`);
      assert.ok(!/\/Users\/[^/"\\]+/.test(text), `${name} contains a /Users/ path`);
    }
  });
});

describe('runClaudeSession against the fake executable', () => {
  it('returns status ok, the init event, the result, zero tool calls and a wall time', async () => {
    const outcome = await runClaudeSession(baseSpec());
    assert.equal(outcome.status, 'ok');
    assert.ok(outcome.init);
    assert.equal(outcome.init.model, 'claude-sonnet-5-5');
    assert.ok(outcome.result);
    assert.equal(outcome.result.text, 'ok');
    assert.equal(outcome.toolCallTotal, 0);
    assert.deepEqual(outcome.toolCalls, {});
    assert.equal(outcome.ignoredLines, 0);
    assert.ok(outcome.wallMs >= 0);
  });

  it('delivers the prompt on stdin and not in argv', async () => {
    const prompt = 'PROMPT-MARKER '.repeat(50);
    const outcome = await runClaudeSession(baseSpec({ prompt }));
    assert.equal(outcome.status, 'ok');
    const raw = outcome.result?.raw;
    assert.ok(raw);
    assert.equal(raw['fake_stdin_length'], Buffer.byteLength(prompt));
    const argv = raw['fake_argv'];
    assert.ok(Array.isArray(argv));
    assert.ok(!argv.some((a) => typeof a === 'string' && a.includes('PROMPT-MARKER')));
  });

  it('passes the built flags to the child after the prefix arguments', async () => {
    const outcome = await runClaudeSession(baseSpec({ tools: ['Bash'] }));
    const argv = outcome.result?.raw['fake_argv'];
    assert.ok(Array.isArray(argv));
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.ok(argv.includes('--no-session-persistence'));
  });

  it('does not throw when the executable does not exist; it reports an error outcome', async () => {
    const outcome = await runClaudeSession(
      baseSpec({ executable: join(fixtureDir, 'definitely-not-here'), prefixArgs: [] }),
    );
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.result, null);
    assert.ok(outcome.stderrTail.length > 0);
  });
});

describe('billableTokens and cacheReadTokens', () => {
  it('billableTokens sums input, output, cache creation and cache read', () => {
    assert.equal(billableTokens({ input: 10, output: 20, cacheCreation: 30, cacheRead: 40 }), 100);
  });

  it('cacheReadTokens reports the cache read field on its own', () => {
    assert.equal(cacheReadTokens({ input: 10, output: 20, cacheCreation: 30, cacheRead: 40 }), 40);
  });

  it('billableTokens of the recorded result usage adds all four fields', () => {
    const { events } = parseStreamText(fixtureText('claude-stream-ok.jsonl'));
    const result = extractResult(events);
    assert.ok(result);
    assert.equal(billableTokens(result.usage), 2 + 4 + 2250 + 649);
    assert.equal(cacheReadTokens(result.usage), 649);
  });

  it('both reject a negative or non-integer field with a RangeError', () => {
    const good = { input: 1, output: 1, cacheCreation: 1, cacheRead: 1 };
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const field of ['input', 'output', 'cacheCreation', 'cacheRead'] as const) {
        const usage: Usage = { ...good, [field]: bad };
        assert.throws(() => billableTokens(usage), RangeError, `billableTokens ${field}=${bad}`);
        assert.throws(() => cacheReadTokens(usage), RangeError, `cacheReadTokens ${field}=${bad}`);
      }
    }
  });
});

describe('countToolCalls', () => {
  it('counts the recorded tools session as Bash 2, Read 1, total 3', () => {
    const { events } = parseStreamText(fixtureText('claude-stream-tools.jsonl'));
    const counts = countToolCalls(events);
    assert.deepEqual(counts, { Bash: 2, Read: 1 });
    assert.equal(sumToolCalls(counts), 3);
  });

  it('counts an MCP tool under its full name', () => {
    const events: StreamEvent[] = [
      {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__gsd-atlas__code_refs', input: {} }] },
      },
    ];
    assert.deepEqual(countToolCalls(events), { 'mcp__gsd-atlas__code_refs': 1 });
  });

  it('deduplicates on the tool_use block id, because message ids repeat across stream events', () => {
    const block = { type: 'tool_use', id: 'dup-1', name: 'Bash', input: {} };
    const events: StreamEvent[] = [
      { type: 'assistant', message: { id: 'same', content: [block] } },
      { type: 'assistant', message: { id: 'same', content: [block, { type: 'text', text: 'hi' }] } },
      {
        type: 'assistant',
        message: { id: 'same', content: [{ type: 'tool_use', id: 'dup-2', name: 'Bash', input: {} }] },
      },
    ];
    assert.deepEqual(countToolCalls(events), { Bash: 2 });
  });

  it('ignores tool_use blocks outside assistant events and survives a tool named __proto__', () => {
    const events: StreamEvent[] = [
      { type: 'user', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: '__proto__' }] } },
    ];
    const counts = countToolCalls(events);
    assert.equal(sumToolCalls(counts), 1);
    assert.equal(Object.keys(counts).length, 1);
  });
});

describe('assertToolSet', () => {
  const init: InitEvent = {
    tools: ['Bash', 'Read'],
    mcpServers: [{ name: 'gsd-atlas', status: 'connected' }],
    skills: ['gsd-atlas-eval:gsd-atlas', 'simplify'],
    plugins: [],
    agents: [],
    model: 'm',
    cwd: '/w',
  };

  it('returns no differences when tools, servers and skills match', () => {
    assert.deepEqual(
      assertToolSet(init, { tools: ['Read', 'Bash'], mcpServers: ['gsd-atlas'], skills: ['gsd-atlas-eval:gsd-atlas'] }),
      [],
    );
  });

  it('reports one human-readable difference per mismatch', () => {
    const diffs = assertToolSet(init, {
      tools: ['Bash', 'Grep'],
      mcpServers: ['other'],
      skills: ['missing-skill'],
    });
    assert.deepEqual(diffs.slice().sort(), [
      'extra tool: Read',
      'mcp server absent: other',
      'missing tool: Grep',
      'skill absent: missing-skill',
      'unexpected mcp server: gsd-atlas',
    ]);
  });

  it('flags an unexpected mcp server when none are expected', () => {
    const diffs = assertToolSet({ ...init, tools: ['Bash'] }, { tools: ['Bash'], mcpServers: [] });
    assert.deepEqual(diffs, ['unexpected mcp server: gsd-atlas']);
  });

  it('reports a missing init event instead of passing', () => {
    assert.deepEqual(assertToolSet(null, { tools: ['Bash'], mcpServers: [] }), ['init event absent']);
  });
});

describe('statusOf', () => {
  const ok = { isError: false, subtype: 'success' } as ResultEvent;
  const failed = { isError: true, subtype: 'error_during_execution' } as ResultEvent;
  const budget = { isError: true, subtype: 'error_max_budget_usd' } as ResultEvent;
  const none = { timedOut: false, capExceeded: false };
  const exit = (code: number | null, signal: string | null = null, spawnFailed = false): ExitInfo => ({
    code,
    signal,
    spawnFailed,
  });
  const cases: Array<[string, ExitInfo, ResultEvent | null, { timedOut: boolean; capExceeded: boolean }, SessionStatus]> = [
    ['clean result', exit(0), ok, none, 'ok'],
    ['result decides when the exit code disagrees', exit(1), ok, none, 'ok'],
    ['is_error result', exit(1), failed, none, 'error'],
    ['budget subtype', exit(1), budget, none, 'budget'],
    ['finished before the timer fired', exit(0), ok, { timedOut: true, capExceeded: false }, 'ok'],
    ['timer killed it with no result', exit(null, 'SIGKILL'), null, { timedOut: true, capExceeded: false }, 'timeout'],
    ['cap killed it with no result', exit(null, 'SIGKILL'), null, { timedOut: false, capExceeded: true }, 'killed'],
    ['timeout wins over cap when both fired', exit(null, 'SIGKILL'), null, { timedOut: true, capExceeded: true }, 'timeout'],
    ['exit 0 without a result', exit(0), null, none, 'error'],
    ['non-zero exit without a result', exit(3), null, none, 'error'],
    ['killed by a signal we did not send', exit(null, 'SIGTERM'), null, none, 'killed'],
    ['spawn failure', exit(null, null, true), null, none, 'error'],
  ];
  for (const [title, exitInfo, result, flags, expected] of cases) {
    it(`${title} gives ${expected}`, () => {
      assert.equal(statusOf(exitInfo, result, flags), expected);
    });
  }
});

describe('runClaudeSession bounds and failure outcomes', () => {
  it('timeout: kills a slow child within 2 seconds and still returns the init event', async () => {
    const started = Date.now();
    const outcome = await runClaudeSession(baseSpec({ wallClockMs: 300, env: { FAKE_CLAUDE_MODE: 'slow' } }));
    assert.equal(outcome.status, 'timeout');
    assert.ok(Date.now() - started < 2_000);
    assert.ok(outcome.init, 'init event that arrived before the kill is kept');
    assert.equal(outcome.result, null);
  });

  it('huge output: kills the child at the stdout cap and never retains more than the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-session-'));
    try {
      const rawStreamPath = join(dir, 'raw.jsonl');
      const cap = 64 * 1024;
      const outcome = await runClaudeSession(
        baseSpec({ maxStdoutBytes: cap, rawStreamPath, env: { FAKE_CLAUDE_MODE: 'huge' } }),
      );
      assert.equal(outcome.status, 'killed');
      assert.ok(outcome.init, 'the init event inside the cap is kept');
      assert.equal(statSync(rawStreamPath).size, cap);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error: non-zero exit with no result yields error and a stderr tail of at most 2000 characters', async () => {
    const outcome = await runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'error' } }));
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.result, null);
    assert.ok(outcome.stderrTail.length <= 2_000);
    assert.ok(outcome.stderrTail.endsWith('END-OF-STDERR'));
  });

  it('a result event with is_error true yields error and keeps the result', async () => {
    const outcome = await runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'error-result' } }));
    assert.equal(outcome.status, 'error');
    assert.ok(outcome.result);
    assert.equal(outcome.result.isError, true);
  });

  it('a budget-stop subtype yields budget', async () => {
    const outcome = await runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'budget' } }));
    assert.equal(outcome.status, 'budget');
  });

  it('a cost above the budget flag does not change the status and is returned as given', async () => {
    const outcome = await runClaudeSession(baseSpec({ maxBudgetUsd: 0.5, env: { FAKE_CLAUDE_MODE: 'costly' } }));
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.result?.totalCostUsd, 99);
  });

  it('[edge EVL-03/partial-output] a stream cut mid-line yields the events read and the ignored-line count', async () => {
    const outcome = await runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'partial' } }));
    assert.equal(outcome.status, 'error');
    assert.ok(outcome.init);
    assert.equal(outcome.result, null);
    assert.equal(outcome.ignoredLines, 3);
  });

  it('counts tool calls of the recorded tools session', async () => {
    const outcome = await runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'tools' } }));
    assert.equal(outcome.status, 'ok');
    assert.deepEqual(outcome.toolCalls, { Bash: 2, Read: 1 });
    assert.equal(outcome.toolCallTotal, 3);
    assert.deepEqual(outcome.init?.tools, ['Bash', 'Read']);
  });

  it('concurrent calls do not share state', async () => {
    const [a, b, c] = await Promise.all([
      runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_TAG: '-A' } })),
      runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'tools', FAKE_CLAUDE_TAG: '-B' } })),
      runClaudeSession(baseSpec({ env: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_TAG: '-C' } })),
    ]);
    assert.equal(a.result?.text, 'ok-A');
    assert.equal(b.result?.text.endsWith('-B'), true);
    assert.equal(c.result?.text, 'ok-C');
    assert.equal(a.toolCallTotal, 0);
    assert.equal(b.toolCallTotal, 3);
    assert.equal(c.toolCallTotal, 0);
  });
});

describe('independence from the system under test (D-02)', () => {
  it('no .ts file in scripts/eval imports from a path containing src/', () => {
    const offenders: string[] = [];
    const specifier = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;
    for (const name of readdirSync(import.meta.dirname)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(join(import.meta.dirname, name), 'utf8');
      for (const match of text.matchAll(specifier)) {
        const target = match[1] ?? '';
        if (/(^|\/)src(\/|$)/.test(target)) offenders.push(`${name}: ${target}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
