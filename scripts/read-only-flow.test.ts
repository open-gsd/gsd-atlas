/**
 * The sequence a user follows - ask, build, ask - against the real binaries (WR-01, WR-02, plan 02-41): the real
 * `gsd-atlas-mcp` server and the real `gsd-atlas` CLI on a temporary git repository, in an isolated user directory.
 *
 * What it proves: a read tool never creates a store in a repository nobody built; a store that holds no index (an
 * older schema here) is not opened, so it never holds the lease; and `gsd-atlas build` works in a terminal while the
 * agent's server is running, because the server holds nothing until an index exists. The honest limit is also
 * pinned: once the server leads an existing index, a second build answers `lease_held` (exit 3) and names the
 * process that holds it.
 *
 * Every server is ended by closing its stdin, and every temporary directory is removed after the child exited
 * (Windows keeps open files locked).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { withFixture } from './test-helpers/fixture-repo.ts';
import type { CliRun, FixtureRepo } from './test-helpers/fixture-repo.ts';
import type { Envelope, McpClient } from './test-helpers/mcp-client.ts';

const storeDirOf = (fixture: FixtureRepo): string => path.join(fixture.dir, '.git', 'gsd-atlas');

const codesOf = (envelope: Envelope): string[] => envelope.diagnostics.map((entry) => entry.code);

const find = async (server: McpClient, fixture: FixtureRepo): Promise<Envelope> =>
  (await server.callTool('code_find', { name: 'parse', repo: fixture.dir })).envelope;

const cliEnvelope = (run: CliRun): Envelope => JSON.parse(run.stdout.trim().split('\n')[0] ?? '') as Envelope;

/** Start a server, complete the handshake, and ask once about the repository nobody built. */
async function startAndAsk(fixture: FixtureRepo): Promise<McpClient> {
  const server = fixture.mcp({ cwd: fixture.dir });
  await server.initialize();
  const before = await find(server, fixture);
  assert.equal(before.ok, false);
  assert.deepEqual(codesOf(before), ['not_indexed']);
  return server;
}

async function build(fixture: FixtureRepo): Promise<CliRun> {
  return fixture.cli(['build', '--repo', fixture.dir]);
}

describe('read-only flow with the real binaries', () => {
  it('unbuilt repository writes nothing', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const server = fixture.mcp({ cwd: fixture.dir });
      await server.initialize();
      for (const [tool, args] of [
        ['code_find', { name: 'parse', repo: fixture.dir }],
        ['code_refs', { name: 'parse', repo: fixture.dir }],
        ['atlas_status', { repo: fixture.dir }],
      ] as const) {
        const { envelope } = await server.callTool(tool, args);
        assert.equal(envelope.ok, false, tool);
        assert.deepEqual(codesOf(envelope), ['not_indexed'], tool);
        assert.match(envelope.diagnostics[0]?.message ?? '', /gsd-atlas build/, tool);
        assert.equal(fs.existsSync(storeDirOf(fixture)), false, `${tool} created a store directory in .git`);
      }
      await server.close();
      assert.equal(fs.existsSync(storeDirOf(fixture)), false, 'ending the server left no store behind');
    });
  });

  it('build works while the server runs', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const server = await startAndAsk(fixture);
      const built = await build(fixture);
      assert.equal(built.code, 0, `the build must not meet the server's lease: ${built.stdout} ${built.stderr}`);
      assert.equal(fs.statSync(path.join(storeDirOf(fixture), 'facts.db')).isFile(), true);

      const after = await find(server, fixture);
      assert.equal(after.ok, true, JSON.stringify(after.diagnostics));
      assert.ok(((after.data as { results: unknown[] }).results).length > 0, 'the server finds the symbol the CLI indexed');
      assert.ok(Array.isArray(after.citations) && after.citations.length > 0, 'with citations');
      await server.close();
    });
  });

  it('second build names the holder', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const server = await startAndAsk(fixture);
      assert.equal((await build(fixture)).code, 0);
      assert.equal((await find(server, fixture)).ok, true, 'the server now leads the index');

      const leaseFile = path.join(storeDirOf(fixture), 'lease.json');
      const holder = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as { pid: number };
      assert.equal(typeof holder.pid, 'number');
      assert.notEqual(holder.pid, process.pid, 'the holder is the server process, not the test');

      const second = await build(fixture);
      assert.equal(second.code, 3, `${second.stdout} ${second.stderr}`);
      const reply = cliEnvelope(second);
      assert.deepEqual(codesOf(reply), ['lease_held']);
      assert.ok((reply.diagnostics[0]?.message ?? '').includes(String(holder.pid)), reply.diagnostics[0]?.message);
      await server.close();
    });
  });

  it('older schema is not opened', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const first = await startAndAsk(fixture);
      assert.equal((await build(fixture)).code, 0);
      assert.equal((await find(first, fixture)).ok, true);
      await first.close();

      // An index written by an older gsd-atlas: nothing in it can be read, and opening it as the leader would
      // delete and recreate it while holding the lease.
      const file = path.join(storeDirOf(fixture), 'facts.db');
      const db = new DatabaseSync(file);
      db.exec("UPDATE meta SET value = '0' WHERE name = 'schema_version'");
      db.close();

      const second = fixture.mcp({ cwd: fixture.dir });
      await second.initialize();
      const asked = await find(second, fixture);
      assert.equal(asked.ok, false);
      assert.deepEqual(codesOf(asked), ['not_indexed']);
      assert.equal(fs.existsSync(path.join(storeDirOf(fixture), 'lease.json')), false, 'the server holds no lease');

      const rebuilt = await build(fixture);
      assert.equal(rebuilt.code, 0, `${rebuilt.stdout} ${rebuilt.stderr}`);
      const answered = await find(second, fixture);
      assert.equal(answered.ok, true, JSON.stringify(answered.diagnostics));
      await second.close();
    });
  });
});
