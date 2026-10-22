import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const script = path.join(import.meta.dirname, 'pilot-audit.ts');
const docs = path.join(import.meta.dirname, '..', '..', 'docs', 'eval', 'angular-pilot', 'v2');

const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('pilot-audit report on the committed pilot data', () => {
  const out = run(['--docs', docs]);

  it('exits 0 and prints the per-session table for the 23 non-exact sessions', () => {
    assert.equal(out.status, 0, out.stderr);
    const rows = out.stdout.split('\n').filter((l) => l.startsWith('| ang-'));
    assert.equal(rows.length, 23);
  });

  it('prints the original scoring that the results file reports', () => {
    assert.match(out.stdout, /\| original keys, as answered \|[^\n]*71\.9%[^\n]*71\.9%[^\n]*84\.4%/);
    assert.match(out.stdout, /stop and reconsider the token gate/);
  });

  it('prints the path-normalised scoring beside it', () => {
    assert.match(out.stdout, /\| original keys, leading packages\/ restored \|[^\n]*75\.0%[^\n]*75\.0%[^\n]*84\.4%/);
  });
});

describe('pilot-audit refusals', () => {
  it('fails when a missing or extra file has no verdict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-audit-'));
    try {
      for (const f of ['pilot-questions.json', 'pilot-answers.json']) fs.copyFileSync(path.join(docs, f), path.join(dir, f));
      fs.mkdirSync(path.join(dir, 'pilot'));
      for (const f of ['pilot-sessions.jsonl', 'summary.json']) fs.copyFileSync(path.join(docs, 'pilot', f), path.join(dir, 'pilot', f));
      fs.writeFileSync(path.join(dir, 'pilot-audit-verdicts.json'), JSON.stringify({ pathFormatSessions: [], verdicts: [] }));
      const r = run(['--docs', dir]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /has no verdict/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
