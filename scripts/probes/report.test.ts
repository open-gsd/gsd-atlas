import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupStats, mean, renderTable } from './report.ts';
import type { ReportRecord } from './report.ts';

const rec = (config: string, first: number, billable: number, atlas: number, tools: number, cost: number, equal: boolean | null): ReportRecord => ({
  config,
  firstRequest: { total: first },
  usage: { input: 1, cacheCreation: 2, cacheRead: billable - 4, output: 1, billable },
  atlasCalls: atlas,
  toolCallsExStructured: tools,
  costUsd: cost,
  wallMs: 1000,
  skillLoaded: false,
  answer: equal === null ? null : { equal },
});

describe('mean', () => {
  it('is zero for no values', () => assert.equal(mean([]), 0));
  it('averages', () => assert.equal(mean([1, 2, 6]), 3));
});

describe('groupStats', () => {
  const records = [rec('a', 10, 100, 0, 2, 0.1, true), rec('a', 20, 300, 2, 4, 0.3, false), rec('a', 30, 200, 1, 3, 0.2, true), rec('b', 5, 50, 0, 1, 0.05, null)];
  const stats = groupStats(records, (r) => r.config);
  it('gives n, mean and median per group', () => {
    const a = stats.get('a');
    assert.ok(a);
    assert.equal(a.n, 3);
    assert.equal(a.firstRequest.mean, 20);
    assert.equal(a.billable.mean, 200);
    assert.equal(a.billable.median, 200);
    assert.equal(a.toolCalls.mean, 3);
    assert.equal(a.costUsd.sum, 0.6000000000000001);
  });
  it('counts sessions with an atlas call and equal answers', () => {
    const a = stats.get('a');
    assert.equal(a?.atlasSessions, 2);
    assert.equal(a?.answerEqual, 2);
    assert.equal(a?.answerScored, 3);
    assert.equal(stats.get('b')?.answerScored, 0);
  });
});

describe('renderTable', () => {
  it('renders a markdown table with a header and one row per group', () => {
    const records = [rec('a', 10, 100, 1, 2, 0.1, true)];
    const text = renderTable(groupStats(records, (r) => r.config), 'config');
    const lines = text.trim().split('\n');
    assert.match(lines[0] ?? '', /^\| config \| n \|/);
    assert.match(lines[1] ?? '', /^\| --- /);
    assert.match(lines[2] ?? '', /^\| a \| 1 \|/);
  });
});
