import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { RecordedSpec } from '../command-runner/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import type { TempGitRepoOptions } from '../test-kit/index.ts';
import { defineSourceTreeContract } from './contract.ts';
import { createFakeSourceTree, createSourceTree } from './index.ts';

/** Independent oracle: the git blob id of `content` in a SHA-1 repository. */
const blobId = (content: string | Uint8Array): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommand = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

describe('Source Tree tracer: one batched hash-object over a whole snapshot', () => {
  it('hashes tracked and untracked files to the git blob ids, in exactly four git starts', async (t) => {
    const repo = await createTempGitRepo({
      runner: setupRunner,
      files: { 'a.txt': 'alpha\n', 'dir/b.ts': 'export const b = 1;\n', 'sp ace.txt': 'space\n' },
    });
    t.after(() => repo.cleanup());
    repo.write('untracked.txt', 'not committed\n');

    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: repo.dir, envOverlay: repo.envOverlay });
    const snapshot = await tree.snapshot(repo.dir);

    assert.deepEqual(snapshot.diagnostics, []);
    assert.deepEqual(
      [...snapshot.files].sort(([x], [y]) => (x < y ? -1 : 1)),
      [
        ['a.txt', blobId('alpha\n')],
        ['dir/b.ts', blobId('export const b = 1;\n')],
        ['sp ace.txt', blobId('space\n')],
        ['untracked.txt', blobId('not committed\n')],
      ],
    );

    assert.equal(recording.denials.length, 0);
    assert.equal(recording.starts.length, 4, recording.starts.map((s) => subcommand(s)).join(','));
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'));
    const hashes = recording.starts.filter((s) => subcommand(s) === 'hash-object');
    assert.equal(hashes.length, 1);
    const [hash] = hashes;
    assert.ok(hash?.args.includes('--stdin-paths'));
    assert.equal(typeof hash?.stdin, 'string');
    const lines = String(hash?.stdin).split('\n').filter((l) => l !== '');
    assert.deepEqual([...lines].sort(), ['a.txt', 'dir/b.ts', 'sp ace.txt', 'untracked.txt']);
  });
});

defineSourceTreeContract('fake', (world) =>
  Promise.resolve({ tree: createFakeSourceTree(world), worktree: '/fake', cleanup: () => {} }),
);
defineSourceTreeContract('real', async (world) => {
  const repo = await createTempGitRepo({ runner: setupRunner, world });
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
  return { tree, worktree: repo.dir, cleanup: () => repo.cleanup() };
});

/** A real repo, a recording runner that really runs the built-in specs, and a tree over them. */
async function realTree(t: { after(fn: () => void): void }, options: Omit<TempGitRepoOptions, 'runner'>) {
  const repo = await createTempGitRepo({ runner: setupRunner, ...options });
  t.after(() => repo.cleanup());
  const recording = createRecordingRunner({ delegate: createRealRunner() });
  const tree = createSourceTree({ runner: recording, repoDir: repo.dir, envOverlay: repo.envOverlay });
  return { repo, recording, tree };
}

const hashStarts = (recording: { readonly starts: readonly RecordedSpec[] }): number =>
  recording.starts.filter((s) => subcommand(s) === 'hash-object').length;

