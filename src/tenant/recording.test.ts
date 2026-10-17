import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROTOCOL_VERSION, systemClock } from '../facts/index.ts';
import type { DegradedCode, Envelope } from '../facts/index.ts';
import { openMetrics } from '../metrics/index.ts';
import type { AnswerEvent } from '../metrics/index.ts';
import {
  blockMetricsDb,
  buildOk,
  eventually,
  find,
  makeTenantWorld,
  recordingMetrics,
  request,
  scriptedIndexers,
  withoutNonce,
} from './harness.test.ts';
import { answerEvent } from './record.ts';

const sample = (extra: Partial<Envelope> = {}): Envelope => ({
  schema: 'gsd-atlas.code-find/1',
  ok: true,
  data: { results: [] },
  diagnostics: [],
  citations: [
    { id: 'c1', path: 'a.toy', line: 1, col: 1, endLine: 1, endCol: 5, confidence: 'EXTRACTED', debug: 'sym/a' },
    { id: 'c2', path: 'b.toy', line: 2, col: 1, endLine: 2, endCol: 5, confidence: 'INFERRED', debug: 'sym/b' },
  ],
  truncated: true,
  degraded: ['stale', 'reconciling'],
  ...extra,
});

describe('answerEvent', () => {
  it('maps the envelope structure to a closed-vocabulary answer event', () => {
    const envelope = sample();
    const event = answerEvent('code_find', envelope, 7) as AnswerEvent;
    assert.equal(event.kind, 'answer');
    assert.equal(event.tool, 'code_find');
    assert.equal(event.ok, true);
    assert.equal(event.latencyMs, 7);
    assert.equal(event.results, 2, 'results is the number of citations');
    assert.equal(event.truncated, true);
    assert.deepEqual(event.degraded, ['stale', 'reconciling']);
    assert.equal(event.estimatedTokens, Math.ceil(JSON.stringify(envelope).length / 4));
  });

  it('keeps only codes of the closed vocabulary and reports no results when there are no citations', () => {
    const dirty = sample({ degraded: ['stale', 'invented_code', 'stale'] as unknown as readonly DegradedCode[] });
    const { citations: _citations, ...bare } = dirty;
    const event = answerEvent('atlas_status', bare as Envelope, 0) as AnswerEvent;
    assert.deepEqual(event.degraded, ['stale'], 'an unknown code is dropped and a repeat is not doubled');
    assert.equal(event.results, 0);
    assert.equal(event.tool, 'atlas_status');
  });

  it('mirrors a failed envelope and a missing truncated flag', () => {
    const failed: Envelope = { schema: 'gsd-atlas.error/1', ok: false, data: null, diagnostics: [] };
    const event = answerEvent('code_refs', failed, 3) as AnswerEvent;
    assert.equal(event.ok, false);
    assert.equal(event.truncated, false);
    assert.deepEqual(event.degraded, []);
  });

  it('returns null for kinds the Tenant does not answer', () => {
    for (const kind of ['build', 'maintain', 'status', 'lang_list', 'lang_test', 'nonsense']) {
      assert.equal(answerEvent(kind, sample(), 1), null, kind);
    }
  });

  it('puts no path, symbol name or source text into the event', () => {
    const envelope = sample({ untrusted_text: { nonce: 'n', entries: [{ ref: 'c1', text: 'fn secretSymbolName {' }] } });
    const text = JSON.stringify(answerEvent('code_find', envelope, 1));
    assert.doesNotMatch(text, /secretSymbolName|a\.toy|b\.toy/);
  });
});

