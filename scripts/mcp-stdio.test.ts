/**
 * The stdio MCP server as a real process (HST-01, QRY-06): `src/bin/gsd-atlas-mcp.ts` started through the
 * CommandRunner with a controllable stdin, over a real index built by the real Host in a temporary git repository.
 * Every stdout line the server prints is parsed as JSON; a stray write would fail the framing assertions.
 *
 * It lives under scripts because it composes the whole stack, which the adapter lint forbids inside src/mcp-shim.
 * Latencies are never asserted to the millisecond: the ceilings (in test-helpers/mcp-process.ts) only turn a hung
 * child into a failed test, because hosted runners are noisy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { composeHost } from '../src/bin/compose.ts';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { PROTOCOL_VERSION, TOOL_NAMES } from '../src/host-client/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';
import { within } from './test-helpers/child-lines.ts';
import { startMcp } from './test-helpers/mcp-client.ts';
import type { McpClient } from './test-helpers/mcp-client.ts';
import { EXIT_CEILING_MS, stderrOf } from './test-helpers/mcp-process.ts';
import type { Envelope, RpcMessage } from './test-helpers/mcp-process.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas-mcp.ts');
const runner = createRealRunner({ decide: allowAll });

const FILES: Readonly<Record<string, string>> = {
  'a.ts': 'export function load(): number {\n  return 1;\n}\n',
  'b.ts': "import { load } from './a';\nexport function run(): number {\n  return load();\n}\n",
  'c.ts': "import { run } from './b';\nexport function main(): number {\n  return run();\n}\n",
};

export interface Fixture {
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  /** The environment the server runs in: isolated git, HOME and user directory. */
  readonly env: Readonly<Record<string, string>>;
  /** A directory that is not a repository, used as the server's working directory. */
  readonly outside: string;
  start(cwd?: string, extraEnv?: Readonly<Record<string, string>>): McpClient;
}

function sink(): { write(text: string): boolean } {
  return { write: () => true };
}

export interface FixtureOptions {
  readonly files?: Readonly<Record<string, string>>;
  /** Build the index before the test starts (default true). */
  readonly build?: boolean;
}

/** A temporary repository whose index was built by the real Host in this process, which then let go of it. */
export async function makeFixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const tmp = makeTempDir();
  const setupRunner = createRealRunner({ decide: allowAll });
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: options.files ?? FILES } });
  const userDir = path.join(tmp.path, 'user');
  const env: Record<string, string> = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir };
  const outside = path.join(tmp.path, 'outside');
  fs.mkdirSync(outside);
  const started: McpClient[] = [];
  t.after(async () => {
    for (const each of started) {
      each.kill();
      await each.exit();
    }
    tmp.cleanup();
    repo.cleanup();
  });
  if (options.build !== false) {
    const composed = composeHost({ cwd: outside, env: { ...process.env, ...env }, home: env['HOME'] as string, stderr: sink() });
    try {
      const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: repo.dir } });
      assert.equal(built.ok, true, `the fixture build failed: ${JSON.stringify(built.diagnostics)}`);
    } finally {
      await composed.dispose();
    }
  }
  return {
    repo,
    tmp,
    env,
    outside,
    start(cwd = outside, extraEnv = {}) {
      const child = startMcp({ bin: BIN, cwd, env: { ...env, ...extraEnv } });
      started.push(child);
      return child;
    },
  };
}

interface FindRow {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly citation: string;
}

export const findRows = (envelope: Envelope): FindRow[] => (envelope.data as { results: FindRow[] }).results;

describe('gsd-atlas-mcp over stdio: the default profile and a first tool call', () => {
  it('tools/list over a real stdio session returns exactly the seven tools, each read-only', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    const init = await server.handshake();
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'gsd-atlas');
    const tools = await server.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
  });

  it('tools/call code_find answers the definition from the built index, as one envelope in one text item', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    await server.handshake();
    const call = await server.callTool('code_find', { name: 'load', repo: fixture.repo.dir });
    assert.notEqual(call.result.isError, true, call.result.content[0]?.text);
    assert.equal(call.envelope.schema, 'gsd-atlas.code-find/1');
    assert.equal(call.envelope.ok, true);
    const first = findRows(call.envelope)[0];
    assert.equal(first?.name, 'load');
    assert.equal(first?.path, 'a.ts');
    assert.equal(first?.line, 1);
    const citations = call.envelope['citations'] as Array<{ id: string; path: string }>;
    assert.ok(citations.some((citation) => citation.id === first?.citation && citation.path === 'a.ts'), 'the result is cited');
    for (const line of server.lines) assert.doesNotThrow(() => JSON.parse(line), `every stdout line is JSON: ${line}`);
    await server.shutdown();
  });

  it('EOF: closing stdin after initialize ends the process with exit code 0', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    await server.handshake();
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
    assert.equal(exit.signal, null);
  });
});

