import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../cli/index.ts';
import { allowAll, commandHash, createRealRunner } from '../command-runner/index.ts';
import type { CommandRunner, CommandSpec, UserPermissions } from '../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../facts/index.ts';
import { loadUserConfig, needsApprovalFrom } from '../host/index.ts';
import { resolveWorkerPath } from '../precise-resolver/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import { KNOWN_ADAPTERS, composeHost, makeRunner, parseMcpFlags } from './compose.ts';

const toyModule = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');
const setupRunner = createRealRunner({ decide: allowAll });

interface Sink {
  readonly written: string[];
  write(text: string): boolean;
}

const sink = (): Sink => {
  const written: string[] = [];
  return {
    written,
    write: (text) => {
      written.push(text);
      return true;
    },
  };
};

describe('composeHost', () => {
  it('returns a working client for a working directory and a user directory, and dispose closes everything', async (t) => {
    const tmp = makeTempDir();
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: { 'b.toy': 'fn helper {\n}\n' } } });
    t.after(() => {
      tmp.cleanup();
      repo.cleanup();
    });
    const userDir = path.join(tmp.path, 'user');
    fs.cpSync(toyModule, path.join(userDir, 'languages', 'toy'), { recursive: true });
    const stderr = sink();
    const composed = composeHost({
      cwd: repo.dir,
      env: { ...process.env, ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir },
      home: path.join(tmp.path, 'home'),
      stderr,
    });
    t.after(async () => {
      await composed.dispose();
    });

    const listed = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    assert.equal(listed.ok, true, JSON.stringify(listed.diagnostics));
    const modules = (listed.data as { modules: Array<{ name: string; source: string }> }).modules;
    assert.ok(
      modules.some((entry) => entry.name === 'toy' && entry.source === 'user'),
      'GSD_ATLAS_USER_DIR selects the user directory',
    );

    const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: repo.dir } });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    const found = await composed.client.handle({
      protocol: PROTOCOL_VERSION,
      kind: 'code_find',
      args: { name: 'helper', repo: repo.dir },
    });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as { results: unknown[] }).results.length, 1);

    await composed.dispose();
    await composed.dispose();
    const after = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name: 'helper', repo: repo.dir } });
    assert.equal(after.diagnostics[0]?.code, 'host_closed');
    assert.deepEqual(stderr.written, [], 'a valid setup prints nothing');
  });

  it('reads the user config and reports a rejected file once on stderr', async (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const userDir = path.join(tmp.path, 'user');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'config.json'), '{ not json');
    const stderr = sink();
    const composed = composeHost({
      cwd: tmp.path,
      env: { ...process.env, GSD_ATLAS_USER_DIR: userDir },
      home: path.join(tmp.path, 'home'),
      stderr,
    });
    t.after(async () => {
      await composed.dispose();
    });
    assert.equal(stderr.written.length, 1);
    assert.match(stderr.written[0] ?? '', /^gsd-atlas: warning user_config_ignored: /);
  });

  it('without GSD_ATLAS_USER_DIR the user directory is the config folder under the home directory', async (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const home = path.join(tmp.path, 'home');
    fs.cpSync(toyModule, path.join(home, '.config', 'gsd-atlas', 'languages', 'toy'), { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['GSD_ATLAS_USER_DIR'];
    const composed = composeHost({ cwd: tmp.path, env, home, stderr: sink() });
    t.after(async () => {
      await composed.dispose();
    });
    const listed = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    const modules = (listed.data as { modules: Array<{ name: string; source: string }> }).modules;
    assert.ok(modules.some((entry) => entry.name === 'toy' && entry.source === 'user'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// D-15, SEC-02: who started the Host decides whether the user's approvals can run anything
// ---------------------------------------------------------------------------------------------------------------------

/** One exact command, printing `ok` and nothing else; the `-e` text is the whole program. */
const spec = (repo: string): CommandSpec => ({ executable: process.execPath, args: ['-e', "process.stdout.write('ok')"], cwd: repo });
const run = (runner: CommandRunner, repo: string): ReturnType<CommandRunner['run']> => runner.run(spec(repo), { repo });

/** Write `<userDir>/config.json` the way `gsd-atlas allow` writes it: one repository, one executable, the exact-command hash. */
function approve(userDir: string, repo: string, command: Pick<CommandSpec, 'executable' | 'args'>): string {
  const sha256 = commandHash({ ...command, cwd: '.' }, repo) as string;
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'config.json'), JSON.stringify({ permissions: { allow: [{ repo, executable: command.executable, sha256 }] } }));
  return sha256;
}

describe('makeRunner: the origin decides whether the user permission list applies', () => {
  function world(t: { after(fn: () => void): void }): { repo: string; permissions: UserPermissions } {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const repo = realPath(tmp.path);
    const userDir = path.join(tmp.path, 'user');
    approve(userDir, repo, spec(repo));
    const permissions = loadUserConfig(userDir, {}).config.permissions;
    assert.ok(permissions !== undefined);
    return { repo, permissions };
  }

  it('cli origin applies permissions: the approved command runs, a changed one does not', async (t) => {
    const { repo, permissions } = world(t);
    for (const options of [{ origin: 'cli' as const }, {}]) {
      const runner = makeRunner({ env: process.env, permissions, ...options });
      const result = await run(runner, repo);
      assert.equal(result.denied, undefined, JSON.stringify(result.denied));
      assert.equal(Buffer.from(result.stdout).toString('utf8'), 'ok');
      const changed = await runner.run({ ...spec(repo), args: ['-e', "process.stdout.write('changed')"] }, { repo });
      assert.equal(changed.denied?.code, 'command_denied');
    }
  });

  it('mcp origin without allow-build: the same approved command is denied, and the denial maps to needs_approval', async (t) => {
    const { repo, permissions } = world(t);
    for (const options of [{ origin: 'mcp' as const }, { origin: 'mcp' as const, allowBuild: false }]) {
      const result = await run(makeRunner({ env: process.env, permissions, ...options }), repo);
      assert.equal(result.denied?.code, 'command_denied');
      assert.equal(result.stdout.length, 0, 'nothing was started');
      const mapped = needsApprovalFrom(result);
      assert.equal(mapped?.degraded, 'needs_approval');
      assert.match(mapped?.diagnostic.message ?? '', /gsd-atlas allow/);
      assert.match(mapped?.diagnostic.message ?? '', /--allow-build/);
    }
  });

  it('mcp origin with allow-build: the user list applies, exactly as for the cli', async (t) => {
    const { repo, permissions } = world(t);
    const runner = makeRunner({ env: process.env, permissions, origin: 'mcp', allowBuild: true });
    const result = await run(runner, repo);
    assert.equal(result.denied, undefined, JSON.stringify(result.denied));
    assert.equal(Buffer.from(result.stdout).toString('utf8'), 'ok');
    const changed = await runner.run({ ...spec(repo), args: ['-e', ''] }, { repo });
    assert.equal(changed.denied?.code, 'command_denied');
  });

  it('git, the first-party built-in, is not affected by the origin', async (t) => {
    const { repo, permissions } = world(t);
    for (const origin of ['cli', 'mcp'] as const) {
      const runner = makeRunner({ env: process.env, permissions, origin });
      const version = await runner.run({ executable: 'git', args: ['--version'] }, { repo });
      assert.equal(version.denied, undefined, origin);
      assert.equal(version.ok, true, origin);
    }
  });
});

describe('composeHost: origin and the user configuration', () => {
  interface Setup {
    readonly repo: Awaited<ReturnType<typeof createTempGitRepo>>;
    readonly userDir: string;
    readonly home: string;
    readonly env: Record<string, string | undefined>;
  }

  async function setup(t: { after(fn: () => void): void }, files: Readonly<Record<string, string>>): Promise<Setup> {
    const tmp = makeTempDir();
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: files } });
    t.after(() => {
      tmp.cleanup();
      repo.cleanup();
    });
    const userDir = path.join(tmp.path, 'user');
    return { repo, userDir, home: path.join(tmp.path, 'home'), env: { ...process.env, ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir } };
  }

  const compose = (s: Setup, t: { after(fn: () => void | Promise<void>): void }, extra: Partial<Parameters<typeof composeHost>[0]> = {}): ReturnType<typeof composeHost> => {
    const composed = composeHost({ cwd: s.repo.dir, env: s.env, home: s.home, stderr: sink(), ...extra });
    t.after(async () => {
      await composed.dispose();
    });
    return composed;
  };

  it('new composition sees new entry: one composition reads the user configuration once, a second composition reads it again', async (t) => {
    const s = await setup(t, { 'a.toy': 'fn a {\n}\n' });
    const first = compose(s, t, { origin: 'cli' });
    assert.ok(first.runner !== undefined);
    assert.equal((await run(first.runner, s.repo.dir)).denied?.code, 'command_denied');
    approve(s.userDir, s.repo.dir, spec(s.repo.dir));
    // The running composition captured the permissions at its start: this is why a running MCP server must be restarted.
    assert.equal((await run(first.runner, s.repo.dir)).denied?.code, 'command_denied', 'the first composition still denies');
    const second = compose(s, t, { origin: 'cli' });
    assert.ok(second.runner !== undefined);
    const result = await run(second.runner, s.repo.dir);
    assert.equal(result.denied, undefined, JSON.stringify(result.denied));
    assert.equal(Buffer.from(result.stdout).toString('utf8'), 'ok');
  });

  it('the composed runner follows the origin: mcp denies and mcp with allow-build runs the same approved command', async (t) => {
    const s = await setup(t, { 'a.toy': 'fn a {\n}\n' });
    approve(s.userDir, s.repo.dir, spec(s.repo.dir));
    const outcomes = new Map<string, string | undefined>();
    for (const [label, extra] of [
      ['cli', { origin: 'cli' as const }],
      ['mcp', { origin: 'mcp' as const }],
      ['mcp+build', { origin: 'mcp' as const, allowBuild: true }],
    ] as const) {
      const composed = compose(s, t, extra);
      assert.ok(composed.runner !== undefined);
      outcomes.set(label, (await run(composed.runner, s.repo.dir)).denied?.code);
    }
    assert.deepEqual([...outcomes], [['cli', undefined], ['mcp', 'command_denied'], ['mcp+build', undefined]]);
  });

  it('lang_list: the MCP server without allow-build still reports the approved command as needing approval, the CLI reports it approved', async (t) => {
    const command = [process.execPath, 'evil.js'];
    const manifest = JSON.stringify({
      schemaVersion: 1,
      name: 'evil',
      extensions: ['.evil'],
      grammar: { wasm: 'grammar.wasm', lock: 'grammar.lock' },
      queries: { tags: 'queries/tags.scm' },
      tiers: ['grammar', 'precise'],
      precise: { command },
    });
    const s = await setup(t, { 'a.toy': 'fn a {\n}\n', '.gsd-atlas/languages/evil/atlas-lang.json': manifest });
    const reasonFor = async (extra: Partial<Parameters<typeof composeHost>[0]>): Promise<string | undefined> => {
      const composed = compose(s, t, extra);
      const reply = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list', args: { repo: s.repo.dir } });
      assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
      const modules = (reply.data as { modules: Array<{ name: string; tiers: Array<{ tier: string; active: boolean; reason?: string }> }> }).modules;
      assert.ok(!JSON.stringify(reply).includes('evil.js'), 'the manifest command never reaches the answer');
      return modules.find((m) => m.name === 'evil')?.tiers.find((tier) => tier.tier === 'precise')?.reason;
    };
    // Nothing approved yet: needs approval everywhere.
    assert.equal(await reasonFor({ origin: 'cli' }), 'command_not_approved');
    approve(s.userDir, s.repo.dir, { executable: process.execPath, args: ['evil.js'] });
    assert.equal(await reasonFor({ origin: 'cli' }), 'command_approved');
    assert.equal(await reasonFor({ origin: 'mcp' }), 'command_not_approved');
    assert.equal(await reasonFor({ origin: 'mcp', allowBuild: true }), 'command_approved');
    // A changed manifest command is not the approved one, whoever asks.
    fs.writeFileSync(path.join(s.repo.dir, '.gsd-atlas/languages/evil/atlas-lang.json'), manifest.replace('evil.js', 'worse.js'));
    assert.equal(await reasonFor({ origin: 'cli' }), 'command_not_approved');
  });

  it('allow end to end: a person answering yes records an approval that only a later composition runs', async (t) => {
    const s = await setup(t, { 'a.toy': 'fn a {\n}\n', 'tools/x.js': "process.stdout.write('x');\n" });
    const running = compose(s, t, { origin: 'cli' });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = (isTTY: boolean, answer: string): Parameters<typeof runCli>[1] => ({
      client: running.client,
      version: () => '0.0.0',
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
      cwd: s.repo.dir,
      isTTY,
      prompt: () => Promise.resolve(answer),
    });
    const argv = ['allow', '--', process.execPath, 'tools/x.js'];

    // No terminal: nothing is written, not even the user directory.
    assert.equal(await runCli(argv, io(false, 'y')), 2);
    assert.equal(fs.existsSync(path.join(s.userDir, 'config.json')), false);
    // A terminal and a no: nothing is written either.
    assert.equal(await runCli(argv, io(true, 'n')), 1);
    assert.equal(fs.existsSync(path.join(s.userDir, 'config.json')), false);
    // A terminal and a yes.
    assert.equal(await runCli(argv, io(true, 'y')), 0, stderr.join(''));
    assert.equal(loadUserConfig(s.userDir, {}).config.permissions?.allow.length, 1);

    const xSpec: CommandSpec = { executable: process.execPath, args: ['tools/x.js'], cwd: s.repo.dir };
    assert.ok(running.runner !== undefined);
    assert.equal((await running.runner.run(xSpec, { repo: s.repo.dir })).denied?.code, 'command_denied', 'the running composition does not see it');
    const later = compose(s, t, { origin: 'cli' });
    assert.ok(later.runner !== undefined);
    const result = await later.runner.run(xSpec, { repo: s.repo.dir });
    assert.equal(result.denied, undefined, JSON.stringify(result.denied));
    assert.equal(Buffer.from(result.stdout).toString('utf8'), 'x');
    assert.match(stderr.join(''), /running MCP server must be restarted/);
  });

  it('an MCP-origin composition refuses allow even through the client', async (t) => {
    const s = await setup(t, { 'a.toy': 'fn a {\n}\n' });
    const server = compose(s, t, { origin: 'mcp', allowBuild: true });
    const reply = await server.client.handle({ protocol: PROTOCOL_VERSION, kind: 'allow', args: { repo: s.repo.dir, argv: [process.execPath] } });
    assert.equal(reply.diagnostics[0]?.code, 'allow_forbidden');
    assert.equal(fs.existsSync(path.join(s.userDir, 'config.json')), false);
  });
});

describe('parseMcpFlags: the arguments of gsd-atlas-mcp', () => {
  it('no arguments leave allow-build off; --allow-build turns it on', () => {
    assert.deepEqual(parseMcpFlags([]), { ok: true, allowBuild: false, help: false });
    assert.deepEqual(parseMcpFlags(['--allow-build']), { ok: true, allowBuild: true, help: false });
    assert.deepEqual(parseMcpFlags(['--allow-build', '--allow-build']), { ok: true, allowBuild: true, help: false });
  });

  it('an unknown flag, a value, a stray word or a lookalike is refused with the usage line', () => {
    for (const argv of [['--bogus'], ['-x'], ['allow-build'], ['--allow-build=1'], ['--allowbuild'], ['--allow-build', 'extra'], ['--ALLOW-BUILD'], ['--']]) {
      const parsed = parseMcpFlags(argv);
      assert.equal(parsed.ok, false, argv.join(' '));
      if (parsed.ok) continue;
      assert.match(parsed.message, /Usage: gsd-atlas-mcp \[--allow-build\]/, argv.join(' '));
      assert.equal(parsed.exitCode, 1);
    }
  });

  it('--help prints the usage and is not an error', () => {
    for (const flag of ['--help', '-h']) {
      const parsed = parseMcpFlags([flag]);
      assert.deepEqual({ ok: parsed.ok, help: parsed.ok && parsed.help }, { ok: true, help: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan 03-23: the real composition starts the compiler worker only as the exact built-in shape, and knows the typescript tier.
// ---------------------------------------------------------------------------------------------------------------------

describe('composeHost: the built-in TypeScript tier (SEC-02)', () => {
  const worker = resolveWorkerPath();
  const workerSpec = (extra: Partial<CommandSpec> = {}): CommandSpec => ({
    executable: process.execPath,
    args: ['--max-old-space-size=256', worker],
    builtinId: 'typescript-resolver',
    env: { GSD_ATLAS_WORKER: '1' },
    ...extra,
  });

  it('makeRunner accepts the exact worker shape and refuses a changed one', async () => {
    const runner = makeRunner({ env: process.env });
    // No stdin: the worker ends at once, as it does when its host dies. It was allowed to start; that is the point.
    const started = await runner.run(workerSpec({ stdin: '' }));
    assert.equal(started.denied, undefined, JSON.stringify(started.diagnostics));
    for (const changed of [
      workerSpec({ args: ['--max-old-space-size=256', worker, 'extra'] }),
      workerSpec({ args: ['--inspect', worker] }),
      workerSpec({ env: { GSD_ATLAS_WORKER: '1', NODE_OPTIONS: '--require ./x.js' } }),
      workerSpec({ executable: 'node' }),
    ]) {
      const refused = await runner.run(changed);
      assert.equal(refused.denied?.code, 'command_denied', JSON.stringify(changed.args));
    }
  });

  it('the composed Host knows the typescript adapter: lang_list shows the TypeScript module precise tier active', async (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const composed = composeHost({ cwd: tmp.path, env: { ...process.env, GSD_ATLAS_USER_DIR: path.join(tmp.path, 'user') }, home: path.join(tmp.path, 'home'), stderr: sink() });
    t.after(async () => {
      await composed.dispose();
    });
    assert.deepEqual(KNOWN_ADAPTERS, ['typescript']);
    const listed = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    const modules = (listed.data as { modules: Array<{ name: string; tiers: Array<{ tier: string; active: boolean; reason?: string }> }> }).modules;
    const typescript = modules.find((entry) => entry.name === 'typescript');
    assert.deepEqual(typescript?.tiers.find((tier) => tier.tier === 'precise'), { tier: 'precise', active: true });
  });

  it('the user can turn the provider off: lang_list then says provider_disabled', async (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const userDir = path.join(tmp.path, 'user');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'config.json'), JSON.stringify({ providers: { disabled: ['typescript'] } }));
    const composed = composeHost({ cwd: tmp.path, env: { ...process.env, GSD_ATLAS_USER_DIR: userDir }, home: path.join(tmp.path, 'home'), stderr: sink() });
    t.after(async () => {
      await composed.dispose();
    });
    const listed = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    const modules = (listed.data as { modules: Array<{ name: string; tiers: Array<{ tier: string; active: boolean; reason?: string }> }> }).modules;
    assert.deepEqual(modules.find((entry) => entry.name === 'typescript')?.tiers.find((tier) => tier.tier === 'precise'), {
      tier: 'precise',
      active: false,
      reason: 'provider_disabled',
    });
  });
});
