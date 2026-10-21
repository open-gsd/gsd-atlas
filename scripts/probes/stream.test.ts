import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareToKey, rateLimitOf, recordOf, resultBytesByTool } from './stream.ts';

const line = (o: unknown): string => JSON.stringify(o);

const stream = [
  line({ type: 'system', subtype: 'init', tools: ['Bash', 'Read', 'Skill', 'mcp__gsd-atlas__code_refs', 'StructuredOutput'], skills: ['gsd-atlas-eval:gsd-atlas'], mcp_servers: [{ name: 'gsd-atlas', status: 'connected' }], model: 'claude-sonnet-5-5', claude_code_version: '2.1.305', apiKeySource: 'none' }),
  line({
    type: 'assistant',
    message: { id: 'm1', usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 20 }, content: [{ type: 'tool_use', id: 't1', name: 'mcp__gsd-atlas__code_refs', input: { name: 'x' } }] },
  }),
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false, overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1 }, seven_day: { utilization: 0.31, resetsAt: 2 } } } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a'.repeat(300) }] } }),
  line({
    type: 'assistant',
    message: { id: 'm2', usage: { input_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 1300, output_tokens: 40 }, content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'gsd-atlas-eval:gsd-atlas' } }, { type: 'tool_use', id: 't3', name: 'StructuredOutput', input: {} }] },
  }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'b'.repeat(100) }] }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, num_turns: 2, duration_ms: 5000, result: '', structured_output: { answer: 'found', items: [{ file: './src/a.cts', line: 3 }, { file: 'tests/b.test.cjs' }], summary: 's' }, usage: { input_tokens: 4, cache_creation_input_tokens: 1050, cache_read_input_tokens: 1500, output_tokens: 60 } }),
].join('\n');

describe('recordOf', () => {
  const r = recordOf(stream, { wallMs: 5100 });
  it('splits the first request and the session usage', () => {
    assert.deepEqual(r.firstRequest, { input: 3, cacheCreation: 1000, cacheRead: 200, total: 1203 });
    assert.deepEqual(r.usage, { input: 4, cacheCreation: 1050, cacheRead: 1500, output: 60, billable: 2614 });
  });
  it('counts tool calls, atlas calls and skill loads', () => {
    assert.equal(r.toolCalls, 3);
    assert.equal(r.toolCallsExStructured, 2);
    assert.equal(r.atlasCalls, 1);
    assert.equal(r.skillLoaded, true);
    assert.deepEqual(r.byTool, { 'mcp__gsd-atlas__code_refs': 1, Skill: 1, StructuredOutput: 1 });
  });
  it('records the init facts, cost and the version without secrets', () => {
    assert.equal(r.init?.toolCount, 5);
    assert.equal(r.init?.mcpToolCount, 1);
    assert.equal(r.claudeCodeVersion, '2.1.305');
    assert.equal(r.costUsd, 0.0123);
    assert.equal(r.wallMs, 5100);
    assert.equal(r.status, 'ok');
  });
  it('reads the answer files normalised to repo-relative paths', () => {
    assert.deepEqual(r.answerFiles, ['src/a.cts', 'tests/b.test.cjs']);
  });
});

describe('rateLimitOf', () => {
  it('takes the last event: five hour, seven day, overage', () => {
    assert.deepEqual(rateLimitOf(stream), { fiveHour: 0.12, sevenDay: 0.31, isUsingOverage: false, overageStatus: 'rejected' });
  });
  it('is null fields when there is no event', () => {
    assert.deepEqual(rateLimitOf(''), { fiveHour: null, sevenDay: null, isUsingOverage: null, overageStatus: null });
  });
});

describe('resultBytesByTool', () => {
  it('pairs tool results with the tool that was called and measures bytes', () => {
    assert.deepEqual(resultBytesByTool(stream), [
      { tool: 'mcp__gsd-atlas__code_refs', bytes: 300 },
      { tool: 'Skill', bytes: 100 },
    ]);
  });
});

describe('compareToKey', () => {
  it('is equal for the same file set regardless of order and duplicates', () => {
    assert.deepEqual(compareToKey(['b', 'a', 'a'], ['a', 'b']), { equal: true, matched: 2, missing: 0, extra: 0 });
  });
  it('counts missing and extra', () => {
    assert.deepEqual(compareToKey(['a', 'c'], ['a', 'b']), { equal: false, matched: 1, missing: 1, extra: 1 });
  });
  it('treats an answer without items as unequal', () => {
    assert.equal(compareToKey([], ['a']).equal, false);
  });
});
