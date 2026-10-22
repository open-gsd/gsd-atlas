import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runChunks } from './driver.ts';
import { buildSchedule, chunkSchedule, type PilotJob, type PilotRecord } from './pilot-plan.ts';

const driver = path.resolve(import.meta.dirname, 'driver.ts');
const IDS = Array.from({ length: 16 }, (_, i) => `p-${String(201 + i)}`);

const okRecord = (job: PilotJob, over: Partial<PilotRecord> = {}): PilotRecord => ({
  jobId: job.jobId,
  condition: job.condition,
  status: 'ok',
  claudeCodeVersion: '2.1.305',
  apiKeySource: 'none',
  initMcpToolCount: job.condition === 'G' ? 0 : 7,
  atlasCalls: 0,
  usage: { billable: 1000 },
  costUsd: 0.1,
  rate: { fiveHour: 0.1, sevenDay: 0.1, isUsingOverage: false, overageStatus: 'rejected' },
  ...over,
});

describe('driver --dry-run', () => {
  it('prints the schedule and the commands from the real question file and launches nothing', () => {
    const r = spawnSync(process.execPath, [driver, '--dry-run'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN: no session is launched/);
    assert.equal(r.stdout.split('\n').filter((l) => /^\s+\d{3}\s+ang-/.test(l)).length, 96);
    assert.match(r.stdout, /notional cap 4\.00 USD/);
    assert.doesNotMatch(r.stdout, /sk-ant|ANTHROPIC_API_KEY=/);
  });
  it('takes a raised cap explicitly and rejects one above the ceiling', () => {
    const ok = spawnSync(process.execPath, [driver, '--dry-run', '--cap-usd', '12'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.match(ok.stdout, /notional cap 12\.00 USD/);
    const bad = spawnSync(process.execPath, [driver, '--dry-run', '--cap-usd', '99'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /ceiling/);
  });
  it('refuses to run sessions without an explicit --launch', () => {
    const r = spawnSync(process.execPath, [driver, '--stage', 'pilot'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--launch/);
  });
});

describe('runChunks', () => {
  const chunks = chunkSchedule(buildSchedule(IDS), 16);
  const base = { capUsd: 30, spentBefore: 0, expectedVersion: '2.1.305', concurrency: 1 as const, authOk: () => true };

  it('runs every chunk in order when all checks pass, skipping jobs that are already done', async () => {
    const ran: string[] = [];
    const done = new Set([chunks[0]![0]!.jobId]);
    const res = await runChunks({ ...base, chunks: chunks.slice(0, 2), done, runOne: async (j) => (ran.push(j.jobId), okRecord(j)) });
    assert.equal(res.stoppedAt, null);
    assert.equal(ran.length, 29);
    assert.ok(!ran.includes(chunks[0]![0]!.jobId));
    assert.deepEqual(ran.slice(0, 2), [chunks[0]![1]!.jobId, chunks[0]![2]!.jobId]);
  });

  it('stops at the first infrastructure failure, before the rest of the chunk', async () => {
    const ran: string[] = [];
    const res = await runChunks({ ...base, chunks, done: new Set(), runOne: async (j) => (ran.push(j.jobId), okRecord(j, ran.length === 4 ? { status: 'no_result/ok' } : {})) });
    assert.equal(ran.length, 4);
    assert.equal(res.stoppedAt, 0);
    assert.match(res.reasons.join(' '), /infrastructure/);
  });

  it('stops before a session that could pass the cap', async () => {
    const ran: string[] = [];
    const res = await runChunks({ ...base, capUsd: 1, chunks, done: new Set(), runOne: async (j) => (ran.push(j.jobId), okRecord(j, { costUsd: 0.5 })) });
    assert.equal(ran.length, 1);
    assert.match(res.reasons.join(' '), /cap/);
  });

  it('stops when the subscription login check fails, before any session', async () => {
    const ran: string[] = [];
    const res = await runChunks({ ...base, authOk: () => false, chunks, done: new Set(), runOne: async (j) => (ran.push(j.jobId), okRecord(j)) });
    assert.equal(ran.length, 0);
    assert.match(res.reasons.join(' '), /auth/);
  });

  it('stops at 0.60 on a rate window right after the session that read it', async () => {
    const ran: string[] = [];
    const res = await runChunks({ ...base, chunks, done: new Set(), runOne: async (j) => (ran.push(j.jobId), okRecord(j, ran.length === 2 ? { rate: { fiveHour: 0.6, sevenDay: 0.1, isUsingOverage: false, overageStatus: 'rejected' } } : {})) });
    assert.equal(ran.length, 2);
    assert.match(res.reasons.join(' '), /five-hour/);
  });

  it('runs two at a time only in a grep-only chunk', async () => {
    const grepOnly: PilotJob[][] = [buildSchedule(IDS).filter((j) => j.condition === 'G').slice(0, 6)];
    let live = 0;
    let peak = 0;
    const slow = async (j: PilotJob): Promise<PilotRecord> => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return okRecord(j);
    };
    await runChunks({ ...base, concurrency: 2, chunks: grepOnly, done: new Set(), runOne: slow });
    assert.equal(peak, 2);
    peak = 0;
    await runChunks({ ...base, concurrency: 2, chunks: [chunks[0]!], done: new Set(), runOne: slow });
    assert.equal(peak, 1);
  });
});
