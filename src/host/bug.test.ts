/**
 * Plan 03-32 (SKL-04, D-17): the Host's `bug` request is two steps, like `allow`. `collect` builds the bundle in memory
 * and returns the exact preview and the sha256 of the bytes; `write` carries that digest as `confirm` and writes the
 * bytes that were previewed, nothing else. It is a person's request: an MCP-origin Host refuses it.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import type { Envelope } from '../facts/index.ts';
import { configFactsOf } from './bug.ts';
import { makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);

/** Where bundles go: under the Host's cache root, in a folder of its own. */
const reportsDir = (world: World): string => path.join(String(world.options.cacheRoot), 'gsd-atlas', 'bug-reports');

interface CollectData {
  readonly preview: string;
  readonly digest: string;
}

interface WriteData {
  readonly path: string;
  readonly digest: string;
  readonly preview: string;
}

const COLLECT = (world: World, extra: Record<string, unknown> = {}): Promise<Envelope> =>
  world.ask('bug', { repo: world.repo.dir, action: 'collect', what: 'refs missed a caller', include: [], ...extra });

describe('configFactsOf: the effective configuration without a path, a command or a secret', () => {
  it('a directory is a flag, permissions are a count, tunables and disabled providers are kept', () => {
    assert.deepEqual(
      configFactsOf(
        {
          store: { dir: '/home/alice/stores' },
          indexer: { debounceMs: 25, maxWaitMs: 400 },
          gc: { graceMs: 9000 },
          permissions: { allow: [{ repo: '/r', executable: '/bin/x', sha256: 'b'.repeat(64) }, { repo: '/s', executable: '/bin/y', sha256: 'c'.repeat(64) }] },
          providers: { disabled: ['typescript', 'other'] },
        },
        false,
      ),
      {
        storeDirSet: true,
        indexer: { debounceMs: 25, maxWaitMs: 400 },
        gcGraceMs: 9000,
        allowCount: 2,
        providersDisabled: ['typescript', 'other'],
        metrics: false,
      },
    );
  });

  it('an empty configuration reduces to nothing', () => {
    assert.deepEqual(configFactsOf({}, undefined), {});
  });
});

describe('Host bug: collect writes nothing', () => {
  it('collect returns the preview and the digest of the bytes, and creates no file or folder', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const reply = await COLLECT(world);
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal(reply.schema, 'gsd-atlas.bug/1');
    const data = reply.data as CollectData;
    assert.match(data.digest, /^[0-9a-f]{64}$/);
    assert.ok(data.preview.includes('refs missed a caller'));
    assert.equal(fs.existsSync(reportsDir(world)), false, 'a dry step creates nothing');
    assert.equal(fs.existsSync(path.join(String(world.options.cacheRoot), 'gsd-atlas')), false);
    assert.equal(reply.answer_id, undefined, 'a bug reply is not a tool answer');
  });

  it('collect needs no index and no store: a repository nobody built still gets its header and text', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const reply = await COLLECT(world);
    assert.equal(reply.ok, true);
    assert.equal(fs.existsSync(path.join(world.repo.dir, '.git', 'gsd-atlas')), false, 'collecting created no store (WR-01)');
  });
});

