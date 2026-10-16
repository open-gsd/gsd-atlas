/**
 * ROADMAP success criterion 4 / command-runner ADR decision 4: a hostile repository runs nothing.
 *
 * The poisoned repository carries a clean/smudge filter driver (via `.gitattributes`), a `core.fsmonitor`
 * command and a `core.hooksPath` folder of hooks, each of which writes a marker file OUTSIDE the repo.
 * A positive control first proves the poison fires when git runs unprotected on this platform; then the
 * Source Tree snapshot runs under the built-in `decide` and the markers must not exist.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { createFakeSourceTree, createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { allowAll, createRealRunner, createRecordingRunner, gitSpec } from './index.ts';
import type { RecordedSpec } from './index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const setup = createRealRunner({ decide: allowAll });

const slash = (p: string): string => p.replaceAll('\\', '/');
const blobId = (content: string): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};
const subcommand = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

const FILES: Record<string, string> = {
  '.gitattributes': '* filter=evil\n',
  'a.txt': 'alpha\n',
  'dir/b.ts': 'export const b = 1;\n',
};

interface Poisoned {
  readonly repo: TempGitRepo;
  /** Written by the filter driver. */
  readonly m1: string;
  /** Written by core.fsmonitor. */
  readonly m2: string;
  /** Written by a hook in core.hooksPath. */
  readonly m3: string;
}

/**
 * A repository whose own config tries to run code. The commit is made BEFORE the poison is configured, so
 * building the fixture itself runs nothing. Markers and scripts live next to the repo, not in it.
 */
