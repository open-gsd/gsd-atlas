/**
 * The Host's `allow` request (D-15, SEC-02): a dry run that previews one exact command and its hash, and a second call
 * that carries the hash as `confirm` and writes one entry to the user's config. The writer's hardening, `--workdir`,
 * `--module` and the MCP-origin refusal are covered by the later describe blocks of this file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { commandHash, createRealRunner } from '../command-runner/index.ts';
import type { CommandSpec } from '../command-runner/index.ts';
import type { Envelope } from '../facts/index.ts';
import { TOOL_NAMES } from '../host-client/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { createTenant } from '../tenant/index.ts';
import type { TenantDeps } from '../tenant/index.ts';
import { addAllowEntry, needsApprovalFrom, permissionsFor } from './allow.ts';
import type { AllowEntry, AllowFs } from './allow.ts';
import { CONFIG_FILE, CONFIG_MAX_BYTES, loadUserConfig } from './config.ts';
import { THREE_FILES, makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';

const SCRIPT = 'tools/x.js';
const FILES: Readonly<Record<string, string>> = { ...THREE_FILES, [SCRIPT]: "process.stdout.write('ok');\n" };

/** The preview an `allow` dry run carries. */
interface Preview {
  readonly repo: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sha256: string;
  readonly fromModule?: boolean;
}

const userDirOf = (world: World): string => world.options.userDir as string;
const configFileOf = (world: World): string => path.join(userDirOf(world), CONFIG_FILE);

async function world(t: TestContext): Promise<World> {
  return makeWorld(t, { files: FILES });
}

function previewOf(reply: Envelope): Preview {
  assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
  return reply.data as Preview;
}

const codeOf = (reply: Envelope): string | undefined => reply.diagnostics[0]?.code;

describe('allow: dry run writes nothing', () => {
  it('dry run writes nothing and returns the canonical preview with its hash', async (t) => {
    const w = await world(t);
    const argv = [process.execPath, SCRIPT, '--flag'];
    const reply = await w.ask('allow', { repo: w.repo.dir, argv });
    const preview = previewOf(reply);
    assert.equal(reply.schema, 'gsd-atlas.allow/1');
    assert.equal(preview.repo, w.repo.dir);
    assert.equal(preview.executable, process.execPath);
    assert.deepEqual(preview.args, [SCRIPT, '--flag']);
    assert.equal(preview.cwd, '.');
    assert.equal(preview.sha256, commandHash({ executable: process.execPath, args: [SCRIPT, '--flag'], cwd: '.' }, w.repo.dir));
    assert.equal(fs.existsSync(configFileOf(w)), false, 'a dry run creates no config file');
    assert.equal(fs.existsSync(userDirOf(w)), false, 'a dry run creates not even the user directory');
  });

  it('dry run names the main worktree when asked from a linked worktree', async (t) => {
    const w = await world(t);
    const linked = await w.addWorktree('feature');
    const preview = previewOf(await w.ask('allow', { cwd: linked, argv: [process.execPath, SCRIPT] }));
    assert.equal(preview.repo, w.repo.dir);
  });

  it('refuses a directory that is not a repository with a fixed sentence', async (t) => {
    const w = await world(t);
    const reply = await w.ask('allow', { repo: w.tmp.path, argv: [process.execPath, SCRIPT] });
    assert.equal(reply.ok, false);
    assert.equal(codeOf(reply), 'not_a_repo');
  });

  it('refuses arguments that name no command or a malformed one', async (t) => {
    const w = await world(t);
    const bad: ReadonlyArray<readonly [string, unknown]> = [
      ['no argv', {}],
      ['empty argv', { argv: [] }],
      ['empty executable', { argv: [''] }],
      ['NUL in an argument', { argv: [process.execPath, 'a\0b'] }],
      ['argv that is not strings', { argv: [process.execPath, 3] }],
      ['an unknown key', { argv: [process.execPath], shell: true }],
    ];
    for (const [what, args] of bad) {
      const reply = await w.ask('allow', { repo: w.repo.dir, ...(args as object) });
      assert.equal(reply.ok, false, what);
      assert.equal(codeOf(reply), 'invalid_args', what);
    }
    assert.equal(fs.existsSync(configFileOf(w)), false);
  });
});

