import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { makeTempDir } from '../src/test-kit/index.ts';
import { FRESHNESS_NIGHTLY_P99_MS, FRESHNESS_PR_CEILING_MS, percentile, runCli, runFreshnessGate } from './freshness-gate.ts';

/** A bound no real save can reach, so the measuring cases cannot flake. */
const NEVER_REACHED_MS = 600_000;

describe('percentile (nearest rank)', () => {
  it('for 100 sorted samples p99 is the 99th value and p50 the 50th', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(sorted, 99), 99);
    assert.equal(percentile(sorted, 95), 95);
    assert.equal(percentile(sorted, 50), 50);
    assert.equal(percentile(sorted, 100), 100);
  });

  it('for 10 samples p99 is the 10th, the largest', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(sorted, 99), 10);
    assert.equal(percentile(sorted, 95), 10);
    assert.equal(percentile(sorted, 50), 5);
  });

  it('for one sample every percentile is that sample', () => {
    for (const p of [1, 50, 95, 99, 100]) assert.equal(percentile([42], p), 42);
  });

  it('rounds the rank up: p90 of 15 samples is the 14th (ceil of 13.5)', () => {
    const sorted = Array.from({ length: 15 }, (_, index) => (index + 1) * 10);
    assert.equal(percentile(sorted, 90), 140);
  });

  it('throws on empty input and on a percentile outside (0, 100]', () => {
    assert.throws(() => percentile([], 99), /no samples/);
    assert.throws(() => percentile([1], 0), RangeError);
    assert.throws(() => percentile([1], 101), RangeError);
  });
});

describe('constants', () => {
  it('carry the approved gate values of 02-CONSTANTS.md', () => {
    assert.equal(FRESHNESS_PR_CEILING_MS, 3000);
    assert.equal(FRESHNESS_NIGHTLY_P99_MS, 1000);
  });
});

describe('runFreshnessGate with the real watcher', () => {
  it('measures three saves, orders the percentiles, alternates edits and new files, and removes its work directory', { timeout: 120_000 }, async () => {
    const tmp = makeTempDir();
    const lines: string[] = [];
    try {
      const result = await runFreshnessGate({ saves: 3, maxMs: NEVER_REACHED_MS, files: 30, tmpRoot: tmp.path, out: (line) => lines.push(line) });
      assert.equal(result.samples.length, 3);
      assert.ok(result.samples.every((ms) => Number.isFinite(ms) && ms >= 0));
      assert.ok(result.p50 <= result.p95 && result.p95 <= result.p99, `${String(result.p50)} <= ${String(result.p95)} <= ${String(result.p99)}`);
      assert.equal(result.p99, Math.max(...result.samples), 'with 3 samples the nearest-rank p99 is the largest');
      assert.deepEqual(result.kinds, ['edit', 'add', 'edit']);
      assert.equal(result.ok, true, result.message);
      const printed = lines.join('\n');
      assert.match(printed, /p50 \d+ ms/);
      assert.match(printed, /p95 \d+ ms/);
      assert.match(printed, /p99 \d+ ms/);
      assert.equal(fs.readdirSync(tmp.path).length, 0, 'the synthetic repository and the store are removed');
    } finally {
      tmp.cleanup();
    }
  });

  it('a bound of zero fails and the message names p99', { timeout: 120_000 }, async () => {
    const tmp = makeTempDir();
    try {
      const result = await runFreshnessGate({ saves: 2, maxMs: 0, files: 10, tmpRoot: tmp.path, out: () => undefined });
      assert.equal(result.ok, false);
      assert.match(result.message, /p99/);
    } finally {
      tmp.cleanup();
    }
  });

  it('the command line exits 1 above the bound and 0 within it, and refuses bad flags', { timeout: 180_000 }, async () => {
    const tmp = makeTempDir();
    const out: string[] = [];
    try {
      assert.equal(await runCli(['--saves', '2', '--max-ms', '0', '--files', '10'], (text) => out.push(text), { tmpRoot: tmp.path }), 1);
      assert.match(out.join(''), /OVER/);
      out.length = 0;
      assert.equal(await runCli(['--saves', '2', '--max-ms', String(NEVER_REACHED_MS), '--files', '10'], (text) => out.push(text), { tmpRoot: tmp.path }), 0);
      assert.match(out.join(''), /OK/);
      await assert.rejects(runCli(['--saves', '0'], () => undefined, { tmpRoot: tmp.path }), /--saves/);
      await assert.rejects(runCli(['--max-ms', 'soon'], () => undefined, { tmpRoot: tmp.path }), /--max-ms/);
    } finally {
      tmp.cleanup();
    }
  });
});