const NOISE_CHILD = path.resolve(import.meta.dirname, 'test-helpers', 'stdout-noise-child.ts');
const FRAME = '{"jsonrpc":"2.0","method":"frame"}\n';

/** Every stdout line of a finished or running server must be one JSON-RPC 2.0 message object. */
function assertFramed(server: McpClient): void {
  assert.ok(server.lines.length > 0, 'the server printed at least one frame');
  for (const line of server.lines) {
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `a stdout line is not JSON: ${JSON.stringify(line)}`);
    assert.equal(typeof parsed, 'object', `a stdout line is not an object: ${JSON.stringify(line)}`);
    assert.equal((parsed as RpcMessage).jsonrpc, '2.0', `a stdout line is not JSON-RPC 2.0: ${JSON.stringify(line)}`);
  }
}

describe('stdout hygiene (T-02-79, research Pitfall 8)', () => {
  for (const mode of ['once', 'twice', 'reload']) {
    it(`framing: with the guard loaded (${mode}), direct writes and console output reach stderr, and the protocol stream reaches stdout`, async () => {
      const result = await runner.run({ executable: process.execPath, args: [NOISE_CHILD, mode], cwd: import.meta.dirname });
      assert.equal(result.spawnError, undefined);
      const stdout = Buffer.from(result.stdout).toString('utf8');
      const stderr = stderrOf(result);
      assert.equal(result.exitCode, 0, stderr);
      assert.equal(stdout, FRAME, 'stdout holds the protocol frame and nothing else');
      assert.match(stderr, /noise-direct/);
      assert.match(stderr, /noise-console/);
    });
  }

  it('framing: every line the real server prints is a JSON-RPC message', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    await server.handshake();
    await server.listTools();
    await server.callTool('code_find', { name: 'load', repo: fixture.repo.dir });
    await server.callTool('code_find', { name: 'x', repo: fixture.outside });
    await server.shutdown();
    assertFramed(server);
    assert.equal(server.lines.length, server.messages.length, 'no line failed to parse');
  });

  it('trace-warnings: with NODE_OPTIONS adding --trace-warnings the framing still holds', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start(fixture.outside, { NODE_OPTIONS: '--trace-warnings --pending-deprecation' });
    await server.handshake();
    await server.listTools();
    await server.callTool('code_find', { name: 'load', repo: fixture.repo.dir });
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
    assertFramed(server);
  });
});

describe('stdout hygiene: source layout', () => {
  const srcDir = path.resolve(import.meta.dirname, '..', 'src');
  const firstImport = (file: string): string | undefined => /^import\b[^;]*;/m.exec(fs.readFileSync(file, 'utf8'))?.[0];

  it("the bin's first import is the MCP shim, whose first import is the stdout guard (it runs before any other module code)", () => {
    assert.match(firstImport(path.join(srcDir, 'bin', 'gsd-atlas-mcp.ts')) ?? '', /from '\.\.\/mcp-shim\/index\.ts'/);
    assert.match(firstImport(path.join(srcDir, 'mcp-shim', 'index.ts')) ?? '', /from '\.\/stdout-guard\.ts'/);
  });

  it('the guard assigns process.stdout.write and contains no console token', () => {
    const guard = fs.readFileSync(path.join(srcDir, 'mcp-shim', 'stdout-guard.ts'), 'utf8');
    assert.match(guard, /\.write = /);
    assert.doesNotMatch(guard, /console/);
  });
});

/** Every path under `dir`, relative, sorted: a listing that notices anything created or removed. */
function listing(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];
}

describe('startup does no heavy work and side effects', () => {
  it('lazy start: initialize and tools/list are answered with an unwritable user directory and home, in a directory that is not a repository, creating nothing', async (t) => {
    const fixture = await makeFixture(t, { build: false });
    // A regular file stands where the directories would be: they cannot be created or read on any platform.
    const blocker = path.join(fixture.tmp.path, 'blocker');
    fs.writeFileSync(blocker, 'a file, not a directory\n');
    const blockedHome = path.join(blocker, 'home');
    const env = {
      HOME: blockedHome,
      USERPROFILE: blockedHome,
      XDG_CONFIG_HOME: path.join(blocker, 'config'),
      XDG_CACHE_HOME: path.join(blocker, 'cache'),
      GSD_ATLAS_USER_DIR: path.join(blocker, 'user'),
    };
    const watched = [fixture.outside, fixture.tmp.path, fixture.repo.dir];
    const before = watched.map(listing);
    const server = fixture.start(fixture.outside, env);
    const init = await server.handshake();
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'gsd-atlas');
    const tools = await server.listTools();
    assert.equal(tools.length, 7);
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
    assert.deepEqual(watched.map(listing), before, 'initialize and tools/list created nothing');
    assert.ok(!fs.existsSync(path.join(fixture.repo.dir, '.git', 'gsd-atlas')), 'no store was created inside the repository');
  });

  it('EOF: a stdin closed before any byte exits 0 with empty stdout', async (t) => {
    const fixture = await makeFixture(t, { build: false });
    const server = fixture.start();
    server.endInput();
    const exit = await within(EXIT_CEILING_MS, 'the server to exit', server.exit());
    assert.equal(exit.exitCode, 0, stderrOf(exit));
    assert.deepEqual(server.lines, []);
  });
});

