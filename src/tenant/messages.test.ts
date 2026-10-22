/**
 * The messages that tell a person what to do (WR-02, plan 02-40): the text is pinned, the holder is named when it is
 * known, no text carries a path, and the codes the CLI maps to exit codes do not change.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnostic } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { find, makeTenantWorld } from './harness.test.ts';
import { leaseHeldEnvelope, notIndexedEnvelope, notIndexedNoStore, storeUnavailableEnvelope } from './index.ts';
import { BUILD_NOTE_CODES, buildNotes } from './messages.ts';

const first = (envelope: Envelope): { readonly code: string; readonly message: string } => {
  const diagnostic = envelope.diagnostics?.[0];
  assert.ok(diagnostic, 'the envelope carries a diagnostic');
  return { code: diagnostic.code, message: diagnostic.message };
};

describe('tenant messages', () => {
  it('no store', () => {
    const { code, message } = first(notIndexedNoStore());
    assert.equal(code, 'not_indexed');
    assert.equal(
      message,
      'This repository has not been indexed yet. Run "gsd-atlas build" in a terminal inside it, then ask again.',
      'the exact text is pinned: the Host (plan 02-41), the CLI and the MCP tool all render it',
    );
    assert.deepEqual(notIndexedNoStore(), notIndexedNoStore(), 'byte-identical on every call (QRY-04)');
  });

  it('leader holds the lease', async (t) => {
    const world = await makeTenantWorld(t);
    const leader = await world.open({ version: '1.2.3', metrics: false });
    const reply = await leader.maintain('refresh', { worktree: world.repo.dir });
    assert.equal(reply.ok, false);
    const { code, message } = first(reply);
    assert.equal(code, 'not_indexed');
    assert.ok(message.includes(String(process.pid)), `names this process: ${message}`);
    assert.ok(message.includes('1.2.3'), 'and its version');
    assert.ok(message.includes('lease_held'), 'says what a build in a terminal answers');
    assert.ok(message.includes('End the agent session'), 'and what to do first');
    assert.ok(/run "gsd-atlas build" in a terminal, then start the agent again/.test(message), 'the working sequence');
    // The request path of the same situation (a code request on an unbuilt worktree) keeps its code.
    const asked = await leader.handle(find('helper', world.repo.dir), world.repo.dir);
    assert.equal(first(asked).code, 'not_indexed');
  });

  it('follower with a known holder', async (t) => {
    const world = await makeTenantWorld(t);
    const leader = await world.open({ version: '1.2.3', metrics: false });
    const follower = await world.open({ version: '4.5.6', metrics: false });
    assert.equal((await follower.status()).leader, false);
    assert.equal((await leader.status()).leader, true);

    for (const reply of [await follower.build(world.repo.dir), await follower.maintain('collect', { worktree: world.repo.dir })]) {
      const { code, message } = first(reply);
      assert.equal(code, 'lease_held', 'the code does not change');
      assert.ok(message.includes(String(process.pid)), `names the holder: ${message}`);
      assert.ok(message.includes('1.2.3'), "the leader's version");
      assert.equal(message.includes('4.5.6'), false, "not the follower's own");
      assert.ok(message.includes('start the agent again'));
    }

    const named = first(notIndexedEnvelope({ pid: 4242, version: '3.2.1' }));
    assert.equal(named.code, 'not_indexed');
    assert.ok(named.message.includes('4242') && named.message.includes('3.2.1') && named.message.includes('lease_held'));
    const held = first(leaseHeldEnvelope({ pid: 4242, version: '3.2.1' }));
    assert.equal(held.code, 'lease_held');
    assert.ok(held.message.includes('4242') && held.message.includes('3.2.1'));
  });

  it('unknown holder', () => {
    const notIndexed = first(notIndexedEnvelope(undefined));
    assert.equal(notIndexed.code, 'not_indexed');
    assert.ok(notIndexed.message.includes('another gsd-atlas process'));
    assert.ok(notIndexed.message.includes('lease_held'));
    assert.ok(notIndexed.message.includes('start the agent again'));
    const held = first(leaseHeldEnvelope(undefined));
    assert.equal(held.code, 'lease_held');
    assert.ok(held.message.includes('another gsd-atlas process'));
    assert.equal(first(storeUnavailableEnvelope()).code, 'store_unavailable');
  });

  it('no paths', async (t) => {
    const world = await makeTenantWorld(t);
    const leader = await world.open({ metrics: false });
    const follower = await world.open({ metrics: false });
    const messages = [
      first(notIndexedNoStore()).message,
      first(notIndexedEnvelope({ pid: 1, version: '0.0.1' })).message,
      first(notIndexedEnvelope(undefined)).message,
      first(leaseHeldEnvelope({ pid: 1, version: '0.0.1' })).message,
      first(leaseHeldEnvelope(undefined)).message,
      first(storeUnavailableEnvelope()).message,
      first(await leader.maintain('refresh', { worktree: world.repo.dir })).message,
      first(await follower.build(world.repo.dir)).message,
    ];
    for (const message of messages) {
      assert.equal(/[\\/]/.test(message), false, `no path separator in: ${message}`);
      assert.equal(message.includes(world.repo.dir), false);
      assert.equal(message.includes(world.storeDir), false);
    }
  });
});

describe('buildNotes: the exclusion notes of a build (quick task 261021-re7, D-03)', () => {
  const defaults = diagnostic('index_excluded_by_defaults', 'info', '3 files were left out of the index by the built-in tooling and build-output exclusions');
  const atlas = diagnostic('index_excluded_by_atlasignore', 'info', '2 files were left out of the index by .atlasignore');
  const unusable = diagnostic('atlasignore_unusable', 'warning', 'a .atlasignore file was not used: it is larger than 64 KiB in total, is not valid text, or is not a regular file');

  it('the allow-list holds the three pathless exclusion codes', () => {
    for (const code of ['index_excluded_by_defaults', 'index_excluded_by_atlasignore', 'atlasignore_unusable']) {
      assert.ok(BUILD_NOTE_CODES.includes(code), code);
    }
  });

  it('copies the three notes in the order the build reported them, and nothing that has a subject or another code', () => {
    const skipped = [
      defaults,
      diagnostic('index_excluded_by_defaults', 'info', 'with a subject', 'secret/path.ts'),
      diagnostic('gitlink_skipped', 'info', 'a submodule entry is not hashed as a file', 'vendor/sub'),
      atlas,
      unusable,
    ];
    assert.deepEqual(buildNotes(skipped, false), [defaults, atlas, unusable]);
    assert.deepEqual(buildNotes([], false), []);
  });

  it('puts the resolver note after them when the compiler pass ran out of its bound', () => {
    assert.deepEqual(buildNotes([defaults, atlas], true).map((d) => d.code), ['index_excluded_by_defaults', 'index_excluded_by_atlasignore', 'resolver_timeout']);
  });

  it('a build through the Tenant carries the notes in its envelope and no path', async (t) => {
    const world = await makeTenantWorld(t);
    world.repo.write('.atlasignore', 'ignored-by-atlas.txt\n');
    world.repo.write('ignored-by-atlas.txt', 'x\n');
    world.repo.write('node_modules/pkg/index.ts', 'export const dep = 1;\n');
    const leader = await world.open({ metrics: false });
    const reply = await leader.build(world.repo.dir);
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const codes = (reply.diagnostics ?? []).map((d) => d.code);
    assert.ok(codes.includes('index_excluded_by_defaults'), codes.join(','));
    assert.ok(codes.includes('index_excluded_by_atlasignore'), codes.join(','));
    for (const d of reply.diagnostics ?? []) {
      assert.equal(d.subject, undefined);
      assert.equal(d.message.includes('node_modules') || d.message.includes('ignored-by-atlas'), false, d.message);
    }
  });
});
