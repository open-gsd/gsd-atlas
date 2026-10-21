#!/usr/bin/env node
// A stand-in for `claude -p`: reads the prompt from stdin, prints a canned stream-json session to stdout.
// FAKE_ANSWER_FILES is a comma separated list of files for the structured answer.
import process from 'node:process';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const files = (process.env.FAKE_ANSWER_FILES ?? '').split(',').filter((f) => f !== '');
  const out = [
    { type: 'system', subtype: 'init', tools: ['Bash', 'Read', 'StructuredOutput'], skills: [], mcp_servers: [], model: 'claude-sonnet-5-5', claude_code_version: '9.9.9', apiKeySource: 'none' },
    {
      type: 'assistant',
      message: { id: 'a', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false, overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: 0.02 }, seven_day: { utilization: 0.1 } } } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'x'.repeat(40) }] } },
    {
      type: 'assistant',
      message: { id: 'b', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 110, output_tokens: 9 }, content: [{ type: 'tool_use', id: 'u2', name: 'StructuredOutput', input: {} }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 2,
      duration_ms: 10,
      result: '',
      structured_output: { answer: 'found', items: files.map((file) => ({ file })), summary: `prompt chars ${String(prompt.length)}` },
      usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 120, output_tokens: 14 },
    },
  ];
  process.stdout.write(`${out.map((e) => JSON.stringify(e)).join('\n')}\n`);
});
