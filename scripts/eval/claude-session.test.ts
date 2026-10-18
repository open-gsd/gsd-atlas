import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildClaudeArgs,
  extractInit,
  extractResult,
  parseStreamText,
  runClaudeSession,
} from './claude-session.ts';
import type { SessionSpec } from './claude-session.ts';

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