describe('errors stay inside the protocol', () => {
  it('not_a_repo: a repo that is not a repository gives the not_a_repo envelope as an error result, and the server keeps answering', async (t) => {
    const fixture = await makeFixture(t, { build: false });
    const server = fixture.start();
    await server.handshake();
    const call = await server.callTool('code_find', { name: 'x', repo: fixture.outside });
    assert.equal(call.result.isError, true);
    assert.equal(call.envelope.ok, false);
    assert.equal(call.envelope.diagnostics[0]?.code, 'not_a_repo');
    assert.equal((await server.listTools()).length, 7, 'the server keeps running');
    const exit = await server.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
  });

  it('invalid arguments: an unknown property and a missing name are refused by the schema, and the server keeps answering', async (t) => {
    const fixture = await makeFixture(t);
    const server = fixture.start();
    await server.handshake();
    for (const args of [{ name: 'load', surprise: true, repo: fixture.repo.dir }, { repo: fixture.repo.dir }]) {
      const reply = await server.request('tools/call', { name: 'code_find', arguments: args });
      const refused = reply.error !== undefined || (reply.result as { isError?: boolean } | undefined)?.isError === true;
      assert.ok(refused, `expected a refusal for ${JSON.stringify(args)}, got ${JSON.stringify(reply)}`);
    }
    const ok = await server.callTool('code_find', { name: 'load', repo: fixture.repo.dir });
    assert.equal(ok.envelope.ok, true);
    await server.shutdown();
  });

  it('a call to an unknown tool is refused, not served', async (t) => {
    const fixture = await makeFixture(t, { build: false });
    const server = fixture.start();
    await server.handshake();
    for (const name of ['build', 'maintain', 'lang_test']) {
      const reply = await server.request('tools/call', { name, arguments: { repo: fixture.repo.dir } });
      const refused = reply.error !== undefined || (reply.result as { isError?: boolean } | undefined)?.isError === true;
      assert.ok(refused, `${name} is not an MCP tool, got ${JSON.stringify(reply)}`);
    }
    await server.shutdown();
  });
});

/** The fenced entries of an envelope with its per-response nonce masked, so two answers to one question compare equal. */
function fencedEntries(envelope: Envelope): Array<{ ref: string; text: string }> {
  const fenced = envelope['untrusted_text'] as { nonce: string; entries: Array<{ ref: string; text: string }> } | undefined;
  assert.ok(fenced !== undefined && fenced.nonce !== '', 'the answer carries fenced text with a nonce');
  return fenced.entries.map((entry) => ({ ref: entry.ref, text: entry.text.replaceAll(fenced.nonce, 'NONCE') }));
}

