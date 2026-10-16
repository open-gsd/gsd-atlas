/**
 * The store size gate (STO-05, plan 02-18): after many edits, with idle maintenance running at its normal
 * cadence, the database is at most 1.25 times a fresh build of the same final tree. These tests run it scaled
 * down (the full 20,000 edits run in the CI gate job), and prove the gate can fail.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli, runSizeGate } from './size-gate.ts';

/** The approved `gate.storeEditsRatio` of 02-CONSTANTS.md. */
const MAX_RATIO = 1.25;

describe('size gate', () => {
  it('scaled: 2,000 edits with idle maintenance leave the store within 1.25 times a fresh build', async () => {
    const result = await runSizeGate({ files: 300, symbolsPerFile: 8, edits: 2000, maxRatio: MAX_RATIO, maintainEvery: 200 });
    assert.ok(result.freshBytes > 0);
    assert.ok(result.editedBytes > 0);
    assert.ok(result.ratio <= MAX_RATIO, `edited ${result.editedBytes} bytes against fresh ${result.freshBytes}: ratio ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, true);
    assert.equal(result.ratio, result.editedBytes / result.freshBytes);
  });

  it('negative control: the same edits with maintenance disabled exceed the ratio, so the gate can fail', async () => {
    const result = await runSizeGate({ files: 300, symbolsPerFile: 8, edits: 2000, maxRatio: MAX_RATIO, maintainEvery: 0 });
    assert.ok(result.ratio > MAX_RATIO, `without maintenance the ratio was only ${result.ratio.toFixed(3)}`);
    assert.equal(result.ok, false);
  });

  it('deterministic: two runs of the same options give the same sizes', async () => {
    const options = { files: 60, symbolsPerFile: 6, edits: 300, maxRatio: MAX_RATIO, maintainEvery: 100 };
    const first = await runSizeGate(options);
    const second = await runSizeGate(options);
    assert.equal(second.freshBytes, first.freshBytes);
    assert.equal(second.editedBytes, first.editedBytes);
  });

  it('the command line prints both sizes, the ratio and OK, and returns 0', async () => {
    const lines: string[] = [];
    const code = await runCli(['--files', '60', '--symbols', '6', '--edits', '300', '--maintain-every', '100'], (text) => lines.push(text));
    const output = lines.join('');
    assert.equal(code, 0);
    assert.match(output, /freshBytes \d+/);
    assert.match(output, /editedBytes \d+/);
    assert.match(output, /ratio \d+\.\d+/);
    assert.match(output, /\bOK\b/);
  });

  it('the command line returns 1 and prints OVER when the ratio is above the limit', async () => {
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