async function poisonedRepo(t: { after(fn: () => void): void }, extraFiles: Record<string, string> = {}): Promise<Poisoned> {
  const repo = await createTempGitRepo({ runner: setup, files: { ...FILES, ...extraFiles } });
  t.after(() => repo.cleanup());
  const base = path.dirname(repo.dir);
  const m1 = path.join(base, 'M1');
  const m2 = path.join(base, 'M2');
  const m3 = path.join(base, 'M3');

  const touch = path.join(base, 'touch.cjs');
  fs.writeFileSync(touch, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
  const filter = path.join(base, 'filter.cjs');
  fs.writeFileSync(filter, "require('node:fs').writeFileSync(process.argv[2], 'ran');\nprocess.stdin.pipe(process.stdout);\n");
  const command = (script: string, marker: string): string => `'${slash(process.execPath)}' '${slash(script)}' '${slash(marker)}'`;

  const hooks = path.join(base, 'hooks');
  fs.mkdirSync(hooks);
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction']) {
    const file = path.join(hooks, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec ${command(touch, m3)}\n`);
    fs.chmodSync(file, 0o755);
  }

  await repo.setConfig('filter.evil.clean', command(filter, m1));
  await repo.setConfig('filter.evil.smudge', command(filter, m1));
  await repo.setConfig('core.fsmonitor', command(touch, m2));
  await repo.setConfig('core.hooksPath', slash(hooks));
  repo.write('untracked.txt', 'not committed\n');
  return { repo, m1, m2, m3 };
}

const exists = (p: string): boolean => fs.existsSync(p);

interface Promisor {
  readonly repo: TempGitRepo;
  /** Written by core.sshCommand, which a lazy fetch of a missing promisor object would start. */
  readonly m4: string;
  /** The blob of kept.txt, deleted from the object database after the config is poisoned. */
  readonly blob: string;
}

/** A well-formed object id that is in no object database (the fixture repository is SHA-1). */
const UNKNOWN_ID = '1234567890abcdef1234567890abcdef12345678';

/**
 * A repository that declares a promisor remote and a `core.sshCommand` (verification gap CR-01). When an
 * object is missing locally git lazily fetches it from the promisor remote by starting the transport the
 * repository configures; here that transport is a marker-writing command outside the repo. The commit is
 * made BEFORE the poison is configured, then the loose blob of kept.txt is deleted so that `HEAD:kept.txt`
 * names an object that is absent locally, which is how a partial clone looks.
 */
async function promisorRepo(t: { after(fn: () => void): void }): Promise<Promisor> {
  const repo = await createTempGitRepo({ runner: setup, files: { 'kept.txt': 'kept\n' } });
  t.after(() => repo.cleanup());
  const base = path.dirname(repo.dir);
  const m4 = path.join(base, 'M4');
  const touch = path.join(base, 'touch4.cjs');
  fs.writeFileSync(touch, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");

  await repo.setConfig('core.repositoryformatversion', '1');
  await repo.setConfig('extensions.partialClone', 'origin');
  await repo.setConfig('remote.origin.promisor', 'true');
  await repo.setConfig('remote.origin.url', 'ssh://example.invalid/x.git');
  await repo.setConfig('core.sshCommand', `'${slash(process.execPath)}' '${slash(touch)}' '${slash(m4)}'`);

  const blob = blobId('kept\n');
  const loose = path.join(repo.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  assert.ok(exists(loose), 'the fixture blob must be a loose object');
  fs.chmodSync(loose, 0o644);
  fs.rmSync(loose);
  return { repo, m4, blob };
}

describe('hostile repository: promisor remote with core.sshCommand (CR-01, T-01-43)', () => {
  it('positive control: hasObject on an unknown id starts the repo-configured transport when git runs unprotected', async (t) => {
    const p = await promisorRepo(t);
    await setup.run({ executable: 'git', args: ['-C', p.repo.dir, 'cat-file', '-e', UNKNOWN_ID], env: p.repo.envOverlay });
    if (!exists(p.m4)) t.skip('poison did not fire unprotected on this platform: hasObject trigger (cat-file -e <unknown id>)');
  });

  it('positive control: read of a locally absent blob starts the repo-configured transport when git runs unprotected', async (t) => {
    const p = await promisorRepo(t);
    await setup.run({ executable: 'git', args: ['-C', p.repo.dir, 'cat-file', 'blob', 'HEAD:kept.txt'], env: p.repo.envOverlay });
    if (!exists(p.m4)) t.skip('poison did not fire unprotected on this platform: read trigger (cat-file blob HEAD:kept.txt)');
  });

  it('hasObject and read through the default decide start no transport, only built-in git specs', async (t) => {
    const p = await promisorRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    assert.equal(await tree.hasObject(UNKNOWN_ID), false);
    assert.equal(exists(p.m4), false, 'core.sshCommand ran during hasObject (lazy fetch of a missing object)');

    // The answer for an absent blob is not asserted (null or a git_failed error are both acceptable);
    // what matters is that nothing outside git was started.
    await tree.read('HEAD', 'kept.txt').catch(() => null);
    assert.equal(exists(p.m4), false, 'core.sshCommand ran during read (lazy fetch of a missing blob)');

    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.length >= 2);
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    assert.deepEqual(recording.starts.map(subcommand), ['cat-file', 'cat-file']);
  });
});

describe('hostile repository (ROADMAP SC4)', () => {
  it('positive control: the poison fires when git runs unprotected', async (t) => {
    const p = await poisonedRepo(t);
    const dir = p.repo.dir;
    const env = p.repo.envOverlay;
    await setup.run({ executable: 'git', args: ['-C', dir, 'ls-files', '-o', '--exclude-standard'], env });
    await setup.run({ executable: 'git', args: ['-C', dir, 'hash-object', '--stdin-paths'], env, stdin: 'a.txt\n' });
    await setup.run({ executable: 'git', args: ['-C', dir, 'commit', '--quiet', '--allow-empty', '-m', 'control'], env });
    const silent = [
      ['M1 (filter driver)', p.m1],
      ['M2 (core.fsmonitor)', p.m2],
      ['M3 (core.hooksPath)', p.m3],
    ].filter(([, marker]) => !exists(marker as string));
    if (silent.length > 0) {
      t.skip(`poison did not fire unprotected on this platform: ${silent.map(([name]) => name).join(', ')}`);
    }
  });

  it('a snapshot through the default decide runs none of it, starting only built-in git specs', async (t) => {
    const p = await poisonedRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    const { files, diagnostics } = await tree.snapshot(p.repo.dir);

    assert.equal(exists(p.m1), false, 'the filter driver ran');
    assert.equal(exists(p.m2), false, 'core.fsmonitor ran');
    assert.equal(exists(p.m3), false, 'a core.hooksPath hook ran');

    assert.deepEqual(diagnostics, []);
    assert.deepEqual([...files.keys()].sort(), ['.gitattributes', 'a.txt', 'dir/b.ts', 'untracked.txt']);
    // The neutralised filter did not transform anything: ids are those of the plain content.
    assert.equal(files.get('a.txt'), blobId('alpha\n'));

    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.length > 0);
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    assert.deepEqual(recording.starts.map(subcommand).sort(), ['config', 'hash-object', 'ls-files', 'ls-files']);
    const hashes = recording.starts.filter((s) => subcommand(s) === 'hash-object');
    assert.equal(hashes.length, 1);
    const stdin = (hashes[0] as RecordedSpec).stdin;
    assert.equal(typeof stdin, 'string');
    assert.equal(String(stdin).split('\n').filter((l) => l !== '').length, files.size);
  });

  it('still yields exactly one hash-object start for a repository with 150 files', async (t) => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`src/f${i}.txt`, `file ${i}\n`]));
    const p = await poisonedRepo(t, many);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });
    const { files } = await tree.snapshot(p.repo.dir);
    assert.equal(files.size, 150 + 4);
    assert.equal(recording.starts.filter((s) => subcommand(s) === 'hash-object').length, 1);
    assert.equal(exists(p.m1) || exists(p.m2) || exists(p.m3), false);
  });

  it('denies a spec built for git status and starts nothing', async (t) => {
    const p = await poisonedRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const result = await recording.run(gitSpec(['status', '--porcelain'], { worktree: p.repo.dir, filterNames: ['evil'], env: p.repo.envOverlay }));
    assert.ok(result.denied !== undefined);
    assert.equal(result.ok, false);
    assert.equal(recording.starts.length, 0);
    assert.equal(recording.denials.length, 1);
    assert.equal(exists(p.m1) || exists(p.m2) || exists(p.m3), false);
  });

  it('the fake Source Tree starts nothing at all', async () => {
    const tree = createFakeSourceTree({ committed: { 'a.txt': 'alpha\n' }, working: {}, ignored: [] });
    const { files } = await tree.snapshot('/anywhere');
    assert.deepEqual([...files], [['a.txt', blobId('alpha\n')]]);
  });

  it('no module outside src/command-runner can start a process (lintFiles over src reports no boundary violations)', async () => {
    const eslint = new ESLint({ cwd: root });
    const results = await eslint.lintFiles(['src/**/*.ts']);
    const boundary = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax')
        .map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}: ${m.message}`),
    );
    assert.ok(results.length > 50, 'lintFiles must actually cover src');
    assert.deepEqual(boundary, []);
    const fatal = results.flatMap((r) => r.messages.filter((m) => m.fatal));
    assert.deepEqual(fatal, []);
  });
});