describe('Host bug: write is bound to the digest', () => {
  it('write with the digest writes bundle.json and preview.txt, and the preview file is the previewed text', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const collected = (await COLLECT(world)).data as CollectData;
    const reply = await world.ask('bug', {
      repo: world.repo.dir,
      action: 'write',
      what: 'refs missed a caller',
      include: [],
      confirm: collected.digest,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const data = reply.data as WriteData;
    assert.equal(path.dirname(data.path), reportsDir(world));
    assert.equal(data.digest, collected.digest);
    assert.deepEqual(fs.readdirSync(data.path).sort(), ['bundle.json', 'preview.txt']);
    const bundleBytes = fs.readFileSync(path.join(data.path, 'bundle.json'));
    assert.equal(crypto.createHash('sha256').update(bundleBytes).digest('hex'), collected.digest, 'the written bytes are the digested bytes');
    assert.equal(fs.readFileSync(path.join(data.path, 'preview.txt'), 'utf8'), collected.preview, 'preview.txt is the previewed text');
    assert.equal(data.preview, collected.preview);
    const parsed = JSON.parse(bundleBytes.toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['format', 'header', 'problem']);
    assert.deepEqual(parsed['header'], { atlas_version: '1.2.3', catalog_version: 1 });
  });

  it('the folders are 0700 and the files 0600 where the platform has modes', { skip: process.platform === 'win32' }, async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const collected = (await COLLECT(world)).data as CollectData;
    const reply = await world.ask('bug', { repo: world.repo.dir, action: 'write', what: 'refs missed a caller', include: [], confirm: collected.digest });
    const dir = (reply.data as WriteData).path;
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(reportsDir(world)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'bundle.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'preview.txt')).mode & 0o777, 0o600);
  });

  it('confirm mismatch: a digest that is not the one collected writes nothing', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    await COLLECT(world);
    const reply = await world.ask('bug', { repo: world.repo.dir, action: 'write', what: 'refs missed a caller', include: [], confirm: 'a'.repeat(64) });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['confirm_mismatch']);
    assert.equal(fs.existsSync(reportsDir(world)), false);
  });

  it('confirm mismatch: the right digest with changed arguments writes nothing', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const collected = (await COLLECT(world)).data as CollectData;
    const reply = await world.ask('bug', { repo: world.repo.dir, action: 'write', what: 'something else', include: [], confirm: collected.digest });
    assert.deepEqual(codes(reply), ['confirm_mismatch']);
    assert.equal(fs.existsSync(reportsDir(world)), false);
  });

  it('a write with no collect before it is a confirm mismatch', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const reply = await world.ask('bug', { repo: world.repo.dir, action: 'write', what: 'x', include: [], confirm: 'b'.repeat(64) });
    assert.deepEqual(codes(reply), ['confirm_mismatch']);
  });

  it('already written: a second write for the same digest is refused and leaves the first bundle alone', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const collected = (await COLLECT(world)).data as CollectData;
    const args = { repo: world.repo.dir, action: 'write', what: 'refs missed a caller', include: [], confirm: collected.digest };
    const first = await world.ask('bug', args);
    assert.equal(first.ok, true);
    const before = fs.readFileSync(path.join((first.data as WriteData).path, 'bundle.json'));
    const second = await world.ask('bug', args);
    assert.equal(second.ok, false);
    assert.deepEqual(codes(second), ['already_written']);
    assert.deepEqual(fs.readdirSync(reportsDir(world)).length, 1);
    assert.deepEqual(fs.readFileSync(path.join((first.data as WriteData).path, 'bundle.json')), before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 2: the forensic types over a real Host, Tenant, store and flight recorder.
// ---------------------------------------------------------------------------------------------------------------------

const ALL = ['problem', 'versions', 'health', 'recorder', 'failing'] as const;
const storeDirOf = (world: World): string => path.join(world.repo.dir, '.git', 'gsd-atlas');
const HOST = { version: '1.2.3' } as const;

interface Written {
  readonly reply: Envelope;
  readonly dir: string;
  readonly text: string;
  readonly bundle: Record<string, unknown>;
  readonly preview: string;
}

/** Collect, write and read back: the two steps a person's CLI takes. */
async function bundleOf(world: World, args: Record<string, unknown>): Promise<Written> {
  const collected = await world.ask('bug', { repo: world.repo.dir, action: 'collect', ...args });
  assert.equal(collected.ok, true, JSON.stringify(collected.diagnostics));
  const { digest } = collected.data as CollectData;
  const reply = await world.ask('bug', { repo: world.repo.dir, action: 'write', ...args, confirm: digest });
  assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
  const dir = (reply.data as WriteData).path;
  const text = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
  return { reply, dir, text, bundle: JSON.parse(text) as Record<string, unknown>, preview: fs.readFileSync(path.join(dir, 'preview.txt'), 'utf8') };
}

async function answeredWorld(t: TestContext, host: Record<string, unknown> = HOST): Promise<{ world: World; ids: string[] }> {
  const world = await makeWorld(t, { host });
  const built = await world.ask('build', { repo: world.repo.dir });
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  const ids: string[] = [];
  for (const name of ['helper', 'boot', 'Widget']) {
    const answer = await world.ask('code_find', { name, repo: world.repo.dir });
    assert.equal(answer.ok, true, JSON.stringify(answer.diagnostics));
    ids.push(String(answer.answer_id));
  }
  return { world, ids };
}

describe('Host bug: versions, health, recorder and the failing answer', () => {
  it('every type approved: the bundle has all five sections and the fixed key order', async (t: TestContext) => {
    const { world } = await answeredWorld(t);
    const out = await bundleOf(world, { include: [...ALL], what: 'wrong caller' });
    assert.deepEqual(Object.keys(out.bundle), ['format', 'header', 'problem', 'versions', 'health', 'recorder', 'failing']);
    assert.deepEqual((out.reply.data as { included: string[] }).included, [...ALL]);
  });

  it('versions: the running versions, the loaded modules and a configuration with no path, command or secret', async (t: TestContext) => {
    const { world } = await answeredWorld(t, {
      version: '1.2.3',
      config: {
        gc: { graceMs: 5000 },
        indexer: { debounceMs: 20 },
        permissions: { allow: [{ repo: '/secret/repo', executable: '/secret/bin/tool', sha256: 'a'.repeat(64) }] },
        providers: { disabled: ['typescript'] },
      },
    });
    const out = await bundleOf(world, { include: ['versions'] });
    const versions = out.bundle['versions'] as Record<string, unknown>;
    assert.equal(versions['atlas'], '1.2.3');
    assert.equal(versions['node'], process.versions.node);
    assert.equal(versions['sqlite'], process.versions.sqlite);
    assert.equal(versions['driver'], 'node:sqlite');
    assert.equal(versions['policy_mode'], 'none');
    assert.ok((versions['modules'] as unknown[]).length >= 1, 'the loaded modules are listed');
    assert.deepEqual(versions['config_effective'], {
      indexer: { debounceMs: 20 },
      gc: { graceMs: 5000 },
      permissions: { allowCount: 1 },
      providers: { disabled: ['typescript'] },
    });
    assert.ok(!out.text.includes('/secret'));
  });

  it('health: store, host and tier facts as numbers and codes; the real store reports a leader that was not rebuilt', async (t: TestContext) => {
    const { world } = await answeredWorld(t);
    const out = await bundleOf(world, { include: ['health'] });
    const health = out.bundle['health'] as Record<string, Record<string, unknown>>;
    assert.equal(health['store']?.['schema_version'], 2);
    assert.equal(health['store']?.['worktrees'], 1);
    assert.equal(health['store']?.['writer_lease_held'], true);
    assert.equal(health['store']?.['rebuilt_after_corruption'], false);
    assert.equal(typeof health['store']?.['size'], 'string');
    assert.equal(health['host']?.['tenants_loaded'], 1);
    assert.equal(health['host']?.['transport'], 'in-process');
    assert.ok(!out.text.includes(world.repo.dir));
  });

  it('recorder: the answers this repository gave, oldest first, with tool, outcome and a count; names are tokens', async (t: TestContext) => {
    const { world } = await answeredWorld(t);
    const out = await bundleOf(world, { include: ['recorder'] });
    const recorder = out.bundle['recorder'] as { kept: number; total: number; events: Array<Record<string, unknown>> };
    assert.equal(recorder.total, 3);
    assert.equal(recorder.kept, 3);
    assert.deepEqual(recorder.events.map((each) => each['tool']), ['code_find', 'code_find', 'code_find']);
    assert.equal(recorder.events[2]?.['t'], '-0.0s');
    assert.ok(recorder.events.every((each) => each['outcome'] === 'ok'));
    assert.ok(!out.text.includes('helper') && !out.text.includes('Widget') && !out.text.includes('boot'), 'symbol names are hashed');
    assert.ok(!out.text.includes(world.repo.dir));
  });

  it('failing answer: defaults to the last recorded answer and explains up to five of its facts', async (t: TestContext) => {
    const { world, ids } = await answeredWorld(t);
    const out = await bundleOf(world, { include: ['failing'] });
    const failing = out.bundle['failing'] as Record<string, unknown>;
    assert.equal(failing['answer_id'], ids[2]);
    assert.equal(failing['tool'], 'code_find');
    const envelope = failing['envelope'] as Record<string, unknown>;
    assert.equal(envelope['schema'], 'gsd-atlas.code-find/1');
    assert.equal(envelope['ok'], true);
    assert.equal(typeof envelope['watermark_seq'], 'number');
    assert.ok((envelope['citations'] as number) >= 1);
    const explain = failing['explain'] as Array<Record<string, unknown>>;
    assert.ok(explain.length >= 1 && explain.length <= 5);
    for (const fact of explain) {
      assert.equal(fact['status'], 'ok');
      assert.equal(fact['tier'], 'grammar');
      assert.equal(typeof fact['kind'], 'string');
      assert.equal(fact['extractor'], 'grammar');
    }
  });

  it('failing answer: --answer picks an earlier one, and an id the recorder does not hold is answer_not_found but still writes', async (t: TestContext) => {
    const { world, ids } = await answeredWorld(t);
    const first = await bundleOf(world, { include: ['failing'], answer: ids[0] });
    assert.equal((first.bundle['failing'] as Record<string, unknown>)['answer_id'], ids[0]);
    const gone = await bundleOf(world, { include: ['failing', 'versions'], answer: 'a_ffffffffffffffff' });
    assert.deepEqual(gone.bundle['failing'], { status: 'answer_not_found' });
    assert.ok('versions' in gone.bundle);
  });

  it('a type that was not approved is absent, and an unapproved recorder leaves no event count either', async (t: TestContext) => {
    const { world } = await answeredWorld(t);
    const out = await bundleOf(world, { include: ['versions'] });
    assert.deepEqual(Object.keys(out.bundle), ['format', 'header', 'problem', 'versions']);
    assert.ok(!out.text.includes('code_find'));
    assert.ok(!/"(kept|total)"/.test(out.text));
  });

  it('a repository nobody built: versions and host health are there, the repository types say unavailable, and nothing is created', async (t: TestContext) => {
    const world = await makeWorld(t, { host: HOST });
    const out = await bundleOf(world, { include: [...ALL], what: 'no index' });
    assert.equal((out.bundle['versions'] as Record<string, unknown>)['atlas'], '1.2.3');
    assert.deepEqual(out.bundle['recorder'], { status: 'unavailable' });
    assert.deepEqual(out.bundle['failing'], { status: 'unavailable' });
    assert.deepEqual((out.bundle['health'] as Record<string, unknown>)['store'], { status: 'unavailable' });
    assert.equal(fs.existsSync(storeDirOf(world)), false, 'bug created no store (WR-01)');
  });

  it('a directory that is not a repository: the repository types say unavailable and the bundle is still written', async (t: TestContext) => {
    const world = await makeWorld(t, { host: HOST });
    const outside = path.join(world.tmp.path, 'not-a-repo');
    fs.mkdirSync(outside);
    const collected = await world.ask('bug', { repo: outside, action: 'collect', include: [...ALL], what: 'x' });
    assert.equal(collected.ok, true, JSON.stringify(collected.diagnostics));
    assert.ok((collected.data as CollectData).preview.includes('"unavailable"'));
  });

  it('collecting does not change what the next bug sees: no answer is recorded and the session is not marked', async (t: TestContext) => {
    const { world, ids } = await answeredWorld(t);
    await bundleOf(world, { include: [...ALL] });
    const again = await bundleOf(world, { include: ['recorder', 'failing'] });
    assert.equal((again.bundle['recorder'] as { total: number }).total, 3);
    assert.equal((again.bundle['failing'] as Record<string, unknown>)['answer_id'], ids[2]);
  });
});

/** An event line for the flight recorder, heavy enough that 200 of them cannot fit in 1 MiB when written raw. */
function heavyEvent(index: number): string {
  const hex = index.toString(16).padStart(16, '0');
  const handle = (at: number): string => `ref/${'p'.repeat(150)}${String(at)}.ts/0123456789abcdef0123456789abcdef01234567/${String(at)}`;
  return JSON.stringify({
    t: 1_900_000_000_000 + index * 1000,
    kind: 'answer',
    id: `a_${hex}`,
    tool: 'code_refs',
    args: { name: `symbol_${String(index)}`, fresh: Array.from({ length: 20 }, (_unused, at) => `${'f'.repeat(180)}${String(at)}.ts`) },
    outcome: 'ok',
    ms: 'le50',
    degraded: [],
    count: 20,
    handles: Array.from({ length: 20 }, (_unused, at) => handle(at)),
  });
}

describe('Host bug: size and the recorder cap', () => {
  async function recorderWith(t: TestContext, count: number, host: Record<string, unknown> = HOST): Promise<World> {
    const { world } = await answeredWorld(t, host);
    const dir = path.join(storeDirOf(world), 'flight');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'flight.jsonl'), `${Array.from({ length: count }, (_unused, at) => heavyEvent(at)).join('\n')}\n`);
    return world;
  }

  it('2,000 events and a long failing answer give a bundle within 1 MiB, trimmed oldest first, and the preview says so', async (t: TestContext) => {
    const world = await recorderWith(t, 2000);
    const collected = await world.ask('bug', {
      repo: world.repo.dir,
      action: 'collect',
      include: [...ALL],
      mode: 'raw',
      confirm_raw: true,
      answer: `a_${(1999).toString(16).padStart(16, '0')}`,
    });
    assert.equal(collected.ok, true, JSON.stringify(collected.diagnostics));
    const written = await bundleOf(world, { include: [...ALL], mode: 'raw', confirm_raw: true, answer: `a_${(1999).toString(16).padStart(16, '0')}` });
    assert.ok(Buffer.byteLength(written.text, 'utf8') <= 1_048_576, `bundle is ${String(Buffer.byteLength(written.text, 'utf8'))} bytes`);
    const recorder = written.bundle['recorder'] as { kept: number; total: number };
    assert.equal(recorder.total, 200, 'only the newest bug.excerptEvents events are considered');
    assert.ok(recorder.kept < recorder.total && recorder.kept > 0, `kept ${String(recorder.kept)}`);
    assert.ok(written.preview.includes(`excerpt trimmed to ${String(recorder.kept)} of 200 events`));
    assert.equal(written.preview.split('\n')[0], 'RAW MODE: names and paths are included as they are');
    assert.equal((written.bundle['failing'] as Record<string, unknown>)['answer_id'], `a_${(1999).toString(16).padStart(16, '0')}`);
  });

  it('the recorder never exceeds its excerpt cap: 2,000 events approved give at most bug.excerptEvents, unapproved give none', async (t: TestContext) => {
    const world = await recorderWith(t, 2000);
    const approved = await bundleOf(world, { include: ['recorder'] });
    const recorder = approved.bundle['recorder'] as { kept: number; total: number; events: unknown[] };
    assert.equal(recorder.events.length, recorder.kept);
    assert.ok(recorder.kept <= 200);
    assert.equal(recorder.total, 200);
    const none = await bundleOf(world, { include: ['versions'] });
    assert.ok(!('recorder' in none.bundle));
    assert.ok(!none.text.includes('2000') && !none.text.includes('"kept"'));
  });

  it('bug.excerptEvents and bug.bundleMaxBytes are the Host tuning: a small cap trims a hashed bundle too', async (t: TestContext) => {
    const world = await recorderWith(t, 300, { version: '1.2.3', bug: { excerptEvents: 50, bundleMaxBytes: 12_000 } });
    const out = await bundleOf(world, { include: ['recorder'] });
    const recorder = out.bundle['recorder'] as { kept: number; total: number };
    assert.equal(recorder.total, 50);
    assert.ok(recorder.kept < 50 && recorder.kept > 0);
    assert.ok(Buffer.byteLength(out.text, 'utf8') <= 12_000);
  });
});

