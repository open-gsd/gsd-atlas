/**
 * Plan 03-32 (SKL-04, D-17) at the CLI layer, DIAGNOSTICS.md 9.6 acceptance test 2: `gsd-atlas bug` over the real composed
 * Host (real runner, Grammar Engine, Governor, Tenant, store, flight recorder and cache directory, all isolated in a
 * temporary directory) in a repository whose symbol names, file paths, branch name, remote URL and secrets are known
 * markers. In hashed and redacted mode none of the markers is in the bundle, the preview or anything the command printed,
 * with every data type approved; in raw mode the symbol and path markers appear only after the explicit confirmation, the
 * preview is marked, and the secrets still do not appear because atlas never stores them. Lives under scripts for the
 * reason scripts/cli-e2e.test.ts gives.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { composeHost } from '../src/bin/compose.ts';
import type { Composed } from '../src/bin/compose.ts';
import { runCli } from '../src/cli/index.ts';
import { BUG_INCLUDE, BUG_MODES } from '../src/cli/tool-commands.ts';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { BUG_TYPES, MODES } from '../src/diagnostics/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';

const toyModule = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'modules', 'toy');
const setupRunner = createRealRunner({ decide: allowAll });

/** The five markers of DIAGNOSTICS 9.6 test 2: a symbol, a path, a key, a host name and a password. */
const MARKERS = ['ZEBRA_SYMBOL', '/home/secret/path', 'AKIAIOSFODNN7EXAMPLE', 'internal.corp.example', 'hunter2'] as const;
const BRANCH = 'feature/ZEBRA_SYMBOL-hunter2';

/** Every marker sits in a file name, a symbol, a comment, the branch, the remote, a commit message or a committed config. */
const FILES: Readonly<Record<string, string>> = {
  'ZEBRA_SYMBOL.toy': '// hunter2 AKIAIOSFODNN7EXAMPLE /home/secret/path\nfn ZEBRA_SYMBOL {\n  boot();\n}\nfn boot {\n}\n',
  'internal.corp.example.toy': 'fn helper {\n}\n',
  'README.md': '# ZEBRA_SYMBOL at internal.corp.example, password hunter2\n',
  '.gsd-atlas/config.json': JSON.stringify({ token: 'AKIAIOSFODNN7EXAMPLE', host: 'internal.corp.example' }),
};

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: { readonly ok: boolean; readonly data: unknown; readonly diagnostics: ReadonlyArray<{ readonly code: string }> };
}

interface World {
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  readonly cacheDir: string;
  /** Where a bundle goes. */
  readonly reportsDir: string;
  cli(argv: readonly string[]): Promise<Run>;
}

function sink(): { readonly text: () => string; write(text: string): boolean } {
  const written: string[] = [];
  return { text: () => written.join(''), write: (text) => (written.push(text), true) };
}