describe('allow: confirm', () => {
  it('writes one entry when confirm equals the previewed hash, and creates the file', async (t) => {
    const w = await world(t);
    const argv = [process.execPath, SCRIPT, '--flag'];
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, argv }));
    const reply = await w.ask('allow', { repo: w.repo.dir, argv, confirm: preview.sha256 });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.deepEqual(reply.data, { written: true, sha256: preview.sha256, executable: process.execPath, args: [SCRIPT, '--flag'] });
    const written: unknown = JSON.parse(fs.readFileSync(configFileOf(w), 'utf8'));
    assert.deepEqual(written, { permissions: { allow: [{ repo: w.repo.dir, executable: process.execPath, sha256: preview.sha256 }] } });
    const loaded = loadUserConfig(userDirOf(w), {});
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.config.permissions?.allow, [{ repo: w.repo.dir, executable: process.execPath, sha256: preview.sha256 }]);
  });

  it('confirm mismatch writes nothing', async (t) => {
    const w = await world(t);
    const argv = [process.execPath, SCRIPT, '--flag'];
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, argv }));
    const wrong = await w.ask('allow', { repo: w.repo.dir, argv, confirm: 'f'.repeat(64) });
    assert.equal(wrong.ok, false);
    assert.equal(codeOf(wrong), 'confirm_mismatch');
    // The old hash with changed arguments is the substitution the binding exists to stop.
    const changed = await w.ask('allow', { repo: w.repo.dir, argv: [process.execPath, SCRIPT, '--other'], confirm: preview.sha256 });
    assert.equal(changed.ok, false);
    assert.equal(codeOf(changed), 'confirm_mismatch');
    const notHex = await w.ask('allow', { repo: w.repo.dir, argv, confirm: 'yes' });
    assert.equal(codeOf(notHex), 'confirm_mismatch');
    assert.equal(fs.existsSync(configFileOf(w)), false, 'no config file after any mismatch');
  });
});

