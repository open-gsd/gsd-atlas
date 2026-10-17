import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { MetricsReport } from '../metrics/index.ts';
import { THREE_FILES, makeWorld, storeIdOf, writeFiles } from './harness.test.ts';
import type { World } from './harness.test.ts';

interface StatusData {
  readonly report: MetricsReport;
  readonly tenant: { readonly metrics: { readonly recording: boolean } };
}

async function statusOf(world: World): Promise<StatusData> {
  const reply = await world.ask('status', { repo: world.repo.dir });
  assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
  assert.equal(reply.schema, 'gsd-atlas.status/1');
  return reply.data as StatusData;
}

describe('Host: recording (MET-02, D-17)', () => {
  it('the status report totals the answers served: code_find twice and atlas_status once', async (t) => {
    const world = await makeWorld(t);
    const repo = world.repo.dir;
    const built = await world.ask('build', { repo });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));

    assert.equal((await world.ask('code_find', { name: 'helper', repo })).ok, true);
    assert.equal((await world.ask('code_find', { name: 'nosuchthing', repo })).ok, true);
    assert.equal((await world.ask('atlas_status', { repo })).ok, true);
    // None of these is an answer.
    assert.equal((await world.ask('lang_list', {})).ok, true);
    assert.equal((await world.ask('maintain', { repo, task: 'check' })).ok, true);

    const { report } = await statusOf(world);
    assert.equal(report.answers.total, 3);
    assert.equal(report.answers.ok, 3);
    assert.deepEqual(report.answers.byTool, { atlas_status: 1, code_find: 2 });
    assert.equal(report.answers.latency.count, 3);
    assert.ok(report.tokens.estimatedTotal > 0, 'tokens served are counted');
    assert.equal(report.tokens.label, 'estimate');

    // The status request itself is not an answer either.
    const again = await statusOf(world);
    assert.equal(again.report.answers.total, 3);
  });

  it('a code_find before any build is an answer with ok false', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    // A worktree the store does not index: the tenant answers not_indexed, which is an answer (the Host-level
    // no-store answer of plan 02-41 is not recorded, since there is no store to record into).
    const linked = await world.addWorktree('unbuilt');
    const reply = await world.ask('code_find', { name: 'helper', repo: linked });
    assert.equal(reply.ok, false);
    const { report } = await statusOf(world);
    assert.equal(report.answers.total, 1);
    assert.equal(report.answers.ok, 0);
  });

  it('a fresh edit records its lag in the freshness panel', async (t) => {
    const world = await makeWorld(t);
    const repo = world.repo.dir;
    await world.ask('build', { repo });
    writeFiles(repo, { 'b.toy': 'fn helper_two {\n}\n' });
    const found = await world.ask('code_find', { name: 'helper_two', repo }, { fresh: ['b.toy'] });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));

    const { report } = await statusOf(world);
    assert.ok(report.freshness.count >= 1, 'a path indexed after an edit records its lag');
  });

  it('privacy: the bytes of metrics.db and its write-ahead file hold no symbol, path or source line', async (t) => {
    const symbol = 'zqxProbeSymbolUnlikelyAnywhereElse';
    const sourceLine = `fn ${symbol} {\n  distinctiveBodyToken();\n}\n`;
    const world = await makeWorld(t, { files: { ...THREE_FILES, 'probe.toy': sourceLine } });
    const repo = world.repo.dir;
    await world.ask('build', { repo });
    const found = await world.ask('code_find', { name: symbol, repo });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.match(found.untrusted_text?.entries[0]?.text ?? '', new RegExp(symbol));
    const { report } = await statusOf(world); // flushes the queue to the database
    assert.ok(report.answers.total >= 1);

    const dir = path.join(repo, '.git', 'gsd-atlas');
    const forbidden = [symbol, 'distinctiveBodyToken', 'probe.toy', repo, path.basename(repo)];
    const scan = (label: string): void => {
      for (const suffix of ['', '-wal']) {
        const file = path.join(dir, `metrics.db${suffix}`);
        if (!fs.existsSync(file)) continue;
        const bytes = fs.readFileSync(file);
        for (const needle of forbidden) {
          assert.equal(bytes.includes(Buffer.from(needle)), false, `${label}: metrics.db${suffix} contains ${needle}`);
        }
      }
    };
    assert.ok(fs.existsSync(path.join(dir, 'metrics.db')));
    scan('while open');
    await world.host.closeTenant(await storeIdOf(world.repo));
    scan('after close');
  });
});
