import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runJob } from './driver.ts';
import type { Job, JobDeps } from './driver.ts';

const fake = path.resolve(import.meta.dirname, '__fixtures__', 'fake-claude.mjs');

function deps(root: string, answerFiles: string): JobDeps {
  const corpus = path.join(root, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'a.txt'), 'hello');
  return {
    corpusDir: corpus,
    scratchDir: path.join(root, 'scratch'),
    outDir: path.join(root, 'out'),
    atlasBin: path.resolve(import.meta.dirname, '..', '..', 'dist', 'bin', 'gsd-atlas.js'),
    skillPath: path.resolve(import.meta.dirname, '..', '..', 'skills', 'gsd-atlas', 'SKILL.md'),
    hookScript: path.resolve(import.meta.dirname, 'route-hook.ts'),
    answerSchema: '{"type":"object"}',
    model: 'claude-sonnet-5-5',
    questions: new Map([['pq-001', { id: 'pq-001', category: 'callers', text: 'Which files call `f`?', key: { kind: 'callers', symbol: 'f', definedIn: 'a.txt', granularity: 'file', equality: 'exact-set' } }]]),
    keyFiles: new Map([['pq-001', ['src/a.cts', 'tests/b.cjs']]]),
    executable: process.execPath,
    executablePrefix: [fake],
    env: { FAKE_ANSWER_FILES: answerFiles },
    nice: false,
  };
}

describe('runJob', () => {
  it('runs a grep session through the executable and returns a compact record', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-driver-'));
    try {
      const job: Job = { jobId: 'p3-grep-pq-001-1', probe: 'P3', config: 'grep', questionId: 'pq-001', run: 1, maxBudgetUsd: 0.5 };
      const { record, rawStream } = await runJob(job, deps(root, './src/a.cts,tests/b.cjs'));
      assert.equal(record.jobId, job.jobId);
      assert.equal(record.status, 'ok');
      assert.deepEqual(record.firstRequest, { input: 2, cacheCreation: 100, cacheRead: 10, total: 112 });
      assert.equal(record.usage.billable, 237);
      assert.equal(record.atlasCalls, 0);
      assert.equal(record.costUsd, 0.01);
      assert.deepEqual(record.answer, { files: 2, equal: true, matched: 2, missing: 0, extra: 0 });
      assert.equal(record.rate.fiveHour, 0.02);
      assert.ok(fs.existsSync(rawStream));
      // Nothing of the answer text is kept in the record.
      assert.doesNotMatch(JSON.stringify(record), /prompt chars/);
      // The session directory is removed afterwards.
      assert.equal(fs.existsSync(path.join(root, 'scratch', 'sessions', job.jobId)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records an unequal answer descriptively', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-driver-'));
    try {
      const job: Job = { jobId: 'p3-grep-pq-001-2', probe: 'P3', config: 'grep', questionId: 'pq-001', run: 2, maxBudgetUsd: 0.5 };
      const { record } = await runJob(job, deps(root, 'src/a.cts,src/extra.cts'));
      assert.deepEqual(record.answer, { files: 2, equal: false, matched: 1, missing: 1, extra: 1 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the one-turn prompt for a job without a question and records no answer comparison', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-driver-'));
    try {
      const job: Job = { jobId: 'p1-grep-1', probe: 'P1', config: 'grep', run: 1, maxBudgetUsd: 0.25 };
      const { record } = await runJob(job, deps(root, ''));
      assert.equal(record.answer, null);
      assert.equal(record.questionId, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