describe('allow: the runner honours exactly what was approved', () => {
  async function approved(t: TestContext): Promise<{ w: World; run: (args: readonly string[]) => ReturnType<ReturnType<typeof createRealRunner>['run']> }> {
    const w = await world(t);
    const argv = [process.execPath, SCRIPT, '--flag'];
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, argv }));
    const reply = await w.ask('allow', { repo: w.repo.dir, argv, confirm: preview.sha256 });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const loaded = loadUserConfig(userDirOf(w), {});
    assert.ok(loaded.config.permissions !== undefined);
    const runner = createRealRunner({ user: loaded.config.permissions });
    return {
      w,
      run: (args) => {
        const spec: CommandSpec = { executable: process.execPath, args, cwd: w.repo.dir };
        return runner.run(spec, { repo: w.repo.dir });
      },
    };
  }

  it('runner allows exactly the approved command', async (t) => {
    const { run } = await approved(t);
    const result = await run([SCRIPT, '--flag']);
    assert.equal(result.denied, undefined, JSON.stringify(result.denied));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(Buffer.from(result.stdout).toString('utf8'), 'ok');
  });

  it('runner denies changed args', async (t) => {
    const { run } = await approved(t);
    for (const args of [[SCRIPT, '--other'], [SCRIPT], [SCRIPT, '--flag', 'extra'], ['other.js', '--flag']]) {
      const result = await run(args);
      assert.equal(result.ok, false, args.join(' '));
      assert.equal(result.denied?.code, 'command_denied', args.join(' '));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 2: the safe user-config writer, --workdir and --module
// ---------------------------------------------------------------------------------------------------------------------

const ENTRY: AllowEntry = { repo: path.resolve('/the/repo'), executable: 'node', sha256: 'a'.repeat(64) };
const OTHER: AllowEntry = { repo: path.resolve('/the/repo'), executable: 'node', sha256: 'b'.repeat(64) };
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX file modes and symlinks' : false };

/** Run `body` with a fresh user directory that is removed afterwards. */
function inUserDir(body: (userDir: string) => void): void {
  const tmp = makeTempDir();
  try {
    body(path.join(tmp.path, 'user'));
  } finally {
    tmp.cleanup();
  }
}

const text = (json: unknown): string => `${JSON.stringify(json, null, 2)}\n`;
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Write a valid configuration file whose size is within about 100 bytes under the cap, so one more entry cannot fit. */
function fillConfig(file: string): string {
  const allow: Array<{ repo: string; executable: string }> = [];
  let content = text({ permissions: { allow } });
  const add = (executable: string): void => {
    allow.push({ repo: path.resolve('/r'), executable });
    content = text({ permissions: { allow } });
  };
  while (Buffer.byteLength(content) < CONFIG_MAX_BYTES - 700) add(`tool-${String(allow.length)}-${'x'.repeat(500)}`);
  while (Buffer.byteLength(content) < CONFIG_MAX_BYTES - 100) add(`t${String(allow.length)}`);
  assert.ok(Buffer.byteLength(content) <= CONFIG_MAX_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return content;
}

describe('addAllowEntry', () => {
  it('creates with mode 0600 the file and its directory when both are absent, holding only permissions.allow', posixOnly, () => {
    inUserDir((userDir) => {
      const result = addAllowEntry(userDir, ENTRY);
      assert.deepEqual(result, { ok: true, status: 'added' });
      const file = path.join(userDir, CONFIG_FILE);
      assert.deepEqual(readJson(file), { permissions: { allow: [ENTRY] } });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(userDir), [CONFIG_FILE], 'no temporary file is left');
    });
  });

  it('preserves other keys: every valid key survives and the entry is appended after the earlier ones', () => {
    inUserDir((userDir) => {
      fs.mkdirSync(userDir, { recursive: true });
      const before = {
        store: { dir: path.resolve('/somewhere/stores') },
        indexer: { debounceMs: 250, maxWaitMs: 4000 },
        gc: { graceMs: 5000 },
        permissions: { allow: [{ repo: path.resolve('/old/repo'), executable: 'git', argsPrefix: ['status'] }] },
      };
      fs.writeFileSync(path.join(userDir, CONFIG_FILE), text(before));
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'added' });
      const after = readJson(path.join(userDir, CONFIG_FILE));
      assert.deepEqual(after, { ...before, permissions: { allow: [...before.permissions.allow, ENTRY] } });
      // The result is still a file the loader accepts, with nothing ignored.
      const loaded = loadUserConfig(userDir, {});
      assert.deepEqual(loaded.diagnostics, []);
      assert.equal(loaded.config.permissions?.allow.length, 2);
    });
  });

  it('already allowed: the same repository and hash is a no-op that reports it and leaves the file byte for byte', () => {
    inUserDir((userDir) => {
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'added' });
      const file = path.join(userDir, CONFIG_FILE);
      const first = fs.readFileSync(file);
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'already_allowed' });
      assert.deepEqual(fs.readFileSync(file), first);
      assert.deepEqual(addAllowEntry(userDir, OTHER), { ok: true, status: 'added' });
      assert.equal((readJson(file) as { permissions: { allow: unknown[] } }).permissions.allow.length, 2);
    });
  });

  it('invalid file untouched: not JSON, an unknown key, a malformed entry, a wrong type and an oversized file are refused in one sentence', () => {
    const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['not JSON', 'SECRET-MARKER { not json', /not valid JSON/],
      ['not an object', '["SECRET-MARKER"]', /JSON object|wrong type/],
      ['an unknown top-level key', text({ 'SECRET-MARKER': true }), /unknown key/],
      ['an unknown key in an entry', text({ permissions: { allow: [{ repo: path.resolve('/r'), executable: 'x', 'SECRET-MARKER': 1 }] } }), /permissions\.allow\.0: unknown key/],
      ['a malformed hash', text({ permissions: { allow: [{ repo: path.resolve('/r'), executable: 'x', sha256: 'SECRET-MARKER' }] } }), /sha256: malformed value/],
      ['a relative repo', text({ permissions: { allow: [{ repo: 'SECRET-MARKER', executable: 'x' }] } }), /repo: must be an absolute path/],
      ['allow that is not a list', text({ permissions: { allow: 'SECRET-MARKER' } }), /permissions\.allow: wrong type/],
      ['an oversized file', ' '.repeat(CONFIG_MAX_BYTES + 10) + text({}), /larger than 64 KiB/],
    ];
    for (const [what, content, expected] of cases) {
      inUserDir((userDir) => {
        fs.mkdirSync(userDir, { recursive: true });
        const file = path.join(userDir, CONFIG_FILE);
        fs.writeFileSync(file, content);
        const result = addAllowEntry(userDir, ENTRY);
        assert.equal(result.ok, false, what);
        if (result.ok) return;
        assert.equal(result.code, 'config_invalid', what);
        assert.match(result.reason, expected, what);
        assert.ok(!result.reason.includes('SECRET-MARKER'), `${what}: the reason quotes no file content`);
        assert.ok(!result.reason.includes('\n'), `${what}: one sentence`);
        assert.equal(fs.readFileSync(file, 'utf8'), content, `${what}: the file is untouched`);
        assert.deepEqual(fs.readdirSync(userDir), [CONFIG_FILE], `${what}: no temporary file`);
      });
    }
  });

  it('rename failure leaves original: the file is unchanged and no temporary file remains', () => {
    inUserDir((userDir) => {
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'added' });
      const file = path.join(userDir, CONFIG_FILE);
      const before = fs.readFileSync(file);
      const failing: AllowFs = {
        ...fs,
        renameSync() {
          throw Object.assign(new Error('EXDEV: cross-device link not permitted, SECRET-MARKER'), { code: 'EXDEV' });
        },
      };
      const result = addAllowEntry(userDir, OTHER, failing);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, 'write_failed');
      assert.ok(!result.reason.includes('SECRET-MARKER'), 'the reason is fixed text, not the error message');
      assert.deepEqual(fs.readFileSync(file), before);
      assert.deepEqual(fs.readdirSync(userDir), [CONFIG_FILE]);
    });
  });

  it('a write that fails half way leaves the original and no temporary file', () => {
    inUserDir((userDir) => {
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'added' });
      const file = path.join(userDir, CONFIG_FILE);
      const before = fs.readFileSync(file);
      const failing: AllowFs = {
        ...fs,
        fsyncSync() {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      };
      const result = addAllowEntry(userDir, OTHER, failing);
      assert.equal(result.ok === false && result.code, 'write_failed');
      assert.deepEqual(fs.readFileSync(file), before);
      assert.deepEqual(fs.readdirSync(userDir), [CONFIG_FILE]);
    });
  });

  it('too large: a result over 64 KiB is refused with config_too_large and the file is untouched', () => {
    inUserDir((userDir) => {
      const file = path.join(userDir, CONFIG_FILE);
      const content = fillConfig(file);
      assert.equal(loadUserConfig(userDir, {}).diagnostics.length, 0, 'the fixture is a file the loader accepts');
      const result = addAllowEntry(userDir, { ...ENTRY, executable: 'y'.repeat(600) });
      assert.equal(result.ok === false && result.code, 'config_too_large');
      assert.equal(fs.readFileSync(file, 'utf8'), content);
      assert.deepEqual(fs.readdirSync(userDir), [CONFIG_FILE]);
    });
  });

  it('a file that changed while the entry was being written is not overwritten', () => {
    inUserDir((userDir) => {
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'added' });
      const file = path.join(userDir, CONFIG_FILE);
      const meanwhile = text({ gc: { graceMs: 1 } });
      const racing: AllowFs = {
        ...fs,
        closeSync(fd: number) {
          fs.closeSync(fd);
          fs.writeFileSync(file, meanwhile);
        },
      };
      const result = addAllowEntry(userDir, OTHER, racing);
      assert.equal(result.ok === false && result.code, 'config_changed');
      assert.equal(fs.readFileSync(file, 'utf8'), meanwhile, 'the other writer wins; nothing of ours replaced it');
      assert.deepEqual(fs.readdirSync(userDir), [CONFIG_FILE]);
    });
  });

  it('follows a symlinked config file and keeps the link', posixOnly, () => {
    inUserDir((userDir) => {
      fs.mkdirSync(userDir, { recursive: true });
      const dotfiles = path.join(path.dirname(userDir), 'dotfiles');
      fs.mkdirSync(dotfiles);
      const real = path.join(dotfiles, 'atlas-config.json');
      fs.writeFileSync(real, text({ gc: { graceMs: 7 } }));
      const link = path.join(userDir, CONFIG_FILE);
      fs.symlinkSync(real, link);
      assert.deepEqual(addAllowEntry(userDir, ENTRY), { ok: true, status: 'added' });
      assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
      assert.deepEqual(readJson(real), { gc: { graceMs: 7 }, permissions: { allow: [ENTRY] } });
    });
  });
});

