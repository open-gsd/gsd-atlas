/**
 * The store size gate (STO-05, plans 02-18 and 02-37): after many edits, with the idle maintenance loop running at
 * its normal cadence, the database is at most 1.25 times a fresh build of the same final tree, measured on the
 * idle-only size (before any explicit full compaction). These tests run it scaled down (the full 20,000 edits run
 * in the CI gate job), and prove the gate can fail: the old idle policy and no maintenance both exceed the bound.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { lifecycleTestHooks, resetLifecycleTestHooks } from '../src/fact-store/lifecycle.ts';
import { runCli, runSizeGate } from './size-gate.ts';

/** The approved `gate.storeEditsRatio` of 02-CONSTANTS.md. */
const MAX_RATIO = 1.25;

/**
 * The smallest scale found by measurement at which the old idle policy (`maintain` without the full-compaction
 * request) leaves the idle size above 1.25 times a fresh build: 150 files, 1,500 edits, maintain every 100 edits
 * (idle ratio about 1.34 under the old policy). It runs in under a second.
 */
const SCALE = { files: 150, symbolsPerFile: 8, edits: 1500, maxRatio: MAX_RATIO, maintainEvery: 100 } as const;

describe('size gate', () => {
  afterEach(() => resetLifecycleTestHooks());

  it('idle policy passes: the idle-only size is within 1.25 times a fresh build', async () => {
    const result = await runSizeGate(SCALE);
    assert.ok(result.freshBytes > 0);
    assert.ok(result.idleBytes > 0);
    assert.ok(result.ratio <= MAX_RATIO, `idle ${result.idleBytes} bytes against fresh ${result.freshBytes}: ratio ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, true);
    assert.equal(result.ratio, result.idleBytes / result.freshBytes);
    assert.equal(result.settledRatio, result.editedBytes / result.freshBytes);
  });

  it('old policy is over: the same edits with the old idle policy exceed the bound, whatever the final compaction does', async () => {
    const result = await runSizeGate({ ...SCALE, idle: {} });
    assert.ok(result.ratio > MAX_RATIO, `the old policy gave only ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, false);
    // The explicit final compaction hides the gap, which is exactly why it must not decide the gate.
    assert.ok(result.settledRatio <= MAX_RATIO, `the settled ratio was ${result.settledRatio.toFixed(3)}`);
  });

  it('maintenance off is over: the same edits with maintenance disabled exceed the ratio, so the gate can fail', async () => {
    const result = await runSizeGate({ ...SCALE, maintainEvery: 0 });
    assert.ok(result.ratio > MAX_RATIO, `without maintenance the ratio was only ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, false);
  });

  it('zero edits: the idle size is the fresh-equivalent and the gate passes', async () => {
    const result = await runSizeGate({ ...SCALE, edits: 0 });
    assert.equal(result.ratio, 1, `with no edits the idle ratio was ${result.ratio.toFixed(4)}`);
    assert.equal(result.ok, true);
  });

  it('maintenance after every edit passes', async () => {
    const result = await runSizeGate({ files: 30, symbolsPerFile: 6, edits: 120, maxRatio: MAX_RATIO, maintainEvery: 1 });
    assert.ok(result.ratio <= MAX_RATIO, `maintaining every edit gave ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, true);
  });

  it('a store whose last maintain call was followed by more edits is measured after the settle loop', async () => {
    // 1,550 is not a multiple of 100: the last 50 edits are only maintained by the settle loop.
    const result = await runSizeGate({ ...SCALE, edits: 1550 });
    assert.ok(result.ratio <= MAX_RATIO, `an unaligned edit count gave ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, true);
  });

  it('reports the vacuums of the idle loop: at least one under the idle policy, none under the old policy', async () => {
    const idle = await runSizeGate(SCALE);
    assert.ok(idle.vacuums >= 1, `the idle policy ran ${idle.vacuums} vacuums`);
    const old = await runSizeGate({ ...SCALE, idle: {} });
    assert.equal(old.vacuums, 0);
  });

  it('reports the longest single maintain call in wall-clock milliseconds, without asserting it', async () => {
    const result = await runSizeGate({ files: 30, symbolsPerFile: 6, edits: 120, maxRatio: MAX_RATIO, maintainEvery: 40 });
    assert.ok(Number.isFinite(result.longestMaintainMs) && result.longestMaintainMs >= 0, `longestMaintainMs was ${result.longestMaintainMs}`);
    // The figure is wall clock and never decides `ok`: an absurd limit on it cannot exist, and the sizes stay deterministic.
    assert.equal(result.ok, true);
  });

  it('leaves no lifecycle hook behind, also when the run throws', async () => {
    await runSizeGate({ files: 20, symbolsPerFile: 4, edits: 40, maxRatio: MAX_RATIO, maintainEvery: 20 });
    assert.deepEqual(Object.keys(lifecycleTestHooks), []);
    await assert.rejects(runSizeGate({ files: 0 }), /--files/);
    assert.deepEqual(Object.keys(lifecycleTestHooks), []);
  });

  it('names the in-page rule it used: dbstat present here, absent when forced, and the bound holds on the fallback rule too', async () => {
    const normal = await runSizeGate(SCALE);
    assert.equal(normal.dbstat, 'present');
    lifecycleTestHooks.noDbstat = true;
    const forced = await runSizeGate(SCALE);
    assert.equal(forced.dbstat, 'absent');
    assert.ok(forced.ratio <= MAX_RATIO, `the fallback rule gave ${forced.ratio.toFixed(3)}`);
    assert.equal(forced.ok, true);
    assert.deepEqual(Object.keys(lifecycleTestHooks), []);
  });

  it('deterministic: two runs of the same options give the same sizes', async () => {
    const options = { files: 60, symbolsPerFile: 6, edits: 300, maxRatio: MAX_RATIO, maintainEvery: 100 };
    const first = await runSizeGate(options);
    const second = await runSizeGate(options);
    assert.equal(second.freshBytes, first.freshBytes);
    assert.equal(second.idleBytes, first.idleBytes);
    assert.equal(second.editedBytes, first.editedBytes);
  });

  it('the command line prints the idle and settled sizes, the asserted idle ratio and OK, and returns 0', async () => {
    const lines: string[] = [];
    const code = await runCli(['--files', '60', '--symbols', '6', '--edits', '300', '--maintain-every', '100'], (text) => lines.push(text));
    const output = lines.join('');
    assert.equal(code, 0);
    assert.match(output, /freshBytes \d+/);
    assert.match(output, /idleBytes \d+/);
    assert.match(output, /idleRatio \d+\.\d+/);
    assert.match(output, /settledBytes \d+/);
    assert.match(output, /settledRatio \d+\.\d+/);
    assert.match(output, /vacuums \d+/);
    assert.match(output, /longestMaintainMs \d+(\.\d+)?/);
    assert.match(output, /dbstat (present|absent)/);
    assert.match(output, /\bOK\b/);
  });

  it('the command line returns 1 and prints OVER when the idle ratio is above the limit', async () => {
    const lines: string[] = [];
    const code = await runCli(['--files', '60', '--symbols', '6', '--edits', '300', '--maintain-every', '100', '--max-ratio', '0.5'], (text) => lines.push(text));
    assert.equal(code, 1);
    assert.match(lines.join(''), /\bOVER\b/);
  });

  it('the command line rejects a value that is not a positive number', async () => {
    const failed = (argv: string[]): Promise<string> => runCli(argv, () => undefined).then(() => '', (error: unknown) => String(error));
    const edits = await failed(['--edits', 'many']);
    assert.ok(edits.includes('--edits'), `the error for a bad --edits was: ${edits}`);
    const files = await failed(['--files', '0']);
    assert.ok(files.includes('--files'), `the error for a bad --files was: ${files}`);
  });
});
