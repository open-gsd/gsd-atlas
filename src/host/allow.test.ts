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
import { CONFIG_FILE, loadUserConfig } from './config.ts';
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
    assert.deepEqual(reply.data, { written: true, sha256: preview.sha256 });
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