describe('allow: the user configuration through the Host', () => {
  it('invalid file untouched: the dry run and a confirmed call say the file is invalid and was not changed, and write nothing', async (t) => {
    const w = await world(t);
    fs.mkdirSync(userDirOf(w), { recursive: true });
    const content = '{ "SECRET-MARKER": ';
    fs.writeFileSync(configFileOf(w), content);
    const argv = [process.execPath, SCRIPT];
    const reply = await w.ask('allow', { repo: w.repo.dir, argv });
    // The dry run already tells the person, so they are not asked about something that cannot be recorded.
    assert.equal(reply.ok, false);
    assert.equal(codeOf(reply), 'config_invalid');
    assert.match(reply.diagnostics[0]?.message ?? '', /^the user configuration file is invalid and was not changed: it is not valid JSON$/);
    const hash = commandHash({ executable: process.execPath, args: [SCRIPT], cwd: '.' }, w.repo.dir) as string;
    const confirmed = await w.ask('allow', { repo: w.repo.dir, argv, confirm: hash });
    assert.equal(codeOf(confirmed), 'config_invalid');
    assert.ok(!JSON.stringify(confirmed).includes('SECRET-MARKER'));
    assert.equal(fs.readFileSync(configFileOf(w), 'utf8'), content);
  });

  it('too large: a confirmed call whose result would pass 64 KiB answers config_too_large', async (t) => {
    const w = await world(t);
    const content = fillConfig(configFileOf(w));
    const argv = [process.execPath, SCRIPT];
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, argv }));
    const reply = await w.ask('allow', { repo: w.repo.dir, argv, confirm: preview.sha256 });
    assert.equal(codeOf(reply), 'config_too_large');
    assert.ok(!JSON.stringify(reply).includes(SCRIPT), 'an error reply carries no argv');
    assert.equal(fs.readFileSync(configFileOf(w), 'utf8'), content);
  });

  it('already allowed: confirming the same command twice reports it and writes once', async (t) => {
    const w = await world(t);
    const argv = [process.execPath, SCRIPT];
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, argv }));
    const first = await w.ask('allow', { repo: w.repo.dir, argv, confirm: preview.sha256 });
    assert.deepEqual(first.data, { written: true, sha256: preview.sha256, executable: process.execPath, args: [SCRIPT] });
    const second = await w.ask('allow', { repo: w.repo.dir, argv, confirm: preview.sha256 });
    assert.equal(second.ok, true);
    assert.deepEqual(second.data, { written: false, sha256: preview.sha256, executable: process.execPath, args: [SCRIPT], already_allowed: true });
    assert.equal(loadUserConfig(userDirOf(w), {}).config.permissions?.allow.length, 1);
  });
});

