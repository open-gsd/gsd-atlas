import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { summarize } from './trace-summary.ts';

const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'trace-sample.log'), 'utf8');

// Hand-computed from the fixture (nearest rank: the p-th percentile of n values is the value at rank ceil(p * n / 100)):
//   ls-files   closes 200.0, 20.0, 24.0   -> sorted 20, 24, 200: median rank 2 = 24.0, p95 rank 3 = 200.0, max 200.0
//   config     30.0, 32.0, 28.0, 30.0     -> sorted 28, 30, 30, 32: median rank 2 = 30.0, p95 rank 4 = 32.0
//   check-attr 34.0, 38.0, 36.0, 40.0     -> median 36.0, p95 40.0
//   hash-object 50.0, 52.0, 48.0, 56.0    -> median 50.0, p95 56.0
//   rev-parse  10.0                       -> 10.0 everywhere
//   edit saves (2000, 4000): spawns 3 and 4 -> median rank 1 = 3; events +12 and +10 -> 10.0; commits +100 and +90 -> 90.0
//   add saves (3000, 5000): spawns 4 and 4 -> 4; events +20 and +14 -> 14.0; commits +150 and +120 -> 120.0
//   COMMIT statements 1.20, 2.40, 0.80, 3.60 -> sorted 0.8, 1.2, 2.4, 3.6: median rank 2 = 1.2, max 3.6
//   malformed: the prose line and the CLOSE whose total is not a number
const EXPECTED = [
  'spawns by git subcommand: count median p95 max (ms, nearest rank)',
  'check-attr 4 36.0 40.0 40.0',
  'config 4 30.0 32.0 32.0',
  'hash-object 4 50.0 56.0 56.0',
  'ls-files 3 24.0 200.0 200.0',
  'rev-parse 1 10.0 10.0 10.0',
  'saves by kind: saves median-spawns median-write-to-event-ms median-write-to-commit-ms',
  'add 2 4 14.0 120.0',
  'edit 2 3 10.0 90.0',
  'commit statements: 4 median 1.20 ms max 3.60 ms',
  'malformed lines skipped: 2',
];

describe('trace-summary', () => {
  it('pins the summary of the fixture trace', () => {
    assert.deepEqual(summarize(fixture), EXPECTED);
  });

  it('malformed lines are skipped', () => {
    const noisy = `${fixture}\n\u0000garbage\n12.5 T0 SQL COMMIT fast\n99.00 T0 WRITE rename\n`;
    const lines = summarize(noisy);
    assert.deepEqual(lines.slice(0, -1), EXPECTED.slice(0, -1), 'the figures do not move');
    assert.equal(lines[lines.length - 1], 'malformed lines skipped: 5');
  });

  it('empty trace', () => {
    assert.deepEqual(summarize(''), ['no spawns recorded']);
    assert.deepEqual(summarize('\n\n'), ['no spawns recorded']);
    assert.deepEqual(summarize('only garbage\n'), ['no spawns recorded', 'malformed lines skipped: 1']);
  });

  it('the output contains no path', () => {
    // The trace holds no path, so neither does the summary: no line has a path separator or a drive letter.
    for (const line of summarize(fixture)) {
      assert.ok(!/[\\/]/.test(line) && !/[A-Za-z]:\\/.test(line), `a path in ${line}`);
    }
  });

  it('a trace with spawns but no saves still summarises the spawns', () => {
    const lines = summarize('10.00 T0 CLOSE #1 exit=0 total=5.0ms git config\n');
    assert.deepEqual(lines, ['spawns by git subcommand: count median p95 max (ms, nearest rank)', 'config 1 5.0 5.0 5.0', 'saves by kind: none recorded', 'commit statements: none recorded']);
  });
});