const codes = (diagnostics: ReadonlyArray<{ code: string; subject?: string }>): string[] =>
  diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`).sort();

/** What a conforming git prints for the config read: the probe driver named in GIT_CONFIG_KEY_0, and nothing else. */
const probeListing = (spec: { readonly env?: Readonly<Record<string, string>> }): string => {
  const key = spec.env?.['GIT_CONFIG_KEY_0'] ?? '';
  return `${key}\n${key.replace(/\.clean$/, '.smudge')}\n`;
};

const notOnWindows =(why: string): string | false => (process.platform === 'win32' ? why : false);

describe('real Source Tree git quirks', () => {
  it('hashes a CRLF file under `* text=auto` to the blob id of its LF content', async (t) => {
    const { repo, tree } = await realTree(t, { files: { '.gitattributes': '* text=auto\n' } });
    repo.write('crlf.txt', 'one\r\ntwo\r\n');
    await repo.commitAll('crlf');
    repo.write('untracked-crlf.txt', 'three\r\nfour\r\n');
    const { files } = await tree.snapshot(repo.dir);
    assert.equal(files.get('crlf.txt'), blobId('one\ntwo\n'));
    assert.equal(files.get('untracked-crlf.txt'), blobId('three\nfour\n'));
  });

  it('returns names with spaces and a non-ASCII letter verbatim and unquoted', async (t) => {
    const names = ['sp ace.txt', 'café menu.txt', 'dir with space/über.ts'];
    const { repo, tree } = await realTree(t, { files: Object.fromEntries(names.map((n) => [n, `${n}\n`])) });
    repo.write('untracked é.txt', 'u\n');
    const { files } = await tree.snapshot(repo.dir);
    for (const name of [...names, 'untracked é.txt']) assert.ok(files.has(name.normalize('NFC')), name);
    assert.ok([...files.keys()].every((k) => !k.startsWith('"')));
  });

  it(
    'skips a path with a newline (unhashable_path) and still hashes the rest in one call',
    { skip: notOnWindows('Windows cannot create file names with a newline or a double quote') },
    async (t) => {
      const { repo, recording, tree } = await realTree(t, {
        files: { 'ok.txt': 'ok\n', 'bad\nname.txt': 'bad\n', '"quoted".txt': 'q\n' },
      });
      repo.write('also ok.txt', 'ok too\n');
      const { files, diagnostics } = await tree.snapshot(repo.dir);
      assert.deepEqual([...files.keys()].sort(), ['also ok.txt', 'ok.txt']);
      assert.equal(files.get('ok.txt'), blobId('ok\n'));
      assert.deepEqual(codes(diagnostics), ['unhashable_path:"quoted".txt', 'unhashable_path:bad\nname.txt']);
      assert.equal(hashStarts(recording), 1);
    },
  );

  it(
    'skips a symlink with symlink_skipped and keeps the batch going',
    { skip: notOnWindows('creating a symlink needs privileges on Windows') },
    async (t) => {
      const { repo, tree } = await realTree(t, { files: { 'target.txt': 'target\n' } });
      fs.symlinkSync('target.txt', path.join(repo.dir, 'link.txt'));
      fs.symlinkSync(path.dirname(repo.dir), path.join(repo.dir, 'outside-link'));
      await repo.commitAll('links');
      const { files, diagnostics } = await tree.snapshot(repo.dir);
      assert.deepEqual([...files.keys()], ['target.txt']);
      assert.deepEqual(codes(diagnostics), ['symlink_skipped:link.txt', 'symlink_skipped:outside-link']);
    },
  );

  it('skips a gitlink entry (mode 160000) with gitlink_skipped', async (t) => {
    const { repo, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    await repo.git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/sub`]);
    const { files, diagnostics } = await tree.snapshot(repo.dir);
    assert.deepEqual([...files.keys()], ['a.txt']);
    assert.deepEqual(codes(diagnostics), ['gitlink_skipped:vendor/sub']);
  });

  it('reports a skip-worktree file absent from disk as missing_on_disk without failing the batch', async (t) => {
    const { repo, tree } = await realTree(t, { files: { 'present.txt': 'here\n', 'sparse/far.txt': 'away\n' } });
    await repo.git(['update-index', '--skip-worktree', 'sparse/far.txt']);
    repo.remove('sparse');
    const { files, diagnostics } = await tree.snapshot(repo.dir);
    assert.deepEqual([...files.keys()], ['present.txt']);
    assert.deepEqual(codes(diagnostics), ['missing_on_disk:sparse/far.txt']);
  });

  it('throws hash_output_mismatch when git returns a different number of ids than paths', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    t.after(() => repo.cleanup());
    const lying = createRecordingRunner({
      respond: (spec) => {
        const sub = subcommand(spec);
        if (sub === 'config') return { stdout: probeListing(spec) };
        if (sub === 'ls-files' && spec.args.includes('-s')) {
          const entries = [`100644 ${'1'.repeat(40)} 0\ta.txt`, `100644 ${'2'.repeat(40)} 0\tb.txt`];
          return { stdout: entries.map((e) => `${e}\0`).join('') };
        }
        if (sub === 'ls-files') return { stdout: '' };
        return { stdout: `${'3'.repeat(40)}\n` };
      },
    });
    const tree = createSourceTree({ runner: lying, repoDir: repo.dir });
    await assert.rejects(() => tree.snapshot(repo.dir), { code: 'hash_output_mismatch' });
  });

  it('fails closed: a config read whose output lacks the probe rejects the snapshot and starts no hash-object', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    for (const config of [{ stdout: '' }, { stdout: 'filter.evil.clean\n' }]) {
      const recording = createRecordingRunner({ respond: (spec) => (subcommand(spec) === 'config' ? config : { stdout: '' }) });
      const tree = createSourceTree({ runner: recording, repoDir: repo.dir });
      await assert.rejects(() => tree.snapshot(repo.dir), { code: 'git_env_config_unsupported' });
      assert.equal(hashStarts(recording), 0);
      assert.deepEqual(recording.starts.map(subcommand), ['config']);
    }
  });

  it('fails closed: a failed config read (exit 128, and exit 1 with no output) rejects the snapshot and starts no hash-object', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    for (const exitCode of [128, 1]) {
      const recording = createRecordingRunner({ respond: (spec) => (subcommand(spec) === 'config' ? { exitCode } : { stdout: '' }) });
      const tree = createSourceTree({ runner: recording, repoDir: repo.dir });
      await assert.rejects(() => tree.snapshot(repo.dir), { code: 'filter_enumeration_failed' });
      assert.equal(hashStarts(recording), 0);
      assert.deepEqual(recording.starts.map(subcommand), ['config']);
    }
  });

  it('fails closed: a config listing with a driver name that is not valid UTF-8 rejects the snapshot and starts no hash-object (CR-01)', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    const recording = createRecordingRunner({
      respond: (spec) =>
        subcommand(spec) === 'config'
          ? { stdout: Buffer.concat([Buffer.from(probeListing(spec)), Buffer.from('filter.a'), Buffer.from([0xff]), Buffer.from('b.clean\n')]) }
          : { stdout: '' },
    });
    const tree = createSourceTree({ runner: recording, repoDir: repo.dir });
    await assert.rejects(() => tree.snapshot(repo.dir), { code: 'filter_enumeration_failed' });
    assert.equal(hashStarts(recording), 0);
    assert.deepEqual(recording.starts.map(subcommand), ['config']);
  });

  it('answers hasObject false and throws invalid_argument for option-like input without starting git', async (t) => {
    const { recording, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    assert.equal(await tree.hasObject('--all'), false);
    await assert.rejects(() => tree.read('--output=out.txt', 'a.txt'), { code: 'invalid_argument' });
    await assert.rejects(() => tree.read('HEAD', 'a\0b'), { code: 'invalid_argument' });
    assert.equal(recording.starts.length, 0);
    assert.equal(await tree.hasObject(blobId('a\n')), true);
  });
});