describe('allow: --workdir', () => {
  const WORKDIR_FILES: Readonly<Record<string, string>> = { ...FILES, 'sub/dir/keep.txt': 'kept\n', 'sub/dir/x.js': "process.stdout.write('sub');\n" };

  it('workdir is carried into the preview and the hash, and the hash differs from the root one', async (t) => {
    const w = await makeWorld(t, { files: WORKDIR_FILES });
    const argv = [process.execPath, 'x.js'];
    const inSub = previewOf(await w.ask('allow', { repo: w.repo.dir, argv, workdir: 'sub/dir' }));
    const atRoot = previewOf(await w.ask('allow', { repo: w.repo.dir, argv }));
    assert.equal(inSub.cwd, 'sub/dir');
    assert.equal(inSub.sha256, commandHash({ executable: process.execPath, args: ['x.js'], cwd: 'sub/dir' }, w.repo.dir));
    assert.notEqual(inSub.sha256, atRoot.sha256);
    // Spellings of the same directory give the same preview.
    for (const spelling of ['./sub/dir', 'sub//dir/', 'sub/./dir', 'sub/dir/../dir']) {
      const again = previewOf(await w.ask('allow', { repo: w.repo.dir, argv, workdir: spelling }));
      assert.equal(again.sha256, inSub.sha256, spelling);
      assert.equal(again.cwd, 'sub/dir', spelling);
    }
    // A confirmed call with the root hash does not approve the sub-directory one.
    const wrong = await w.ask('allow', { repo: w.repo.dir, argv, workdir: 'sub/dir', confirm: atRoot.sha256 });
    assert.equal(codeOf(wrong), 'confirm_mismatch');
  });

  it('workdir escape refused: .., an absolute path, a drive, a file, a missing directory and a link out all answer invalid_workdir', async (t) => {
    const w = await makeWorld(t, { files: WORKDIR_FILES });
    const bad = ['..', '../x', 'sub/../..', '/etc', 'C:/Windows', 'C:\\Windows', 'README.md', 'no/such/dir', 'sub\0dir'];
    if (process.platform !== 'win32') {
      fs.symlinkSync(w.tmp.path, path.join(w.repo.dir, 'out'));
      bad.push('out');
    }
    for (const workdir of bad) {
      const reply = await w.ask('allow', { repo: w.repo.dir, argv: [process.execPath, 'x.js'], workdir });
      assert.equal(reply.ok, false, JSON.stringify(workdir));
      assert.equal(codeOf(reply), 'invalid_workdir', JSON.stringify(workdir));
      assert.ok(!JSON.stringify(reply).includes('Windows'), 'the message does not echo the value');
    }
    assert.equal(fs.existsSync(configFileOf(w)), false);
  });

  it('the runner honours the approved working directory and denies the repository root', async (t) => {
    const w = await makeWorld(t, { files: WORKDIR_FILES });
    const argv = [process.execPath, 'x.js'];
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, argv, workdir: 'sub/dir' }));
    const done = await w.ask('allow', { repo: w.repo.dir, argv, workdir: 'sub/dir', confirm: preview.sha256 });
    assert.equal(done.ok, true, JSON.stringify(done.diagnostics));
    const loaded = loadUserConfig(userDirOf(w), {});
    assert.ok(loaded.config.permissions !== undefined);
    const runner = createRealRunner({ user: loaded.config.permissions });
    const inSub = await runner.run({ executable: process.execPath, args: ['x.js'], cwd: path.join(w.repo.dir, 'sub', 'dir') }, { repo: w.repo.dir });
    assert.equal(inSub.ok, true, JSON.stringify(inSub.diagnostics));
    assert.equal(Buffer.from(inSub.stdout).toString('utf8'), 'sub');
    const atRoot = await runner.run({ executable: process.execPath, args: ['x.js'], cwd: w.repo.dir }, { repo: w.repo.dir });
    assert.equal(atRoot.denied?.code, 'command_denied');
  });
});

