/**
 * The Host's `diagnostics` kind (SKL-03): the platform facts and the report data it assembles, what it asks of a
 * repository, who may send it, and (Task 3) the commands behind `enable`, `types`, `save`, `disable` and `history`.
 * The privacy fixture (acceptance test 4) is in src/diagnostics/diagnostics.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { loadCatalog, defaultCatalogDir, saveConsent } from '../diagnostics/index.ts';
import type { Consent } from '../diagnostics/index.ts';
import type { Envelope } from '../facts/index.ts';
import { makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';
import { factsFromStatus, platformFactsOf } from './diagnostics.ts';
import type { PreviewData, StatusData, TypesData } from './diagnostics.ts';

const catalog = loadCatalog(defaultCatalogDir());

const allApproved = (): Consent => ({
  catalogVersion: 1,
  types: Object.fromEntries(catalog.types.map((type) => [type.id, { state: 'approved' as const, fields: type.fields.map((field) => field.name) }])),
});

const only = (...ids: string[]): Consent => {
  const all = allApproved();
  return { catalogVersion: 1, types: Object.fromEntries(ids.map((id) => [id, all.types[id] as Consent['types'][string]])) };
};

const userDirOf = (world: World): string => world.options.userDir as string;

async function world(t: TestContext, host: Record<string, unknown> = {}): Promise<World> {
  return makeWorld(t, { host: { version: '1.2.3', ...host } });
}

const dataOf = <T>(reply: Envelope): T => reply.data as T;

describe('platform facts', () => {
  it('macOS: the marketing major from the Darwin kernel, on both sides of the numbering change', () => {
    assert.deepEqual(platformFactsOf('darwin', '20.6.0', 'v24.22.0'), { osFamily: 'macOS', osMajor: 11, nodeMajor: 24 });
    assert.deepEqual(platformFactsOf('darwin', '24.1.0', 'v24.22.0'), { osFamily: 'macOS', osMajor: 15, nodeMajor: 24 });
    assert.deepEqual(platformFactsOf('darwin', '25.0.0', 'v26.11.1'), { osFamily: 'macOS', osMajor: 26, nodeMajor: 26 });
    assert.deepEqual(platformFactsOf('darwin', '26.2.0', '24.22.0'), { osFamily: 'macOS', osMajor: 27, nodeMajor: 24 });
    assert.equal(platformFactsOf('darwin', '19.0.0', '24.0.0').osMajor, null);
    assert.equal(platformFactsOf('darwin', 'garbage', '24.0.0').osMajor, null);
  });

  it('Windows: 10 or 11 from the build number; Linux: the kernel major; anything else is other', () => {
    assert.deepEqual(platformFactsOf('win32', '10.0.26100', 'v24.22.0'), { osFamily: 'Windows', osMajor: 11, nodeMajor: 24 });
    assert.equal(platformFactsOf('win32', '10.0.19045', 'v24.22.0').osMajor, 10);
    assert.deepEqual(platformFactsOf('linux', '6.8.0-45-generic', 'v24.22.0'), { osFamily: 'Linux', osMajor: 6, nodeMajor: 24 });
    assert.deepEqual(platformFactsOf('freebsd', '14.1-RELEASE', 'v24.22.0'), { osFamily: 'other', osMajor: null, nodeMajor: 24 });
    assert.equal(platformFactsOf('linux', '6.8.0', 'nonsense').nodeMajor, null);
  });
});

describe('facts from a status reply', () => {
  it('reads the index gauges, the answer totals, the degraded counts and the latency bounds', () => {
    const facts = factsFromStatus({
      report: {
        answers: { total: 20, ok: 18, latency: { p50UpperBoundMs: 5, p95UpperBoundMs: 20 } },
        degraded: { reconciling: 2, precise_unavailable: 3 },
        indexHealth: { files: 10, errorFiles: 1, staleFiles: 0, sizeBytes: 2048, at: 1 },
      },
    });
    assert.deepEqual(facts, {
      index: { files: 10, errorFiles: 1, sizeBytes: 2048 },
      activity: { answersTotal: 20, degradedTotal: 5, latencyP50Ms: 5, latencyP95Ms: 20 },
    });
  });

  it('anything that is not the expected shape is a missing figure, never a guess', () => {
    assert.deepEqual(factsFromStatus(null), { index: null, activity: null });
    assert.deepEqual(factsFromStatus('x'), { index: null, activity: null });
    assert.deepEqual(factsFromStatus({ report: { answers: { total: 'many' }, indexHealth: { files: 'x' } } }), { index: null, activity: null });
    const partial = factsFromStatus({ report: { answers: { total: 0, latency: { p50UpperBoundMs: null } }, indexHealth: null } });
    assert.deepEqual(partial, { index: null, activity: { answersTotal: 0, degradedTotal: 0, latencyP50Ms: null, latencyP95Ms: null } });
  });
});

describe('diagnostics status and types', () => {
  it('a fresh Host: off, ten types all denied, nothing written', async (t) => {
    const w = await world(t);
    const reply = await w.ask('diagnostics', { action: 'status' });
    assert.equal(reply.ok, true);
    assert.equal(reply.schema, 'gsd-atlas.diagnostics/1');
    const data = dataOf<StatusData>(reply);
    assert.equal(data.enabled, false);
    assert.equal(data.saved, false);
    assert.equal(data.catalog_version, 1);
    assert.equal(data.types.length, 10);
    assert.ok(data.types.every((type) => type.state === 'denied' && !type.needs_review));
    assert.equal(data.types[0]?.required, true);
    assert.equal(fs.existsSync(userDirOf(w)), false, 'the user directory was not even created');
  });

  it('types: every field with the real value from this machine, and both explanations, for every type', async (t) => {
    const w = await world(t, { diagnostics: { platform: { osFamily: 'macOS', osMajor: 27, nodeMajor: 24 }, agentHost: 'claude-code' } });
    const reply = await w.ask('diagnostics', { action: 'types' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const data = dataOf<TypesData>(reply);
    assert.deepEqual(data.types.map((type) => type.id), catalog.types.map((type) => type.id));
    for (const type of data.types) {
      assert.ok(type.how_it_helps.length > 40, type.id);
      assert.ok(type.cannot_reveal.length > 10, type.id);
      assert.deepEqual(type.fields.map((field) => field.name), catalog.types.find((entry) => entry.id === type.id)?.fields.map((field) => field.name));
      assert.ok(type.fields.every((field) => 'value' in field && typeof field.example === 'string' && typeof field.kind === 'string'));
    }
    const value = (typeId: string, field: string): unknown => data.types.find((type) => type.id === typeId)?.fields.find((entry) => entry.name === field)?.value;
    assert.equal(value('header', 'atlas_version'), '1.2.3');
    assert.equal(value('header', 'catalog_version'), 1);
    assert.equal(value('platform', 'os_family'), 'macOS');
    assert.equal(value('platform', 'os_major'), 27);
    assert.equal(value('agent_setup', 'agent_host'), 'claude-code');
    assert.equal(value('agent_setup', 'transport'), 'in-process');
    assert.deepEqual(value('languages', 'languages_active'), ['toy']);
    assert.equal(value('scale', 'worktree_count_bucket'), '1');
    assert.equal(value('agent_behavior', 'gate_stats'), null, 'no data yet');
    assert.equal(value('notes', 'note'), null);
    assert.equal(fs.existsSync(userDirOf(w)), false, 'showing the values writes nothing');
  });

  it('types: only the named types, and an unknown name is refused', async (t) => {
    const w = await world(t);
    const some = dataOf<TypesData>(await w.ask('diagnostics', { action: 'types', ids: ['header', 'platform'] }));
    assert.deepEqual(some.types.map((type) => type.id), ['header', 'platform']);
    const bad = await w.ask('diagnostics', { action: 'types', ids: ['nope'] });
    assert.equal(bad.ok, false);
    assert.equal(bad.diagnostics[0]?.code, 'invalid_args');
  });

  it('a repository with an index adds the index facts to the values; one without adds nothing', async (t) => {
    const w = await world(t);
    const before = dataOf<TypesData>(await w.ask('diagnostics', { action: 'types', ids: ['performance', 'languages'] }));
    const field = (data: TypesData, typeId: string, name: string): unknown => data.types.find((type) => type.id === typeId)?.fields.find((entry) => entry.name === name)?.value;
    assert.equal(field(before, 'performance', 'store_size_bucket'), null, 'not indexed yet: no figure');
    const built = await w.ask('build', { repo: w.repo.dir });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    const after = dataOf<TypesData>(await w.ask('diagnostics', { action: 'types', ids: ['performance', 'languages'] }));
    assert.equal(typeof field(after, 'performance', 'store_size_bucket'), 'string');
    assert.deepEqual(field(after, 'languages', 'parse_error_rate'), { all: 0 });
  });
});

describe('diagnostics preview', () => {
  it('no consent: not enabled, a fixed sentence, and the user directory is untouched', async (t) => {
    const w = await world(t);
    const reply = await w.ask('diagnostics', { action: 'preview' });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.data, { enabled: false });
    assert.equal(reply.diagnostics.find((entry) => entry.code === 'diagnostics_off')?.severity, 'info');
    assert.equal(fs.existsSync(userDirOf(w)), false);
  });

  it('a type approved without the header cannot make a report, and the sentence says why', async (t) => {
    const w = await world(t);
    saveConsent(userDirOf(w), only('platform'));
    const reply = await w.ask('diagnostics', { action: 'preview' });
    assert.deepEqual(reply.data, { enabled: false });
    assert.match(reply.diagnostics.find((entry) => entry.code === 'diagnostics_off')?.message ?? '', /header is not approved/);
  });

  it('header and platform: the report holds the platform and nothing else', async (t) => {
    const w = await world(t, { diagnostics: { platform: { osFamily: 'Linux', osMajor: 6, nodeMajor: 24 } } });
    saveConsent(userDirOf(w), only('header', 'platform'));
    const data = dataOf<PreviewData>(await w.ask('diagnostics', { action: 'preview' }));
    assert.equal(data.title, '[diagnostics] atlas 1.2.3 · Linux 6');
    assert.deepEqual(data.labels, ['diagnostics', 'os:linux']);
    assert.deepEqual(data.json, { catalog_version: 1, atlas_version: '1.2.3', os_family: 'Linux', os_major: 6, node_major: 24 });
  });

  it('a note and a rating are used only when their types are approved; otherwise they are reported as ignored', async (t) => {
    const w = await world(t);
    saveConsent(userDirOf(w), only('header'));
    const ignored = dataOf<PreviewData>(await w.ask('diagnostics', { action: 'preview', note: 'hello', rating: 'up' }));
    assert.equal(ignored.note_ignored, true);
    assert.equal(ignored.rating_ignored, true);
    assert.ok(!ignored.body?.includes('hello'));
    assert.deepEqual(ignored.json, { catalog_version: 1, atlas_version: '1.2.3' });

    saveConsent(userDirOf(w), only('header', 'notes', 'ratings'));
    const used = dataOf<PreviewData>(await w.ask('diagnostics', { action: 'preview', note: 'at /home/me/x', rating: 'down', about: 'build' }));
    assert.equal(used.note_ignored, undefined);
    assert.equal(used.rating_ignored, undefined);
    assert.equal(used.json?.['note'], 'at [removed]');
    assert.deepEqual(used.json?.['rating'], [{ about: 'build', value: '↓' }]);
    assert.equal(used.title, '[diagnostics] atlas 1.2.3 · ↓ build');
    assert.deepEqual(used.labels, ['diagnostics', 'rating:down']);
  });

  it('"ask each time" types are listed as skipped, and included when the person says yes', async (t) => {
    const w = await world(t, { diagnostics: { platform: { osFamily: 'Linux', osMajor: 6, nodeMajor: 24 } } });
    const consent = only('header', 'platform');
    saveConsent(userDirOf(w), { ...consent, types: { ...consent.types, platform: { state: 'ask', fields: consent.types['platform']?.fields ?? [] } } });
    const skipped = dataOf<PreviewData>(await w.ask('diagnostics', { action: 'preview' }));
    assert.deepEqual(skipped.ask_skipped, ['platform']);
    assert.ok(!('os_family' in (skipped.json ?? {})));
    const included = dataOf<PreviewData>(await w.ask('diagnostics', { action: 'preview', include: ['platform'] }));
    assert.deepEqual(included.ask_skipped, []);
    assert.equal(included.json?.['os_family'], 'Linux');
  });

  it('an invalid consent file is ignored whole with one warning, and every type is off', async (t) => {
    const w = await world(t);
    fs.mkdirSync(userDirOf(w), { recursive: true });
    fs.writeFileSync(path.join(userDirOf(w), 'diagnostics.json'), JSON.stringify({ autoSubmit: true }));
    const status = await w.ask('diagnostics', { action: 'status' });
    assert.equal(dataOf<StatusData>(status).enabled, false);
    const warnings = status.diagnostics.filter((entry) => entry.severity === 'warning');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'consent_ignored');
    assert.ok(!warnings[0]?.message.includes('autoSubmit'), 'the warning does not quote the file');
  });

  it('arguments are strict: an unknown key, a bad action, a long note and a bad rating are refused', async (t) => {
    const w = await world(t);
    for (const args of [
      { action: 'preview', submit: true },
      { action: 'send' },
      {},
      { action: 'preview', note: 'x'.repeat(10_001) },
      { action: 'preview', rating: 'great' },
      { action: 'preview', about: '/home/x' },
      { action: 'preview', include: ['Bad Id'] },
      { action: 'status', repo: '/x' },
    ]) {
      const reply = await w.ask('diagnostics', args);
      assert.equal(reply.ok, false, JSON.stringify(args));
      assert.equal(reply.diagnostics[0]?.code, 'invalid_args', JSON.stringify(args));
    }
    const notObject = await w.ask('diagnostics', 'preview');
    assert.equal(notObject.diagnostics[0]?.code, 'invalid_args');
  });

  it('a Host started for MCP refuses the whole kind, before it reads the arguments', async (t) => {
    const w = await world(t, { origin: 'mcp' });
    for (const args of [{ action: 'status' }, { action: 'preview' }, { action: 'set', choices: { header: 'approved' } }, { nonsense: 1 }]) {
      const reply = await w.ask('diagnostics', args);
      assert.equal(reply.ok, false);
      assert.equal(reply.diagnostics[0]?.code, 'diagnostics_forbidden');
    }
    assert.equal(fs.existsSync(userDirOf(w)), false);
  });
});