describe('Host bug: what never goes in', () => {
  it('untrusted_text and source lines never reach the bundle, in any mode, although the answer carried them', async (t: TestContext) => {
    const { world } = await answeredWorld(t);
    const answer = await world.ask('code_find', { name: 'helper', repo: world.repo.dir });
    assert.ok(answer.untrusted_text !== undefined, 'the answer carried untrusted text, so the absence below is not vacuous');
    const lineTexts = (answer.untrusted_text?.entries ?? []).map((entry) => entry.text).filter((line) => line.length >= 4);
    assert.ok(lineTexts.length > 0);
    for (const mode of ['hashed', 'redacted', 'raw'] as const) {
      const out = await bundleOf(world, { include: [...ALL], mode, ...(mode === 'raw' ? { confirm_raw: true } : {}) });
      for (const line of lineTexts) assert.ok(!out.text.includes(line), `${mode} carries a source line`);
      assert.ok(!out.text.includes('untrusted_text'));
      assert.ok(!out.text.includes(answer.untrusted_text?.nonce ?? 'no-nonce'));
    }
  });
});

describe('Host bug: who may ask, and what is refused', () => {
  it('an MCP-origin Host refuses the whole kind before reading the arguments', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { origin: 'mcp', version: '1.2.3' } });
    for (const args of [{ action: 'collect' }, { nonsense: true }, undefined]) {
      const reply = await world.ask('bug', args);
      assert.deepEqual(codes(reply), ['bug_forbidden']);
    }
    assert.equal(fs.existsSync(reportsDir(world)), false);
  });

  it('strict arguments: an unknown key, a bad type, an unknown include and a bad action are invalid_args', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const refused: Array<Record<string, unknown>> = [
      { action: 'collect', extra: 1 },
      { action: 'collect', what: 5 },
      { action: 'collect', include: ['everything'] },
      { action: 'collect', mode: 'loud' },
      { action: 'collect', rating: 'great' },
      { action: 'collect', feature: 'nonsense' },
      { action: 'collect', answer: 'not an answer id' },
      { action: 'nothing' },
      {},
    ];
    for (const args of refused) {
      const reply = await world.ask('bug', { repo: world.repo.dir, ...args });
      assert.deepEqual(codes(reply), ['invalid_args'], JSON.stringify(args));
    }
  });

  it('raw mode without the confirmation is refused in a fixed sentence, and nothing is collected', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const reply = await COLLECT(world, { mode: 'raw' });
    assert.deepEqual(codes(reply), ['raw_not_confirmed']);
    const confirmed = await COLLECT(world, { mode: 'raw', confirm_raw: true });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed.diagnostics));
    assert.equal((confirmed.data as CollectData).preview.split('\n')[0], 'RAW MODE: names and paths are included as they are');
  });

  it('a directory that is not a repository is not_a_repo only for a type that needs one; the header and text need none', async (t: TestContext) => {
    const world = await makeWorld(t, { host: { version: '1.2.3' } });
    const outside = path.join(world.tmp.path, 'not-a-repo');
    fs.mkdirSync(outside);
    const plain = await world.ask('bug', { repo: outside, action: 'collect', what: 'x', include: [] });
    assert.equal(plain.ok, true, JSON.stringify(plain.diagnostics));
  });
});