describe('allow: --module', () => {
  const MARKER = 'SECRET-MARKER';
  const manifest = (name: string, precise: unknown): string =>
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '0.1.0',
      extensions: [`.${name}`],
      grammar: { wasm: 'grammar.wasm', lock: 'grammar.lock' },
      queries: { tags: 'queries/tags.scm' },
      tiers: ['grammar', 'precise'],
      ...(precise === undefined ? {} : { precise }),
    });
  const COMMAND = ['node', 'evil.js', MARKER];
  const MODULE_FILES: Readonly<Record<string, string>> = {
    ...FILES,
    '.gsd-atlas/languages/evil/atlas-lang.json': manifest('evil', { command: COMMAND }),
    '.gsd-atlas/languages/plain/atlas-lang.json': manifest('plain', undefined),
    '.gsd-atlas/languages/adapted/atlas-lang.json': manifest('adapted', { adapter: 'typescript' }),
  };

  it('module argv not in envelope: the proposal comes from the manifest, the confirmed reply echoes it for the CLI host, every diagnostic stays free of it', async (t) => {
    const w = await makeWorld(t, { files: MODULE_FILES });
    const dry = await w.ask('allow', { repo: w.repo.dir, module: 'evil' });
    const preview = previewOf(dry);
    // The dry run is the one reply that carries the argv: the terminal CLI needs it for the person to read (it is unreachable
    // from MCP, which is refused). The module is named by a boolean, never by its name, path or text.
    assert.equal(preview.fromModule, true);
    assert.deepEqual([preview.executable, ...preview.args], COMMAND);
    assert.equal(preview.sha256, commandHash({ executable: 'node', args: ['evil.js', MARKER], cwd: '.' }, w.repo.dir));
    assert.ok(!JSON.stringify(dry.diagnostics).includes(MARKER));
    assert.ok(!JSON.stringify(dry).includes('evil/'), 'no module folder path');
    assert.ok(!Object.values(dry.data as object).includes('evil'), 'no module name');

    const done = await w.ask('allow', { repo: w.repo.dir, module: 'evil', confirm: preview.sha256 });
    assert.equal(done.ok, true, JSON.stringify(done.diagnostics));
    // The confirmed reply to a CLI-origin Host echoes the approved argv (the same fields the dry run uses), and nothing else of the module.
    assert.deepEqual(done.data, { written: true, sha256: preview.sha256, executable: COMMAND[0], args: COMMAND.slice(1) });
    assert.ok(!JSON.stringify(done.diagnostics).includes(MARKER), 'no diagnostic holds the argv');
    assert.ok(!JSON.stringify(done).includes('evil/'), 'no module folder path');
    assert.ok(!Object.values(done.data as object).includes('evil'), 'no module name');
    assert.deepEqual(loadUserConfig(userDirOf(w), {}).config.permissions?.allow, [{ repo: w.repo.dir, executable: 'node', sha256: preview.sha256 }]);
  });

  it('module argv not in envelope: failures name neither the module nor its text', async (t) => {
    const w = await makeWorld(t, { files: MODULE_FILES });
    const replies = await Promise.all([
      w.ask('allow', { repo: w.repo.dir, module: 'nosuch' }),
      w.ask('allow', { repo: w.repo.dir, module: '../evil' }),
      w.ask('allow', { repo: w.repo.dir, module: 'plain' }),
      w.ask('allow', { repo: w.repo.dir, module: 'adapted' }),
      w.ask('allow', { repo: w.repo.dir, module: 'evil', confirm: 'f'.repeat(64) }),
    ]);
    assert.deepEqual(replies.map(codeOf), ['module_not_found', 'module_not_found', 'no_precise_command', 'no_precise_command', 'confirm_mismatch']);
    for (const reply of replies) {
      const serialized = JSON.stringify(reply);
      for (const secret of [MARKER, 'evil.js', 'nosuch', '../evil', 'adapted', 'plain']) assert.ok(!serialized.includes(secret), `${secret} is not echoed`);
    }
  });

  it('a manifest that changed between the preview and the confirmation is not approved', async (t) => {
    const w = await makeWorld(t, { files: MODULE_FILES });
    const preview = previewOf(await w.ask('allow', { repo: w.repo.dir, module: 'evil' }));
    fs.writeFileSync(path.join(w.repo.dir, '.gsd-atlas/languages/evil/atlas-lang.json'), manifest('evil', { command: ['node', 'worse.js'] }));
    const reply = await w.ask('allow', { repo: w.repo.dir, module: 'evil', confirm: preview.sha256 });
    assert.equal(codeOf(reply), 'confirm_mismatch');
    assert.equal(fs.existsSync(configFileOf(w)), false);
  });

  it('argv and module together are refused, and module respects workdir', async (t) => {
    const w = await makeWorld(t, { files: { ...MODULE_FILES, 'sub/dir/keep.txt': 'x\n' } });
    const both = await w.ask('allow', { repo: w.repo.dir, module: 'evil', argv: ['node'] });
    assert.equal(codeOf(both), 'invalid_args');
    const inSub = previewOf(await w.ask('allow', { repo: w.repo.dir, module: 'evil', workdir: 'sub/dir' }));
    assert.equal(inSub.cwd, 'sub/dir');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 3: the MCP origin, needs_approval, and the providers list reaching the tenants
// ---------------------------------------------------------------------------------------------------------------------

describe('allow: the MCP origin', () => {
  it('allow_forbidden from mcp origin: refused with and without --allow-build, even with a correct confirm, and nothing is written', async (t) => {
    for (const allowBuild of [false, true]) {
      const w = await makeWorld(t, { files: FILES, host: { origin: 'mcp', allowBuild } });
      const argv = [process.execPath, SCRIPT];
      const hash = commandHash({ executable: process.execPath, args: [SCRIPT], cwd: '.' }, w.repo.dir) as string;
      for (const args of [{ repo: w.repo.dir, argv }, { repo: w.repo.dir, argv, confirm: hash }, { repo: w.repo.dir, module: 'evil' }, {}, 'not an object']) {
        const reply = await w.ask('allow', args);
        assert.equal(reply.ok, false, JSON.stringify(args));
        assert.equal(codeOf(reply), 'allow_forbidden', `${JSON.stringify(args)} allowBuild=${String(allowBuild)}`);
        assert.ok(!JSON.stringify(reply).includes(SCRIPT), 'the refusal quotes nothing the caller sent');
      }
      assert.equal(fs.existsSync(configFileOf(w)), false);
      assert.equal(fs.existsSync(userDirOf(w)), false);
    }
  });

  it('allow_forbidden from mcp origin: a host started by a person (cli, or no origin at all) still serves it', async (t) => {
    for (const origin of [undefined, 'cli' as const]) {
      const w = await makeWorld(t, { files: FILES, host: origin === undefined ? {} : { origin } });
      const reply = await w.ask('allow', { repo: w.repo.dir, argv: [process.execPath, SCRIPT] });
      assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    }
  });

  it('there is no MCP tool for allow: the tool list holds the seven read tools only', () => {
    assert.ok(!(TOOL_NAMES as readonly string[]).includes('allow'));
    assert.deepEqual([...TOOL_NAMES].sort(), ['atlas_status', 'code_context', 'code_explain', 'code_find', 'code_impact', 'code_refs', 'lang_list']);
  });
});

describe('permissionsFor: which permission list a host origin may use', () => {
  const list = { allow: [{ repo: path.resolve('/r'), executable: 'node' }] };

  it('cli applies the list; mcp applies it only with allow-build; none stays none', () => {
    assert.equal(permissionsFor('cli', false, list), list);
    assert.equal(permissionsFor('cli', true, list), list);
    assert.equal(permissionsFor('mcp', false, list), undefined);
    assert.equal(permissionsFor('mcp', true, list), list);
    for (const origin of ['cli', 'mcp'] as const) assert.equal(permissionsFor(origin, true, undefined), undefined);
  });
});

describe('needsApprovalFrom: a denied command becomes the needs_approval answer', () => {
  it('maps exactly command_denied to needs_approval with fixed text that names both ways forward and quotes nothing', async () => {
    const secretArg = 'SECRET-ARG-9137';
    const runner = createRealRunner();
    const denied = await runner.run({ executable: process.execPath, args: ['-e', secretArg], cwd: process.cwd() }, { repo: process.cwd() });
    assert.equal(denied.denied?.code, 'command_denied');
    const mapped = needsApprovalFrom(denied);
    assert.ok(mapped !== null);
    assert.equal(mapped.degraded, 'needs_approval');
    assert.equal(mapped.diagnostic.code, 'needs_approval');
    assert.equal(mapped.diagnostic.severity, 'warning');
    assert.match(mapped.diagnostic.message, /gsd-atlas allow/);
    assert.match(mapped.diagnostic.message, /--allow-build/);
    const serialized = JSON.stringify(mapped);
    for (const leaked of [secretArg, process.execPath, process.cwd(), '-e']) assert.ok(!serialized.includes(leaked), `no ${leaked}`);
    // The sentence is the same whatever was denied.
    const other = await runner.run({ executable: 'definitely-another-program', args: ['x'] }, { repo: process.cwd() });
    assert.equal(needsApprovalFrom(other)?.diagnostic.message, mapped.diagnostic.message);
  });

  it('is null for every other outcome: a success, a timeout, a spawn failure, a different denial code and no result at all', async () => {
    const ok = await createRealRunner({ decide: () => ({ allowed: true, via: 'user' }) }).run({ executable: process.execPath, args: ['-e', ''] });
    assert.equal(ok.ok, true);
    assert.equal(needsApprovalFrom(ok), null);
    assert.equal(needsApprovalFrom({}), null);
    const diag = (code: string): { denied: { code: string; severity: 'error'; message: string } } => ({ denied: { code, severity: 'error', message: 'x' } });
    for (const code of ['shim_rejected', 'spawn_failed', 'output_cap_exceeded', 'timeout', 'command_denied_by_someone_else']) {
      assert.equal(needsApprovalFrom(diag(code)), null, code);
    }
    assert.notEqual(needsApprovalFrom(diag('command_denied')), null);
  });
});

describe('providers.disabled reaches the tenant factory', () => {
  it('the Host hands config.providers to the factory that builds a tenant, and nothing when the user set nothing', async (t) => {
    const seen: TenantDeps[] = [];
    const factory = (deps: TenantDeps): ReturnType<typeof createTenant> => {
      seen.push(deps);
      return createTenant(deps);
    };
    const disabled = await makeWorld(t, { files: FILES, host: { tenantFactory: factory, config: { providers: { disabled: ['typescript', 'unknown-id'] } } } });
    assert.equal((await disabled.ask('build', { repo: disabled.repo.dir })).ok, true);
    const plain = await makeWorld(t, { files: FILES, host: { tenantFactory: factory } });
    assert.equal((await plain.ask('build', { repo: plain.repo.dir })).ok, true);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]?.providers, { disabled: ['typescript', 'unknown-id'] });
    assert.equal(seen[1]?.providers, undefined);
  });
});
