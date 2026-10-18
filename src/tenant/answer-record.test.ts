/**
 * Plan 03-17: every tool answer a Tenant gives carries an `answer_id`, and the Tenant appends one event per answer
 * to its flight recorder (a capped, local file beside the store). The event holds codes, counts and handles only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ANSWER_ID_PATTERN, systemClock } from '../facts/index.ts';
import { LATENCY_BUCKETS_MS } from '../metrics/index.ts';
import type { FactStore } from '../fact-store/index.ts';
import { buildOk, captureStore, find, makeTenantWorld, recordingMetrics, request } from './harness.test.ts';
import { createFlightRecorder } from './flight.ts';
import type { FlightEvent } from './flight.ts';

const SESSION_ID = /^s_[0-9a-f]{16}$/;
const BUCKETS = new Set([...LATENCY_BUCKETS_MS.map((edge) => `le${String(edge)}`), 'inf']);

/** The recorder as another process sees it: a fresh instance over the store's `flight` folder. */
const readFlight = (storeDir: string): FlightEvent[] =>
  createFlightRecorder({ dir: path.join(storeDir, 'flight'), clock: systemClock, maxEvents: 2000, maxBytes: 5_242_880 }).recent(1000);

describe('Tenant: answer ids and the flight recorder', () => {
  it('stamps an answer_id on every tool answer and appends exactly one answer event for it', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);

    const found = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.match(found.answer_id ?? '', ANSWER_ID_PATTERN);
    const refs = await tenant.handle(request('code_refs', { name: 'boot', repo: repo.dir }), repo.dir);
    const status = await tenant.handle(request('atlas_status', {}), repo.dir);
    assert.match(refs.answer_id ?? '', ANSWER_ID_PATTERN);
    assert.match(status.answer_id ?? '', ANSWER_ID_PATTERN);
    assert.equal(new Set([found.answer_id, refs.answer_id, status.answer_id]).size, 3, 'each answer has its own id');

    const answers = readFlight(storeDir).filter((event) => event.kind === 'answer');
    assert.deepEqual(
      answers.map((event) => event.id),
      [found.answer_id, refs.answer_id, status.answer_id],
    );
    assert.deepEqual(
      answers.map((event) => event.tool),
      ['code_find', 'code_refs', 'atlas_status'],
    );
  });

  it('the event for code_find holds the request arguments, the outcome, a latency bucket label, the degraded codes, the count and the citation handles', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);
    const reply = await tenant.handle(find('helper', repo.dir), repo.dir);
    const event = readFlight(storeDir).find((each) => each.kind === 'answer') as FlightEvent;

    assert.equal(event.id, reply.answer_id);
    assert.equal(event.tool, 'code_find');
    assert.equal((event.args as Record<string, unknown>)['name'], 'helper');
    assert.equal(event.outcome, 'ok');
    assert.ok(BUCKETS.has(event.ms ?? ''), `ms is a bucket label, got ${String(event.ms)}`);
    assert.deepEqual(event.degraded ?? [], reply.degraded ?? []);
    assert.equal(event.count, reply.citations?.length);
    assert.deepEqual(event.handles, reply.citations?.map((citation) => citation.debug).slice(0, 20));
    assert.ok((event.handles?.length ?? 0) >= 1);
    assert.ok(Number.isFinite(event.t));
  });

  it('records the first diagnostic code as the outcome of a refused request', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);
    const reply = await tenant.handle(request('code_find', { name: '', repo: repo.dir }), repo.dir);
    assert.equal(reply.ok, false);
    const event = readFlight(storeDir).find((each) => each.kind === 'answer') as FlightEvent;
    assert.equal(event.outcome, reply.diagnostics[0]?.code);
    assert.notEqual(event.outcome, 'ok');
  });

  it('the events never hold untrusted text or any envelope data, only counts', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);
    const reply = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.match(reply.untrusted_text?.entries[0]?.text ?? '', /fn helper/, 'the answer itself carries the fenced text');
    const raw = fs.readFileSync(path.join(storeDir, 'flight', 'flight.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /fn helper|untrusted_text|"data"|"results"|"citations"|nonce/);
  });

  it('build, maintain and status are not answers: no id on them and no event for them', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    const built = await buildOk(tenant, repo);
    const maintained = await tenant.maintain('check', { worktree: repo.dir });
    const status = await tenant.statusEnvelope(60_000);
    for (const reply of [built, maintained, status]) assert.equal(reply.answer_id, undefined);
    assert.deepEqual(readFlight(storeDir), []);
    assert.deepEqual(tenant.recentAnswers(5), []);
    assert.equal(tenant.lastAnswerId(), null);
  });

  it('session marker: written once, before the first answer of this Tenant, and not by a Tenant that answers nothing', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const builder = await open();
    await buildOk(builder, repo);
    assert.deepEqual(readFlight(storeDir), [], 'a build alone leaves no marker');
    assert.equal(builder.sessionId(), null);

    const first = await builder.handle(find('helper', repo.dir), repo.dir);
    await builder.handle(find('boot', repo.dir), repo.dir);
    const events = readFlight(storeDir);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['session', 'answer', 'answer'],
    );
    assert.match(events[0]?.id ?? '', SESSION_ID);
    assert.equal(builder.sessionId(), events[0]?.id);
    assert.equal(events[1]?.id, first.answer_id);
  });

  it('tenant.recentAnswers and lastAnswerId read the recorder, answers only, newest last', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);
    const one = await tenant.handle(find('helper', repo.dir), repo.dir);
    const two = await tenant.handle(find('boot', repo.dir), repo.dir);
    assert.deepEqual(
      tenant.recentAnswers(10).map((event) => event.id),
      [one.answer_id, two.answer_id],
    );
    assert.deepEqual(
      tenant.recentAnswers(1).map((event) => event.id),
      [two.answer_id],
    );
    assert.equal(tenant.lastAnswerId(), two.answer_id);
  });

  it('a follower records too: a second Tenant over the same store appends to the same file', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const leader = await open();
    await buildOk(leader, repo);
    const follower = await open();
    assert.equal((await follower.status()).leader, false);
    const mine = await follower.handle(find('helper', repo.dir), repo.dir);
    assert.equal(leader.lastAnswerId(), mine.answer_id, 'the leader sees the answer the follower gave');
  });

  it('an unwritable recorder folder never reaches the caller: the answer is returned and stamped, and nothing can be read back', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);
    fs.writeFileSync(path.join(storeDir, 'flight'), 'a file where the folder belongs');
    const reply = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(reply.ok, true);
    assert.match(reply.answer_id ?? '', ANSWER_ID_PATTERN);
    assert.deepEqual(tenant.recentAnswers(5), []);
    assert.equal(tenant.lastAnswerId(), null);
  });

  it('no metrics, no flight recorder: a Tenant opened with metrics false stamps the id but writes no folder', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open({ metrics: false });
    await buildOk(tenant, repo);
    const reply = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.match(reply.answer_id ?? '', ANSWER_ID_PATTERN);
    assert.equal(fs.existsSync(path.join(storeDir, 'flight')), false);
    assert.deepEqual(tenant.recentAnswers(5), []);
  });

  it('a Metrics whose record throws does not stop the flight event', async (t) => {
    const { repo, open } = await makeTenantWorld(t);
    const tenant = await open({ metrics: recordingMetrics('record').metrics });
    await buildOk(tenant, repo);
    const reply = await tenant.handle(find('helper', repo.dir), repo.dir);
    assert.equal(tenant.lastAnswerId(), reply.answer_id);
  });

  it('a request that fails inside the Tenant leaves an internal_error event, and the failure still reaches the caller (plan 03-32)', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    let broken = false;
    const capture = captureStore((store): FactStore => ({
      ...store,
      at(worktree) {
        if (broken) throw new Error('the reader failed with SECRET_ERROR_TEXT in its message');
        return store.at(worktree);
      },
    }));
    const tenant = await open({ openStore: capture.open });
    await buildOk(tenant, repo);
    await tenant.handle(find('helper', repo.dir), repo.dir);

    broken = true;
    await assert.rejects(tenant.handle(find('boot', repo.dir), repo.dir), /the reader failed/);
    broken = false;

    const answers = readFlight(storeDir).filter((event) => event.kind === 'answer');
    assert.deepEqual(
      answers.map((event) => [event.tool, event.outcome]),
      [
        ['code_find', 'ok'],
        ['code_find', 'internal_error'],
      ],
    );
    const failed = answers[1] as FlightEvent;
    assert.match(failed.id, ANSWER_ID_PATTERN);
    assert.equal((failed.args as Record<string, unknown>)['name'], 'boot');
    assert.equal(JSON.stringify(failed).includes('SECRET_ERROR_TEXT'), false, 'the error message is never recorded');
    assert.equal(tenant.lastAnswerId(), failed.id);
  });

  it('the recorder keeps the envelope schema, the diagnostic codes and the watermark sequence of an answer (plan 03-32)', async (t) => {
    const { repo, open, storeDir } = await makeTenantWorld(t);
    const tenant = await open();
    await buildOk(tenant, repo);
    const reply = await tenant.handle(find('helper', repo.dir), repo.dir);
    const refused = await tenant.handle(request('code_find', { name: '', repo: repo.dir }), repo.dir);
    const [good, bad] = readFlight(storeDir).filter((event) => event.kind === 'answer') as [FlightEvent, FlightEvent];
    assert.equal(good.schema, reply.schema);
    assert.deepEqual(good.diag, reply.diagnostics.map((entry) => entry.code));
    assert.equal(good.seq, reply.watermark?.seq);
    assert.equal(typeof good.seq, 'number');
    assert.equal(bad.schema, refused.schema);
    assert.deepEqual(bad.diag, refused.diagnostics.map((entry) => entry.code));
    assert.equal(bad.seq, undefined, 'a refused request has no watermark');
  });
});
