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
