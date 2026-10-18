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
import { makeTempDir } from '../test-kit/index.ts';
import { makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';
import { defaultStateDir, factsFromStatus, platformFactsOf } from './diagnostics.ts';
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

describe('state directory', () => {
  it('GSD_ATLAS_STATE_DIR wins when absolute; else XDG_STATE_HOME or ~/.local/state, plus gsd-atlas', () => {
    assert.equal(defaultStateDir({ GSD_ATLAS_STATE_DIR: '/var/atlas', XDG_STATE_HOME: '/xdg' }, '/home/u', 'linux'), '/var/atlas');
    assert.equal(defaultStateDir({ XDG_STATE_HOME: '/xdg' }, '/home/u', 'linux'), '/xdg/gsd-atlas');
    assert.equal(defaultStateDir({}, '/home/u', 'linux'), '/home/u/.local/state/gsd-atlas');
    assert.equal(defaultStateDir({}, '/Users/u', 'darwin'), '/Users/u/.local/state/gsd-atlas');
  });

  it('a relative or empty value is ignored, never resolved against the working directory', () => {
    assert.equal(defaultStateDir({ GSD_ATLAS_STATE_DIR: 'relative/dir', XDG_STATE_HOME: '' }, '/home/u', 'linux'), '/home/u/.local/state/gsd-atlas');
    assert.equal(defaultStateDir({ XDG_STATE_HOME: 'rel' }, '/home/u', 'linux'), '/home/u/.local/state/gsd-atlas');
  });

  it('Windows uses LOCALAPPDATA, else the Local folder under the home directory', () => {
    assert.equal(defaultStateDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32'), 'C:\\Users\\u\\AppData\\Local\\gsd-atlas');
    assert.equal(defaultStateDir({}, 'C:\\Users\\u', 'win32'), 'C:\\Users\\u\\AppData\\Local\\gsd-atlas');
    assert.equal(defaultStateDir({ GSD_ATLAS_STATE_DIR: 'D:\\state' }, 'C:\\Users\\u', 'win32'), 'D:\\state');
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
    assert.deepEqual(skipped.ask_skipped, [{ id: 'platform', title: 'Platform' }]);
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

// ---------------------------------------------------------------------------------------------------------------------
// Task 3: set, save, history, disable, and the guards (acceptance tests 1 and 5).
// ---------------------------------------------------------------------------------------------------------------------

const stateDirOf = (w: World): string => path.join(w.tmp.path, 'state');

/** A world whose Host has no state directory: the composition root did not give it one. */
async function stateful(t: TestContext, host: Record<string, unknown> = {}): Promise<World> {
  return makeWorld(t, { host: { version: '1.2.3', ...host } });
}

/** A world whose Host knows a state directory (the composition root's job) beside the user directory, and the platform it runs on. */
async function worldWithState(t: TestContext, host: Record<string, unknown> = {}): Promise<World> {
  const tmp = makeTempDir();
  const w = await makeWorld(t, {
    tmp,
    host: { version: '1.2.3', stateDir: path.join(tmp.path, 'state'), diagnostics: { platform: { osFamily: 'Linux', osMajor: 6, nodeMajor: 24 } }, ...host },
  });
  // Registered after the world's own hook, so the Host is closed before the folder goes (Windows keeps open files locked).
  t.after(() => {
    tmp.cleanup();
  });
  return w;
}

/** Every file and folder below `root`, relative and sorted; a missing root is empty. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full).split(path.sep).join('/'));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

describe('diagnostics set', () => {
  it('approve, ask and deny per type: each approved type is saved with the catalog field list, everything else stays denied', async (t) => {
    const w = await stateful(t);
    const reply = await w.ask('diagnostics', { action: 'set', choices: { header: 'approved', platform: 'ask', scale: 'denied' } });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const status = dataOf<StatusData>(reply);
    assert.equal(status.enabled, true);
    const stateOf = (id: string): string | undefined => status.types.find((type) => type.id === id)?.state;
    assert.equal(stateOf('header'), 'approved');
    assert.equal(stateOf('platform'), 'ask');
    assert.equal(stateOf('scale'), 'denied');
    assert.equal(stateOf('performance'), 'denied');
    const saved = JSON.parse(fs.readFileSync(path.join(userDirOf(w), 'diagnostics.json'), 'utf8')) as { catalogVersion: number; types: Record<string, { state: string; fields: string[] }> };
    assert.equal(saved.catalogVersion, 1);
    assert.deepEqual(saved.types['header'], { state: 'approved', fields: ['atlas_version', 'catalog_version'] });
    assert.deepEqual(saved.types['platform']?.fields, ['os_family', 'os_major', 'node_major']);
    assert.deepEqual(saved.types['scale'], { state: 'denied', fields: [] });
  });

  it('a later set keeps the types it does not name', async (t) => {
    const w = await stateful(t);
    await w.ask('diagnostics', { action: 'set', choices: { header: 'approved', platform: 'approved' } });
    const reply = await w.ask('diagnostics', { action: 'set', choices: { platform: 'denied', scale: 'approved' } });
    const status = dataOf<StatusData>(reply);
    const stateOf = (id: string): string | undefined => status.types.find((type) => type.id === id)?.state;
    assert.deepEqual([stateOf('header'), stateOf('platform'), stateOf('scale')], ['approved', 'denied', 'approved']);
  });

  it('refuses an unknown type, an unknown state, an empty set and extra keys, and writes nothing', async (t) => {
    const w = await stateful(t);
    for (const args of [
      { action: 'set', choices: { nope: 'approved' } },
      { action: 'set', choices: { header: 'maybe' } },
      { action: 'set', choices: {} },
      { action: 'set' },
      { action: 'set', choices: { header: 'approved' }, autoSubmit: true },
    ]) {
      const reply = await w.ask('diagnostics', args);
      assert.equal(reply.ok, false, JSON.stringify(args));
      assert.equal(reply.diagnostics[0]?.code, 'invalid_args', JSON.stringify(args));
    }
    assert.equal(fs.existsSync(userDirOf(w)), false);
  });

  it('never overwrites a consent file that fails validation', async (t) => {
    const w = await stateful(t);
    fs.mkdirSync(userDirOf(w), { recursive: true });
    const file = path.join(userDirOf(w), 'diagnostics.json');
    fs.writeFileSync(file, '{ not json');
    const reply = await w.ask('diagnostics', { action: 'set', choices: { header: 'approved' } });
    assert.equal(reply.ok, false);
    assert.equal(reply.diagnostics[0]?.code, 'consent_invalid');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    assert.deepEqual(fs.readdirSync(userDirOf(w)), ['diagnostics.json']);
  });
});

describe('diagnostics save', () => {
  it('writes the rendered report to <state>/diagnostics/reports/<timestamp>.md and returns its path', async (t) => {
    const w = await worldWithState(t);
    saveConsent(userDirOf(w), only('header', 'platform'));
    const reply = await w.ask('diagnostics', { action: 'save' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const data = dataOf<PreviewData & { path: string }>(reply);
    assert.equal(path.dirname(data.path), path.join(stateDirOf(w), 'diagnostics', 'reports'));
    assert.match(path.basename(data.path), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/);
    const text = fs.readFileSync(data.path, 'utf8');
    assert.equal(text, `Title: ${data.title}\nLabels: ${(data.labels ?? []).join(', ')}\n\n${data.body}`);
    assert.equal(data.title, '[diagnostics] atlas 1.2.3 · Linux 6');
    if (process.platform !== 'win32') assert.equal(fs.statSync(data.path).mode & 0o777, 0o600);
  });

  it('a second save is a second file; the first is untouched', async (t) => {
    const w = await worldWithState(t);
    saveConsent(userDirOf(w), only('header'));
    const first = dataOf<{ path: string }>(await w.ask('diagnostics', { action: 'save' }));
    const second = dataOf<{ path: string }>(await w.ask('diagnostics', { action: 'save' }));
    assert.notEqual(first.path, second.path);
    assert.equal(fs.readdirSync(path.dirname(first.path)).length, 2);
  });

  it('with diagnostics off nothing is written; with no state directory it says so and writes nothing', async (t) => {
    const w = await worldWithState(t);
    const off = await w.ask('diagnostics', { action: 'save' });
    assert.deepEqual(off.data, { enabled: false });
    assert.equal(fs.existsSync(stateDirOf(w)), false);

    const bare = await stateful(t);
    saveConsent(userDirOf(bare), only('header'));
    const reply = await bare.ask('diagnostics', { action: 'save' });
    assert.equal(reply.ok, false);
    assert.equal(reply.diagnostics[0]?.code, 'state_dir_unavailable');
  });

  it('preview never writes the state directory, even with consent', async (t) => {
    const w = await worldWithState(t);
    saveConsent(userDirOf(w), only('header', 'platform'));
    await w.ask('diagnostics', { action: 'preview' });
    assert.equal(fs.existsSync(stateDirOf(w)), false);
  });
});

describe('diagnostics history', () => {
  it('lists the saved reports newest first with their titles; none when nothing was saved or no state directory is set', async (t) => {
    const w = await worldWithState(t);
    saveConsent(userDirOf(w), only('header', 'platform'));
    assert.deepEqual(dataOf<{ reports: unknown[] }>(await w.ask('diagnostics', { action: 'history' })).reports, []);
    await w.ask('diagnostics', { action: 'save' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await w.ask('diagnostics', { action: 'save' });
    const listed = dataOf<{ reports: Array<{ file: string; title: string; bytes: number }> }>(await w.ask('diagnostics', { action: 'history' })).reports;
    assert.equal(listed.length, 2);
    assert.ok((listed[0]?.file ?? '') > (listed[1]?.file ?? ''), 'newest first');
    assert.ok(listed.every((entry) => entry.title === '[diagnostics] atlas 1.2.3 · Linux 6' && entry.bytes > 0));
    const bare = await stateful(t);
    assert.deepEqual(dataOf<{ reports: unknown[] }>(await bare.ask('diagnostics', { action: 'history' })).reports, []);
  });
});

describe('diagnostics disable', () => {
  it('sets everything denied, deletes the saved reports and the state folder, and says what it removed', async (t) => {
    const w = await worldWithState(t);
    saveConsent(userDirOf(w), allApproved());
    await w.ask('diagnostics', { action: 'save' });
    await w.ask('diagnostics', { action: 'save' });
    fs.writeFileSync(path.join(stateDirOf(w), 'unrelated.txt'), 'keep');
    const reply = await w.ask('diagnostics', { action: 'disable' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const data = dataOf<{ consent_reset: boolean; removed_reports: number; state_removed: boolean; flight_cleared: boolean }>(reply);
    assert.equal(data.consent_reset, true);
    assert.equal(data.removed_reports, 2);
    assert.equal(data.state_removed, true);
    const status = dataOf<StatusData>(await w.ask('diagnostics', { action: 'status' }));
    assert.equal(status.enabled, false);
    assert.ok(status.types.every((type) => type.state === 'denied'));
    assert.equal(fs.existsSync(path.join(stateDirOf(w), 'diagnostics')), false);
    assert.equal(fs.readFileSync(path.join(stateDirOf(w), 'unrelated.txt'), 'utf8'), 'keep');
    assert.deepEqual(dataOf<PreviewData>(await w.ask('diagnostics', { action: 'preview' })), { enabled: false });
  });

  it('with nothing enabled it creates nothing: no consent file, no folder', async (t) => {
    const w = await worldWithState(t);
    const reply = await w.ask('diagnostics', { action: 'disable' });
    assert.equal(reply.ok, true);
    assert.deepEqual(dataOf(reply), { consent_reset: false, removed_reports: 0, state_removed: false, flight_cleared: false });
    assert.equal(fs.existsSync(userDirOf(w)), false);
    assert.equal(fs.existsSync(stateDirOf(w)), false);
  });

  it('clears the flight recorder of the repository the command runs in, and no other', async (t) => {
    const w = await worldWithState(t);
    await w.ask('build', { repo: w.repo.dir });
    await w.ask('code_find', { name: 'helper', repo: w.repo.dir });
    const flight = path.join(w.repo.dir, '.git', 'gsd-atlas', 'flight');
    assert.ok(fs.existsSync(path.join(flight, 'flight.jsonl')), 'the answer was recorded');
    saveConsent(userDirOf(w), only('header'));
    const reply = await w.ask('diagnostics', { action: 'disable', repo: w.repo.dir });
    assert.equal(dataOf<{ flight_cleared: boolean }>(reply).flight_cleared, true);
    assert.equal(fs.existsSync(path.join(flight, 'flight.jsonl')), false);
    assert.equal(fs.existsSync(path.join(flight, 'flight.prev.jsonl')), false);
    // The index itself is not the flight recorder: it is still there and still answers.
    const found = await w.ask('code_find', { name: 'helper', repo: w.repo.dir });
    assert.equal(found.ok, true);
  });

  it('a consent file that fails validation is left alone and said so (the loader already ignores it)', async (t) => {
    const w = await worldWithState(t);
    fs.mkdirSync(userDirOf(w), { recursive: true });
    fs.writeFileSync(path.join(userDirOf(w), 'diagnostics.json'), '{ nope');
    const reply = await w.ask('diagnostics', { action: 'disable' });
    assert.equal(reply.ok, true);
    assert.equal(dataOf<{ consent_file_invalid?: true }>(reply).consent_file_invalid, true);
    assert.equal(fs.readFileSync(path.join(userDirOf(w), 'diagnostics.json'), 'utf8'), '{ nope');
  });
});

describe('fresh install writes nothing', () => {
  it('find, build, status, health and diagnostics preview create no diagnostics.json and no diagnostics state folder', async (t) => {
    const w = await worldWithState(t);
    const repo = w.repo.dir;
    await w.ask('code_find', { name: 'helper', repo });
    await w.ask('build', { repo });
    await w.ask('code_find', { name: 'helper', repo });
    await w.ask('status', { repo });
    await w.ask('atlas_status', { repo });
    const preview = await w.ask('diagnostics', { action: 'preview', repo });
    assert.deepEqual(preview.data, { enabled: false });
    await w.ask('diagnostics', { action: 'status' });
    await w.ask('diagnostics', { action: 'types', repo });
    await w.ask('diagnostics', { action: 'history' });
    const everything = [...tree(w.tmp.path), ...tree(path.join(w.repo.dir, '.git'))];
    assert.ok(!everything.some((entry) => entry.split('/').pop() === 'diagnostics.json'), 'no consent file');
    assert.ok(!everything.some((entry) => entry.split('/').includes('diagnostics')), 'no diagnostics folder');
    assert.equal(fs.existsSync(stateDirOf(w)), false, 'no state directory at all');
    assert.equal(fs.existsSync(userDirOf(w)), false, 'no user directory');
  });
});

/** A fs whose every call is recorded with the paths it names; the Host's diagnostics module is handed this one. */
function recordingFs(touched: string[]): typeof fs {
  const wrapped: Record<string, unknown> = {};
  for (const name of ['mkdirSync', 'openSync', 'readSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync', 'realpathSync', 'readdirSync', 'rmSync', 'statSync'] as const) {
    const real = fs[name] as (...args: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]): unknown => {
      for (const argument of args.slice(0, 2)) if (typeof argument === 'string') touched.push(argument);
      return real(...args);
    };
  }
  return wrapped as unknown as typeof fs;
}

describe('committed config has no effect', () => {
  it('a repository whose committed config names diagnostics.enabled, autoSubmit and permissions: diagnostics stay off, and no repository path is opened', async (t) => {
    const touched: string[] = [];
    const w = await makeWorld(t, {
      files: {
        'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
        '.gsd-atlas/config.json': JSON.stringify({ diagnostics: { enabled: true, types: { header: 'approved' } }, autoSubmit: true, permissions: { allow: [{ executable: 'node' }] } }),
        'diagnostics.json': JSON.stringify({ catalogVersion: 1, types: { header: { state: 'approved', fields: ['atlas_version', 'catalog_version'] } } }),
        '.gsd-atlas/diagnostics.json': JSON.stringify({ catalogVersion: 1, types: { header: { state: 'approved', fields: ['atlas_version', 'catalog_version'] } } }),
      },
      host: { version: '1.2.3', diagnostics: { io: recordingFs(touched) } },
    });
    for (const args of [{ action: 'status' }, { action: 'preview', repo: w.repo.dir }, { action: 'types', repo: w.repo.dir }, { action: 'save', repo: w.repo.dir }]) {
      const reply = await w.ask('diagnostics', args);
      if (args.action === 'status') assert.equal(dataOf<StatusData>(reply).enabled, false);
      if (args.action === 'preview' || args.action === 'save') assert.deepEqual(reply.data, { enabled: false }, args.action);
    }
    assert.ok(touched.length > 0, 'the recording is live: the user directory was looked at');
    const real = fs.realpathSync.native(w.repo.dir);
    for (const touchedPath of touched) {
      const resolved = path.resolve(touchedPath);
      const inside = (root: string): boolean => resolved === root || resolved.startsWith(root + path.sep);
      assert.ok(!inside(w.repo.dir) && !inside(real), `the diagnostics module opened ${touchedPath}, which is inside the repository`);
    }
    assert.equal(fs.existsSync(userDirOf(w)), false, 'and nothing was written to the user directory');
  });

  it('an environment variable cannot enable it either: the consent loader takes the user directory and the catalog only', async (t) => {
    const saved = { enabled: process.env['GSD_ATLAS_DIAGNOSTICS'], auto: process.env['GSD_ATLAS_AUTO_SUBMIT'] };
    process.env['GSD_ATLAS_DIAGNOSTICS'] = '1';
    process.env['GSD_ATLAS_AUTO_SUBMIT'] = 'weekly';
    t.after(() => {
      if (saved.enabled === undefined) delete process.env['GSD_ATLAS_DIAGNOSTICS'];
      else process.env['GSD_ATLAS_DIAGNOSTICS'] = saved.enabled;
      if (saved.auto === undefined) delete process.env['GSD_ATLAS_AUTO_SUBMIT'];
      else process.env['GSD_ATLAS_AUTO_SUBMIT'] = saved.auto;
    });
    const w = await stateful(t);
    assert.deepEqual((await w.ask('diagnostics', { action: 'preview' })).data, { enabled: false });
  });
});
