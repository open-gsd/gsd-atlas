/**
 * The `gsd-atlas` bin as a real process, started through the CommandRunner (no shell): what the composition root
 * wires into the CLI. `init` works only when the bin supplies the home directory, the working directory and the MCP
 * launch command, so this is where that wiring is proved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas.ts');
const MCP_BIN = path.resolve(import.meta.dirname, '..', 'src', 'bin', 'gsd-atlas-mcp.ts');
const runner = createRealRunner({ decide: allowAll });

interface Spawned {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnBin(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<Spawned> {
  const result = await runner.run({ executable: process.execPath, args: [BIN, ...args], cwd, env });
  assert.equal(result.spawnError, undefined, 'the bin must start');
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

/** Every path under `dir`, relative, sorted: a listing that notices anything created or removed. */
function listing(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();
}

interface Setup {
  readonly home: string;
  readonly userDir: string;
  readonly repo: string;
  readonly env: Record<string, string>;
}

/** A temporary HOME, a user directory and a git repository to run the bin in. */
async function setup(t: TestContext): Promise<Setup> {
  const tmp = makeTempDir();
  const repo = await createTempGitRepo({ runner, world: { committed: { 'a.txt': 'text\n' } } });
  t.after(() => {
    tmp.cleanup();
    repo.cleanup();
  });
  const home = path.join(tmp.path, 'home');
  fs.mkdirSync(home, { recursive: true });
  const userDir = path.join(tmp.path, 'user');
  return { home, userDir, repo: repo.dir, env: { HOME: home, USERPROFILE: home, GSD_ATLAS_USER_DIR: userDir } };
}

describe('gsd-atlas bin: init and the working directory', () => {
  it('init --dry-run --agent claude registers nothing but reports the claude result updated, with exit 0 and one envelope', async (t) => {
    const world = await setup(t);
    const claudeFile = path.join(world.home, '.claude.json');
    fs.writeFileSync(claudeFile, '{\n  "theme": "dark"\n}\n');
    const before = fs.readFileSync(claudeFile, 'utf8');
    const listingBefore = listing(world.repo);

    const out = await spawnBin(['init', '--dry-run', '--agent', 'claude'], world.repo, world.env);
    assert.equal(out.exitCode, 0, out.stderr);
    const lines = out.stdout.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1, `stdout is one envelope, got ${out.stdout}`);
    const envelope = JSON.parse(lines[0] as string) as { schema: string; ok: boolean; data: { dryRun: boolean; hosts: Array<{ agent: string; action: string; file: string }> } };
    assert.equal(envelope.schema, 'gsd-atlas.init/1');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.dryRun, true);
    assert.deepEqual(envelope.data.hosts.map((host) => [host.agent, host.action]), [['claude', 'updated']]);
    assert.equal(envelope.data.hosts[0]?.file, claudeFile);

    assert.equal(fs.readFileSync(claudeFile, 'utf8'), before, 'a dry run does not modify the file');
    assert.deepEqual(listing(world.repo), listingBefore, 'running inside a repository creates nothing in it');
  });

  it('init (not a dry run) registers the absolute node and gsd-atlas-mcp paths of the running bin', async (t) => {
    const world = await setup(t);
    const claudeFile = path.join(world.home, '.claude.json');
    fs.writeFileSync(claudeFile, '{}\n');
    const out = await spawnBin(['init', '--agent', 'claude'], world.repo, world.env);
    assert.equal(out.exitCode, 0, out.stderr);
    const written = JSON.parse(fs.readFileSync(claudeFile, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = written.mcpServers['gsd-atlas'];
    assert.equal(entry?.command, process.execPath);
    assert.deepEqual(entry?.args, [MCP_BIN]);
    assert.ok(path.isAbsolute(entry?.args[0] as string));
  });

  it('--version still prints the package version, and --help the usage, creating nothing in the repository', async (t) => {
    const world = await setup(t);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    const listingBefore = listing(world.repo);
    const version = await spawnBin(['--version'], world.repo, world.env);
    assert.equal(version.exitCode, 0, version.stderr);
    assert.equal(version.stdout, `gsd-atlas ${pkg.version}\n`);
    const help = await spawnBin(['--help'], world.repo, world.env);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /gsd-atlas find/);
    assert.deepEqual(listing(world.repo), listingBefore);
  });

  it('exit codes cross the process boundary: a usage error exits 1, and a question outside any repository exits 2 with not_a_repo', async (t) => {
    const world = await setup(t);
    const outside = path.dirname(world.home);
    const usage = await spawnBin(['find'], world.repo, world.env);
    assert.equal(usage.exitCode, 1);
    assert.equal(usage.stdout, '');
    assert.match(usage.stderr, /Usage: gsd-atlas/);

    const notARepo = await spawnBin(['find', 'x', '--repo', outside], world.repo, world.env);
    assert.equal(notARepo.exitCode, 2, notARepo.stderr);
    const envelope = JSON.parse(notARepo.stdout) as { ok: boolean; diagnostics: Array<{ code: string }> };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'not_a_repo');
  });
});