/** Ask code_find until `accept` approves the answer, or fail after a generous wall-clock bound (no latency is asserted). */
async function findEventually(
  server: McpClient,
  args: Record<string, unknown>,
  accept: (envelope: Envelope) => boolean,
  what: string,
): Promise<Envelope> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const call = await server.callTool('code_find', args);
    if (accept(call.envelope)) return call.envelope;
    if (Date.now() > deadline) assert.fail(`${what}; the last answer was ${JSON.stringify(call.envelope)}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

describe('restart between calls (HST-01): the store and the start-up Reconcile persist the truth', () => {
  it('restart: after the first process is SIGKILLed, a new process answers the next call identically', async (t) => {
    const fixture = await makeFixture(t);
    const args = { name: 'load', repo: fixture.repo.dir };

    const first = fixture.start();
    await first.handshake();
    const before = await first.callTool('code_find', args);
    assert.equal(before.envelope.ok, true);
    assert.equal(findRows(before.envelope)[0]?.path, 'a.ts');
    first.kill();
    await first.exit();

    const second = fixture.start();
    await second.handshake();
    const after = await second.callTool('code_find', args);
    assert.equal(after.envelope.ok, true, JSON.stringify(after.envelope.diagnostics));
    // The first call after a restart may report a degraded state, but it returns the same facts.
    // Same definitions, positions and citations; the fence nonce is per response, so it is masked in the fenced text.
    assert.deepEqual(after.envelope.data, before.envelope.data);
    assert.deepEqual(after.envelope['citations'], before.envelope['citations']);
    assert.deepEqual(fencedEntries(after.envelope), fencedEntries(before.envelope));
    const exit = await second.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
  });

  it('restart: a clean shutdown immediately after a call, then a new process, answers the same', async (t) => {
    const fixture = await makeFixture(t);
    const args = { name: 'run', repo: fixture.repo.dir };
    const first = fixture.start();
    await first.handshake();
    const before = await first.callTool('code_find', args);
    const closed = await first.shutdown();
    assert.equal(closed.exitCode, 0, stderrOf(closed));

    const second = fixture.start();
    await second.handshake();
    const after = await second.callTool('code_find', args);
    assert.deepEqual(after.envelope.data, before.envelope.data);
    assert.deepEqual(after.envelope['citations'], before.envelope['citations']);
    await second.shutdown();
  });

  it('edit while stopped: a file changed while no server was running is reflected by the next process', async (t) => {
    const fixture = await makeFixture(t);
    const first = fixture.start();
    await first.handshake();
    const before = await first.callTool('code_find', { name: 'extra', repo: fixture.repo.dir });
    assert.deepEqual(findRows(before.envelope), [], 'extra does not exist yet');
    first.kill();
    await first.exit();

    fixture.repo.write('a.ts', 'export function load(): number {\n  return 1;\n}\nexport function extra(): number {\n  return 2;\n}\n');

    const second = fixture.start();
    await second.handshake();
    // Read your own writes: naming the changed path makes the answer fresh at once.
    const named = await second.callTool('code_find', { name: 'extra', repo: fixture.repo.dir, fresh: ['a.ts'] });
    assert.equal(named.envelope.ok, true, JSON.stringify(named.envelope.diagnostics));
    assert.equal(findRows(named.envelope)[0]?.path, 'a.ts');
    assert.equal(findRows(named.envelope)[0]?.line, 4);
    await second.shutdown();

    // Without naming the path, the start-up Reconcile finds the change: the answer may be degraded while it runs.
    const third = fixture.start();
    await third.handshake();
    const found = await findEventually(
      third,
      { name: 'extra', repo: fixture.repo.dir },
      (envelope) => envelope.ok && findRows(envelope).some((row) => row.path === 'a.ts'),
      'the start-up Reconcile never reflected the edit',
    );
    assert.equal(findRows(found)[0]?.line, 4);
    await third.shutdown();
  });

  it('kill during call: a call racing a SIGKILL of the server fails for the client, and a new process answers the retry', async (t) => {
    const fixture = await makeFixture(t);
    const args = { name: 'load', repo: fixture.repo.dir };
    const first = fixture.start();
    await first.handshake();
    const racing = first.request('tools/call', { name: 'code_find', arguments: args });
    first.kill();
    await assert.rejects(racing, /exited|before answering/, 'the call that raced the kill does not get an answer');
    await first.exit();
    for (const line of first.lines) assert.doesNotThrow(() => JSON.parse(line), 'a killed server leaves no torn frame on stdout');

    const second = fixture.start();
    await second.handshake();
    const retry = await second.callTool('code_find', args);
    assert.equal(retry.envelope.ok, true);
    assert.equal(findRows(retry.envelope)[0]?.path, 'a.ts');
    await second.shutdown();
  });

  it('EOF in the same chunk as a request: the process ends without hanging, leaves only whole frames, and a new process succeeds', async (t) => {
    const fixture = await makeFixture(t);
    const args = { name: 'load', repo: fixture.repo.dir };
    const first = fixture.start();
    const ids = [first.takeId(), first.takeId()];
    first.sendTogether([
      { id: ids[0], method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { method: 'notifications/initialized' },
      { id: ids[1], method: 'tools/call', params: { name: 'code_find', arguments: args } },
    ]);
    // A server may answer none, some or all of these before it sees the end of input; it must not hang or tear a frame.
    const exit = await first.shutdown();
    assert.equal(exit.exitCode, 0, stderrOf(exit));
    for (const line of first.lines) assert.doesNotThrow(() => JSON.parse(line), `a whole frame: ${line}`);

    const second = fixture.start();
    await second.handshake();
    const retry = await second.callTool('code_find', args);
    assert.equal(retry.envelope.ok, true);
    assert.equal(findRows(retry.envelope)[0]?.name, 'load');
    await second.shutdown();
  });
});
