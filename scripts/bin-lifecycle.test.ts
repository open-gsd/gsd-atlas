/**
 * The bins as real processes under signals and under lazy composition (plan 02-36, IN-07 and IN-09).
 *
 * - `gsd-atlas-mcp` terminated by SIGTERM leaves a clean store: exit code 143, `lease.json` gone, no `dirty` sentinel,
 *   and `PRAGMA quick_check` answering `ok`; ending stdin still exits 0.
 * - `gsd-atlas` composes the Host on the first request only: `--help`, `--version`, a usage error and `init` never
 *   read the user configuration (an invalid `config.json` prints no warning), while a repository command does.
 * - `gsd-atlas` terminated by SIGTERM in the middle of a command exits 143 and leaves no `dirty` sentinel.
 *
 * The bins are spawned with `node:child_process` because the CommandRunner can only SIGKILL. Windows delivers only
 * SIGINT to a Node process, so the real-signal cases are skipped there.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import { pollUntil, within } from './test-helpers/child-lines.ts';

const CLI_BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas.ts');
const MCP_BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas-mcp.ts');
const setupRunner = createRealRunner({ decide: allowAll });

const SIGNAL_SKIP = process.platform === 'win32' ? 'Windows delivers only SIGINT to a Node process; POSIX signals are not testable there' : false;
const CEILING_MS = 90_000;

interface World {
  readonly repo: string;
  readonly userDir: string;
  readonly storeRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly outside: string;
}

interface Exited {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Reply {
  readonly id?: number;
  readonly result?: { readonly content?: ReadonlyArray<{ readonly text: string }> };
}

/** A spawned bin with its output collected and a promise for how it ended. */
class Bin {
  readonly child: ChildProcess;
  readonly exited: Promise<Exited>;
  private stdout = '';
  private stderr = '';
  private readonly waiters: Array<() => void> = [];

  constructor(bin: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>) {
    this.child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.stdout += chunk;
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        resolve({ code, signal, stdout: this.stdout, stderr: this.stderr });
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  /** The reply carrying `id`. */
  async reply(id: number): Promise<Reply> {
    const find = (): Reply | undefined => {
      for (const line of this.stdout.split('\n')) {
        if (line === '') continue;
        const message = JSON.parse(line) as Reply;
        if (message.id === id) return message;
      }
      return undefined;
    };
    return within(CEILING_MS, `the reply with id ${String(id)}`, (async () => {
      for (;;) {
        const found = find();
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    })());
  }

  end(): void {
    this.child.stdin?.end();
  }

  signal(name: NodeJS.Signals): void {
    this.child.kill(name);
  }

  async finish(): Promise<Exited> {
    return within(CEILING_MS, 'the process to exit', this.exited);
  }
}

/** Every file named `name` under `dir`. */
function filesNamed(dir: string, name: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function setup(t: TestContext, files: Readonly<Record<string, string>>): Promise<World> {
  const tmp = makeTempDir();
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: files } });
  t.after(() => {
    tmp.cleanup();
    repo.cleanup();
  });
  const userDir = path.join(tmp.path, 'user');
  const storeRoot = path.join(tmp.path, 'stores');
  const outside = path.join(tmp.path, 'outside');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(outside);
  const env = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir, GSD_ATLAS_STORE_DIR: storeRoot };
  return { repo: repo.dir, userDir, storeRoot, env, outside };
}

const SMALL: Readonly<Record<string, string>> = {
  'a.ts': 'export function load(): number {\n  return 1;\n}\n',
  'b.ts': "import { load } from './a';\nexport function run(): number {\n  return load();\n}\n",
};

/** Build the index with the real CLI, so the MCP server finds one. */
async function buildIndex(world: World): Promise<void> {
  const bin = new Bin(CLI_BIN, ['build', '--repo', world.repo], world.outside, world.env);
  bin.end();
  const done = await bin.finish();
  assert.equal(done.code, 0, `build failed: ${done.stderr}`);
}

/** Handshake and one code_find, so the Host has opened the tenant and taken the writer lease. */
async function warmUp(server: Bin, world: World): Promise<void> {
  server.send({
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bin-lifecycle', version: '0.0.0' } },
  });
  await server.reply(1);
  server.send({ method: 'notifications/initialized', params: {} });
  server.send({ id: 2, method: 'tools/call', params: { name: 'code_find', arguments: { name: 'load', repo: world.repo } } });
  const reply = await server.reply(2);
  const text = reply.result?.content?.[0]?.text ?? '';
  const envelope = JSON.parse(text) as { ok: boolean; data: { results: unknown[] } };
  assert.equal(envelope.ok, true, text);
  assert.ok(envelope.data.results.length > 0, 'the index answers');
}

function assertCleanStore(storeRoot: string): void {
  assert.deepEqual(filesNamed(storeRoot, 'lease.json'), [], 'the writer lease is released (lease.json removed)');
  assert.deepEqual(filesNamed(storeRoot, 'dirty'), [], 'no dirty sentinel is left');
  const databases = filesNamed(storeRoot, 'facts.db');
  assert.equal(databases.length, 1, `one fact store, got ${JSON.stringify(databases)}`);
  const db = new DatabaseSync(databases[0] as string, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    assert.equal(row.quick_check, 'ok');
  } finally {
    db.close();
  }
}

