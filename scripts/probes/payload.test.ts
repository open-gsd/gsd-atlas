import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { median, payloadsOf, summarize } from './payload.ts';

const line = (o: unknown): string => JSON.stringify(o);
const asst = (id: string, input: number, out: number, uses: { id: string; name: string }[]): string =>
  line({
    type: 'assistant',
    message: {
      id,
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out },
      content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: {} })),
    },
  });
const result = (id: string, bytes: number): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(bytes) }] } });

// Turn 1 sends 1000 tokens; the call returns 4000 bytes; turn 2 sends 2500 tokens (previous output 100): the result cost 2500-1000-100 = 1400 tokens.
const session = [
  asst('m1', 1000, 100, [{ id: 'a', name: 'mcp__gsd-atlas__code_refs' }]),
  result('a', 4000),
  asst('m2', 2500, 50, [{ id: 'b', name: 'Bash' }]),
  result('b', 200),
  asst('m3', 2600, 20, []),
  line({ type: 'result', is_error: false, total_cost_usd: 0.1, usage: { input_tokens: 6100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 170 } }),
].join('\n');

describe('payloadsOf', () => {
  it('measures a result by the growth of the next request and counts the later requests that carry it', () => {
    const p = payloadsOf(session);
    assert.equal(p.length, 2);
    assert.deepEqual(p[0], { tool: 'mcp__gsd-atlas__code_refs', bytes: 4000, tokens: 1400, laterRequests: 2 });
    assert.equal(p[1]?.tool, 'Bash');
    assert.equal(p[1]?.laterRequests, 1);
  });
});

describe('summarize', () => {
  it('gives per tool calls, medians, the share over a byte threshold and the carried share of session tokens', () => {
    const s = summarize([session], [4096, 16384]);
    const refs = s.byTool['mcp__gsd-atlas__code_refs'];
    assert.ok(refs);
    assert.equal(refs.calls, 1);
    assert.equal(refs.medianBytes, 4000);
    assert.deepEqual(refs.overBytes, { 4096: 0, 16384: 0 });
    // carried = tokens x later requests = 1400 x 2; session tokens = 6100 + 170.
    assert.equal(refs.carriedTokens, 2800);
    assert.equal(s.sessionTokens, 6270);
  });
});

describe('median', () => {
  it('is the middle value, or the mean of the two middle values', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
  });
});