describe('Tenant recording', () => {
  it('records one answer for each code request and nothing for build, maintain or status', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const recorder = recordingMetrics();
    const tenant = await open({ metrics: recorder.metrics });
    await buildOk(tenant, repo);

    await tenant.handle(find('helper', repo.dir), repo.dir);
    await tenant.handle(find('nosuchthing', repo.dir), repo.dir);
    await tenant.handle(request('atlas_status', {}), repo.dir);
    await tenant.maintain('check', { worktree: repo.dir });
    await tenant.statusEnvelope(60_000);

    const answers = recorder.events.filter((event): event is AnswerEvent => event.kind === 'answer');
    assert.deepEqual(
      answers.map((event) => event.tool),
      ['code_find', 'code_find', 'atlas_status'],
    );
    assert.equal(answers[0]?.results, 1);
    assert.equal(answers[1]?.results, 0);
    assert.ok(answers.every((event) => event.ok));
  });

  it('records a request that was refused as an answer with ok false', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const recorder = recordingMetrics();
    const tenant = await open({ metrics: recorder.metrics });
    await tenant.handle(find('helper', repo.dir), repo.dir);
    const answers = recorder.events.filter((event): event is AnswerEvent => event.kind === 'answer');
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.ok, false);
  });

  it('answer purity: real, throwing and unopenable Metrics give deep-equal envelopes', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const sequence = async (metrics?: ReturnType<typeof recordingMetrics>['metrics']): Promise<unknown[]> => {
      const tenant = await open(metrics === undefined ? {} : { metrics });
      const replies: unknown[] = [];
      for (const each of [
        find('helper', repo.dir),
        find('nosuchthing', repo.dir),
        request('code_refs', { name: 'boot', repo: repo.dir }),
        request('code_context', { name: 'main', repo: repo.dir }),
        request('code_impact', { name: 'boot', repo: repo.dir }),
        { protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name: '', repo: repo.dir } },
      ]) {
        replies.push(withoutNonce(await tenant.handle(each, repo.dir)));
      }
      await tenant.close();
      return replies;
    };

    const first = await open();
    await buildOk(first, repo);
    await first.close();

    const real = await sequence();
    const throwing = await sequence(recordingMetrics('record').metrics);
    blockMetricsDb(storeDir);
    const noop = await sequence();
    assert.deepEqual(throwing, real);
    assert.deepEqual(noop, real);
    assert.equal((real[0] as Envelope).ok, true);
  });

  it('a Metrics whose flush and rollup throw cannot break the status reply', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const tenant = await open({ metrics: recordingMetrics('flush').metrics });
    await buildOk(tenant, repo);
    const reply = await tenant.statusEnvelope(60_000);
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
  });

  it('status flushes the recorder queue before it reads the report', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const recorder = recordingMetrics();
    const tenant = await open({ metrics: recorder.metrics });
    await buildOk(tenant, repo);
    await tenant.handle(find('helper', repo.dir), repo.dir);
    recorder.calls.length = 0;
    await tenant.statusEnvelope(60_000);
    assert.deepEqual(recorder.calls.slice(0, 2), ['flush', 'report']);
  });

  it('an indexed notice becomes a freshness event; failed and requeued notices record nothing', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const recorder = recordingMetrics();
    const scripted = scriptedIndexers({ start: 'now' });
    const tenant = await open({ metrics: recorder.metrics, indexerFactory: scripted.factory });
    await tenant.build(repo.dir);
    const onNotice = scripted.made[0]?.deps.onNotice;
    assert.ok(onNotice, 'the Tenant listens to the Indexer');
    onNotice({ kind: 'indexed', worktree: repo.dir, path: 'b.toy', lagMs: 42 });
    onNotice({ kind: 'failed', worktree: repo.dir, path: 'b.toy', code: 'parse_timeout' });
    onNotice({ kind: 'requeued', worktree: repo.dir, path: 'b.toy' });
    const freshness = recorder.events.filter((event) => event.kind === 'freshness');
    assert.deepEqual(freshness, [{ kind: 'freshness', lagMs: 42 }]);
  });

  it('a freshness record that throws does not reach the Indexer', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const scripted = scriptedIndexers({ start: 'now' });
    const tenant = await open({ metrics: recordingMetrics('record').metrics, indexerFactory: scripted.factory });
    await tenant.build(repo.dir);
    const onNotice = scripted.made[0]?.deps.onNotice;
    assert.ok(onNotice);
    assert.doesNotThrow(() => {
      onNotice({ kind: 'indexed', worktree: repo.dir, path: 'b.toy', lagMs: 5 });
    });
  });

  it('a burst larger than the recorder queue drops the oldest events and returns every answer unchanged', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const first = await open();
    await buildOk(first, repo);
    await first.close();

    const metrics = await openMetrics(path.join(storeDir, 'metrics.db'), { clock: systemClock }, { queueMax: 10 });
    const tenant = await open({ metrics });
    const baseline = withoutNonce(await tenant.handle(find('helper', repo.dir), repo.dir));
    for (let each = 0; each < 200; each += 1) {
      const reply = withoutNonce(await tenant.handle(find('helper', repo.dir), repo.dir));
      assert.deepEqual(reply, baseline);
    }
    const status = metrics.status();
    assert.ok(status.dropped >= 190, `dropped ${String(status.dropped)} events`);
    assert.ok(status.queued <= 10);
    await eventually(() => fs.existsSync(path.join(storeDir, 'metrics.db')), 'metrics.db');
  });
});