describe('gsd-atlas-mcp under signals', () => {
  it('SIGTERM releases the lease', { skip: SIGNAL_SKIP }, async (t) => {
    const world = await setup(t, SMALL);
    await buildIndex(world);
    const server = new Bin(MCP_BIN, [], world.outside, world.env);
    t.after(() => {
      server.signal('SIGKILL');
    });
    await warmUp(server, world);
    await pollUntil(30_000, 'the writer lease to be taken', () => filesNamed(world.storeRoot, 'lease.json').length > 0);

    server.signal('SIGTERM');
    const done = await server.finish();
    assert.equal(done.signal, null, `the server handled the signal instead of dying by it: ${done.stderr}`);
    assert.equal(done.code, 143, done.stderr);
    assertCleanStore(world.storeRoot);
  });

  it('SIGINT also exits cleanly with 130', { skip: SIGNAL_SKIP }, async (t) => {
    const world = await setup(t, SMALL);
    await buildIndex(world);
    const server = new Bin(MCP_BIN, [], world.outside, world.env);
    t.after(() => {
      server.signal('SIGKILL');
    });
    await warmUp(server, world);
    server.signal('SIGINT');
    const done = await server.finish();
    assert.equal(done.code, 130, done.stderr);
    assertCleanStore(world.storeRoot);
  });

  it('control: ending stdin still exits 0 with a clean store', async (t) => {
    const world = await setup(t, SMALL);
    await buildIndex(world);
    const server = new Bin(MCP_BIN, [], world.outside, world.env);
    t.after(() => {
      server.signal('SIGKILL');
    });
    await warmUp(server, world);
    server.end();
    const done = await server.finish();
    assert.equal(done.code, 0, done.stderr);
    assertCleanStore(world.storeRoot);
  });
});

describe('gsd-atlas composes the Host lazily', () => {
  /** A user directory whose config.json is invalid: composing prints a `gsd-atlas: warning` line, so it shows. */
  function brokenConfig(world: World): void {
    fs.mkdirSync(world.userDir, { recursive: true });
    fs.writeFileSync(path.join(world.userDir, 'config.json'), '{ this is not json');
  }

  it('help does not compose: --help, --version, a usage error and init print no configuration warning', async (t) => {
    const world = await setup(t, SMALL);
    brokenConfig(world);
    const home = path.join(path.dirname(world.userDir), 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = { ...world.env, HOME: home, USERPROFILE: home };
    const cases: ReadonlyArray<{ args: string[]; code: number }> = [
      { args: ['--help'], code: 0 },
      { args: ['--version'], code: 0 },
      { args: ['--no-such-flag'], code: 1 },
      { args: ['find'], code: 1 },
      { args: ['init', '--dry-run', '--agent', 'claude'], code: 0 },
    ];
    for (const each of cases) {
      const bin = new Bin(CLI_BIN, each.args, world.repo, env);
      bin.end();
      const done = await bin.finish();
      assert.equal(done.code, each.code, `${each.args.join(' ')}: ${done.stderr}`);
      assert.doesNotMatch(done.stderr, /gsd-atlas: warning/, `${each.args.join(' ')} must not read the user configuration`);
    }
  });

  it('a repository command composes the Host: the configuration warning appears and a non-repository answers not_a_repo', async (t) => {
    const world = await setup(t, SMALL);
    brokenConfig(world);
    const bin = new Bin(CLI_BIN, ['find', 'x'], world.outside, world.env);
    bin.end();
    const done = await bin.finish();
    assert.equal(done.code, 2, done.stderr);
    assert.match(done.stderr, /gsd-atlas: warning/, 'the Host was composed, which read the invalid configuration');
    const envelope = JSON.parse(done.stdout) as { ok: boolean; diagnostics: Array<{ code: string }> };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'not_a_repo');
  });
});

describe('gsd-atlas under signals', () => {
  /** Enough files that a build is still running when the signal arrives. */
  function manyFiles(count: number): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < count; i += 1) {
      files[`src/m${String(i)}.ts`] = `export function f${String(i)}(): number {\n  return ${String(i)};\n}\n`;
    }
    return files;
  }

  it('SIGTERM to the CLI exits 143 after disposing, with no dirty sentinel left', { skip: SIGNAL_SKIP }, async (t) => {
    const world = await setup(t, manyFiles(600));
    const bin = new Bin(CLI_BIN, ['build', '--repo', world.repo], world.outside, world.env);
    t.after(() => {
      bin.signal('SIGKILL');
    });
    bin.end();
    await pollUntil(60_000, 'the build to take the writer lease', () => filesNamed(world.storeRoot, 'lease.json').length > 0);
    bin.signal('SIGTERM');
    const done = await bin.finish();
    assert.equal(done.signal, null, `the CLI handled the signal instead of dying by it: ${done.stderr}`);
    assert.equal(done.code, 143, `the build must still be running when the signal arrives: ${done.stderr}`);
    assert.deepEqual(filesNamed(world.storeRoot, 'lease.json'), [], 'the writer lease is released');
    assert.deepEqual(filesNamed(world.storeRoot, 'dirty'), [], 'no dirty sentinel is left');
  });
});