async function hostileWorld(t: TestContext): Promise<World> {
  const tmp = makeTempDir();
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: FILES } });
  await repo.git(['checkout', '-q', '-b', BRANCH]);
  await repo.git(['remote', 'add', 'origin', 'https://internal.corp.example/ZEBRA_SYMBOL.git']);
  repo.write('notes.toy', 'fn later {\n}\n');
  await repo.commitAll('touch /home/secret/path for hunter2');
  const userDir = path.join(tmp.path, 'user');
  fs.cpSync(toyModule, path.join(userDir, 'languages', 'toy'), { recursive: true });
  const cacheDir = path.join(tmp.path, 'cache');
  const env = { ...process.env, ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir, XDG_CACHE_HOME: cacheDir, XDG_STATE_HOME: path.join(tmp.path, 'state') };
  const hosts: Composed[] = [];
  const composed = composeHost({ cwd: tmp.path, env, home: path.join(tmp.path, 'home'), stderr: sink() });
  hosts.push(composed);
  t.after(async () => {
    for (const each of hosts) await each.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  const cwd = path.dirname(repo.dir);
  return {
    repo,
    tmp,
    cacheDir,
    reportsDir: path.join(cacheDir, 'gsd-atlas', 'bug-reports'),
    async cli(argv) {
      const stdout = sink();
      const stderr = sink();
      const code = await runCli(argv, { client: composed.client, version: () => '0.0.0', stdout, stderr, cwd });
      const out = stdout.text();
      assert.ok(out === '' || (out.endsWith('\n') && out.indexOf('\n') === out.length - 1), `stdout must be one JSON line, got ${JSON.stringify(out).slice(0, 200)}`);
      return { code, stdout: out, stderr: stderr.text(), envelope: out === '' ? { ok: false, data: null, diagnostics: [] } : JSON.parse(out) };
    },
  };
}

/** Index the repository and make the calls a user would have made before something looked wrong. */
async function useIt(world: World): Promise<void> {
  const repo = ['--repo', world.repo.dir];
  assert.equal((await world.cli(['build', ...repo])).code, 0);
  await world.cli(['find', 'ZEBRA_SYMBOL', ...repo]);
  await world.cli(['find', 'boot', ...repo]);
  // The arguments of a call are recorded whether or not the call found anything: a path and a name that are markers.
  await world.cli(['refs', 'ZEBRA_SYMBOL', '--path', '/home/secret/path/ZEBRA_SYMBOL.toy', ...repo]);
  await world.cli(['context', 'helper', '--path', 'internal.corp.example.toy', ...repo]);
}

const TEXT = [
  'slow after switching, see /home/secret/path/x.ts',
  'key AKIAIOSFODNN7EXAMPLE',
  'host internal.corp.example',
  'the password is hunter2',
].join(', ');

const everyType = BUG_INCLUDE.join(',');

/** The directory the bundle was written to, from the printed envelope. */
const dirOf = (run: Run): string => (run.envelope.data as { path: string }).path;

describe('the CLI lists match the diagnostics module', () => {
  it('the data types and modes the CLI accepts are the ones the Host reads', () => {
    assert.deepEqual([...BUG_INCLUDE], [...BUG_TYPES]);
    assert.deepEqual([...BUG_MODES], [...MODES]);
  });
});

describe('gsd-atlas bug over the real Host: the privacy fixture', () => {
  it('hashed mode contains no marker: not in the bundle, the preview, stdout or stderr, with every type approved', async (t) => {
    const world = await hostileWorld(t);
    await useIt(world);
    const run = await world.cli(['bug', '--what', TEXT, '--expected', 'the callers of boot', '--steps', 'run find then refs', '--include', everyType, '--repo', world.repo.dir]);
    assert.equal(run.code, 0, run.stderr);
    const dir = dirOf(run);
    assert.equal(path.dirname(dir), world.reportsDir);
    const bundle = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
    const preview = fs.readFileSync(path.join(dir, 'preview.txt'), 'utf8');

    // Not vacuous: the bundle really holds the recorder, the health, the versions and the failing answer, as tokens.
    const parsed = JSON.parse(bundle) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(parsed), ['format', 'header', 'problem', 'versions', 'health', 'recorder', 'failing']);
    assert.ok(((parsed['recorder'] as { events: unknown[] }).events).length >= 4, 'the four calls are in the excerpt');
    assert.ok(/<h:[0-9a-f]{8}>/.test(bundle), 'names and paths are tokens');
    assert.equal(typeof (parsed['health']?.['store'] as Record<string, unknown>)['schema_version'], 'number');
    assert.ok(parsed['failing']?.['answer_id'] !== undefined);

    const everything = [bundle, preview, run.stdout, run.stderr].join('\n');
    for (const marker of MARKERS) assert.ok(!everything.includes(marker), `the output carries ${marker}`);
    assert.ok(!everything.includes(world.repo.dir), 'the repository location is not there');
    assert.ok(!everything.includes(BRANCH) && !everything.includes('feature/'), 'the branch is not there');
    assert.ok(!everything.includes('origin'), 'the remote is not there');
    assert.ok(everything.includes('[removed]'), 'the user text was scrubbed rather than dropped');
    assert.equal(preview.split('\n')[0]?.startsWith('RAW MODE'), false);
  });

  it('redacted mode contains no marker either, and names and paths are removed rather than tokenised', async (t) => {
    const world = await hostileWorld(t);
    await useIt(world);
    const run = await world.cli(['bug', '--what', TEXT, '--include', everyType, '--mode', 'redacted', '--repo', world.repo.dir]);
    assert.equal(run.code, 0, run.stderr);
    const bundle = fs.readFileSync(path.join(dirOf(run), 'bundle.json'), 'utf8');
    const everything = [bundle, (run.envelope.data as { preview: string }).preview, run.stdout, run.stderr].join('\n');
    for (const marker of MARKERS) assert.ok(!everything.includes(marker), `the output carries ${marker}`);
    assert.ok(bundle.includes('<removed>'));
    assert.ok(!/<h:[0-9a-f]{8}>/.test(bundle), 'no token in redacted mode');
    assert.ok(!everything.includes(world.repo.dir));
  });

  it('raw mode needs confirmation and is marked: without --confirm-raw nothing is written; with it the symbol and path appear, the secrets do not', async (t) => {
    const world = await hostileWorld(t);
    await useIt(world);
    const refused = await world.cli(['bug', '--what', TEXT, '--include', everyType, '--mode', 'raw', '--repo', world.repo.dir]);
    assert.equal(refused.code, 2);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /raw_not_confirmed/);
    assert.equal(fs.existsSync(world.reportsDir), false, 'nothing was written');

    const run = await world.cli(['bug', '--what', TEXT, '--include', everyType, '--mode', 'raw', '--confirm-raw', '--repo', world.repo.dir]);
    assert.equal(run.code, 0, run.stderr);
    const dir = dirOf(run);
    const bundle = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
    const preview = fs.readFileSync(path.join(dir, 'preview.txt'), 'utf8');
    assert.equal(preview.split('\n')[0], 'RAW MODE: names and paths are included as they are');
    assert.equal((run.envelope.data as { preview: string }).preview.split('\n')[0], 'RAW MODE: names and paths are included as they are');
    assert.ok(bundle.includes('ZEBRA_SYMBOL'), 'the symbol is there');
    assert.ok(bundle.includes('/home/secret/path'), 'the path is there');
    assert.ok(bundle.includes('internal.corp.example.toy'), 'a path the user passed to a tool is a path, so raw mode shows it');
    for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'hunter2']) {
      assert.ok(!bundle.includes(secret) && !preview.includes(secret), `raw mode carries ${secret}`);
    }
    assert.ok(!bundle.includes(BRANCH));
  });

  it('the bundle is the preview: the printed preview is the text of preview.txt and ends with the bytes of bundle.json', async (t) => {
    const world = await hostileWorld(t);
    await useIt(world);
    const run = await world.cli(['bug', '--what', 'one', '--include', 'recorder', '--repo', world.repo.dir]);
    assert.equal(run.code, 0, run.stderr);
    const dir = dirOf(run);
    const bundle = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
    const preview = fs.readFileSync(path.join(dir, 'preview.txt'), 'utf8');
    assert.equal((run.envelope.data as { preview: string }).preview, preview);
    assert.ok(preview.endsWith(bundle));
    assert.match(run.stderr, /Attach bundle\.json to a new issue at https:\/\/github\.com\/open-gsd\/gsd-atlas\/issues\/new; atlas does not upload anything\./);
  });
});
