/**
 * `gsd-atlas-mcp --allow-build` as a real process (D-15, SEC-02, plan 03-15): the flag is the one way an MCP server may run
 * a command the user approved, so its parsing and its effect on a real stdio session are tested end to end.
 *
 * It lives under scripts for the reason scripts/mcp-stdio.test.ts does: it starts the whole stack, which the module
 * lint forbids inside src. The bin reads its flags from `process.argv`, so the session tests start it through a two-line
 * launcher that appends the wanted flags and imports the real bin.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { allowAll, commandHash, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import { startMcp } from './test-helpers/mcp-client.ts';
import type { McpClient } from './test-helpers/mcp-client.ts';
import { EXIT_CEILING_MS, stderrOf } from './test-helpers/mcp-process.ts';
import { within } from './test-helpers/child-lines.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas-mcp.ts');
const runner = createRealRunner({ decide: allowAll });

const LAUNCHER = [
  "import { pathToFileURL } from 'node:url';",
  "process.argv.push(...JSON.parse(process.env.ATLAS_TEST_FLAGS ?? '[]'));",
  'await import(pathToFileURL(process.env.ATLAS_TEST_BIN).href);',
  '',
].join('\n');

const COMMAND = [process.execPath, 'evil.js'];
const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  name: 'evil',
  extensions: ['.evil'],
  grammar: { wasm: 'grammar.wasm', lock: 'grammar.lock' },
  queries: { tags: 'queries/tags.scm' },
  tiers: ['grammar', 'precise'],
  precise: { command: COMMAND },
});

interface Fixture {
  readonly cwd: string;
  readonly repoDir: string;
  readonly env: Readonly<Record<string, string>>;
  start(flags: readonly string[]): McpClient;
}

/** A repository whose module declares a precise command, and a user configuration that approves exactly that command. */
async function fixture(t: TestContext, approved: boolean): Promise<Fixture> {
  const tmp = makeTempDir();
  const repo = await createTempGitRepo({
    runner,
    world: { committed: { 'a.ts': 'export const a = 1;\n', '.gsd-atlas/languages/evil/atlas-lang.json': MANIFEST } },
  });
  const userDir = path.join(tmp.path, 'user');
  fs.mkdirSync(userDir, { recursive: true });
  if (approved) {
    const sha256 = commandHash({ executable: COMMAND[0] as string, args: COMMAND.slice(1), cwd: '.' }, repo.dir) as string;
    fs.writeFileSync(path.join(userDir, 'config.json'), JSON.stringify({ permissions: { allow: [{ repo: repo.dir, executable: COMMAND[0], sha256 }] } }));
  }
  const launcher = path.join(tmp.path, 'launch.mjs');
  fs.writeFileSync(launcher, LAUNCHER);
  const cwd = path.join(tmp.path, 'outside');
  fs.mkdirSync(cwd);
  const started: McpClient[] = [];
  t.after(async () => {
    for (const each of started) {
      each.kill();
      await each.exit();
    }
    tmp.cleanup();
    repo.cleanup();
  });
  const env: Record<string, string> = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir };
  return {
    cwd,
    repoDir: repo.dir,
    env,
    start(flags) {
      const child = startMcp({ bin: launcher, cwd, env: { ...env, ATLAS_TEST_BIN: BIN, ATLAS_TEST_FLAGS: JSON.stringify(flags) } });
      started.push(child);
      return child;
    },
  };
}

/** The reason the repository module's precise tier gives in a `lang_list` answer. */
async function preciseReason(server: McpClient, repoDir: string): Promise<string | undefined> {
  await server.handshake();
  const call = await server.callTool('lang_list', { repo: repoDir });
  assert.equal(call.envelope.ok, true, JSON.stringify(call.envelope.diagnostics));
  const modules = (call.envelope.data as { modules: Array<{ name: string; tiers: Array<{ tier: string; reason?: string }> }> }).modules;
  assert.ok(!JSON.stringify(call.envelope).includes('evil.js'), 'the manifest command is never in an answer');
  return modules.find((m) => m.name === 'evil')?.tiers.find((tier) => tier.tier === 'precise')?.reason;
}

describe('gsd-atlas-mcp: the arguments', () => {
  const run = (args: readonly string[]): ReturnType<typeof runner.run> =>
    runner.run({ executable: process.execPath, args: [BIN, ...args], timeoutMs: EXIT_CEILING_MS });

  it('an unknown flag is refused with the usage line before anything is served', async () => {
    for (const flag of ['--bogus', '--allow-build=1', 'stray']) {
      const result = await run([flag]);
      assert.equal(result.exitCode, 1, flag);
      assert.match(stderrOf(result), /Usage: gsd-atlas-mcp \[--allow-build\]/, flag);
      assert.equal(result.stdout.length, 0, `${flag}: stdout stays clean of anything but protocol frames`);
    }
  });

  it('--help prints the usage on standard error and exits 0 without serving', async () => {
    const result = await run(['--help']);
    assert.equal(result.exitCode, 0, stderrOf(result));
    assert.match(stderrOf(result), /--allow-build/);
    assert.equal(result.stdout.length, 0);
  });
});

describe('gsd-atlas-mcp --allow-build: a real stdio session', () => {
  it('--allow-build is accepted: the server starts, answers and shuts down cleanly', async (t) => {
    const f = await fixture(t, false);
    const server = f.start(['--allow-build']);
    const init = await server.handshake();
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'gsd-atlas');
    const exit = await within(EXIT_CEILING_MS, 'the shutdown', server.shutdown());
    assert.equal(exit.exitCode, 0, stderrOf(exit));
  });

  it('without the flag an approved module command is still reported as needing approval; with it, as approved', async (t) => {
    const f = await fixture(t, true);
    assert.equal(await preciseReason(f.start([]), f.repoDir), 'command_not_approved');
    assert.equal(await preciseReason(f.start(['--allow-build']), f.repoDir), 'command_approved');
  });

  it('with nothing approved, --allow-build changes nothing', async (t) => {
    const f = await fixture(t, false);
    assert.equal(await preciseReason(f.start(['--allow-build']), f.repoDir), 'command_not_approved');
  });
});
