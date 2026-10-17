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
import type { SourceTreeWorld } from './index.ts';
import { parseWorktreeList } from './worktrees.ts';

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
/**
 * Realises `SourceTreeWorld.attributes` as linguist attributes in `.git/info/attributes`: git reads them like
 * `.gitattributes`, but the file is untracked, so no attribute file ever appears in a snapshot.
 */
function writeAttributes(repoDir: string, attributes: NonNullable<SourceTreeWorld['attributes']>): void {
  const lines: string[] = [];
  for (const [rel, attr] of Object.entries(attributes)) {
    const pattern = `/${rel.replace(/[\\*?[\] ]/g, '\\$&')}`;
    if (attr.generated !== undefined) lines.push(`${pattern} ${attr.generated ? '' : '-'}linguist-generated`);
    if (attr.vendored !== undefined) lines.push(`${pattern} ${attr.vendored ? '' : '-'}linguist-vendored`);
  }
  const file = path.join(repoDir, '.git', 'info', 'attributes');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

/**
 * Realises `SourceTreeWorld.commits` and `modes` on top of the first commit the test-kit made: each later commit
 * rewrites the tree to its file map, the LAST one also gets the special modes through the index (so no symlink
 * privileges are needed), and the world's working-tree edits are applied after the final commit.
 */
async function realiseHistory(repo: Awaited<ReturnType<typeof createTempGitRepo>>, world: SourceTreeWorld): Promise<void> {
  const commits = world.commits ?? [];
  for (let i = 1; i < commits.length; i += 1) {
    const previous = commits[i - 1] ?? {};
    const next = commits[i] ?? {};
    const last = i === commits.length - 1;
    const modes = last ? (world.modes ?? {}) : {};
    for (const rel of Object.keys(previous)) if (!Object.hasOwn(next, rel)) repo.remove(rel);
    for (const [rel, content] of Object.entries(next)) if (!Object.hasOwn(modes, rel)) repo.write(rel, content);
    await repo.git(['add', '-A']);
    for (const [rel, mode] of Object.entries(modes)) {
      if (mode === 'executable') {
        repo.write(rel, next[rel] ?? '');
        await repo.git(['add', '--', rel]);
        await repo.git(['update-index', '--chmod=+x', '--', rel]);
      } else if (mode === 'symlink') {
        const oid = (await repo.git(['hash-object', '-w', '--stdin'], next[rel] ?? '')).trim();
        await repo.git(['update-index', '--add', '--cacheinfo', `120000,${oid},${rel}`]);
      } else {
        await repo.git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},${rel}`]);
      }
    }
    await repo.git(['commit', '--quiet', '--no-verify', '-m', `commit ${String(i + 1)}`]);
  }
  for (const [rel, content] of Object.entries(world.working)) {
    if (content === null) repo.remove(rel);
    else repo.write(rel, content);
  }
}

defineSourceTreeContract('real', async (world) => {
  const history = world.commits !== undefined;
  const repo = await createTempGitRepo({
    runner: setupRunner,
    world: history ? { committed: world.commits?.[0] ?? {}, working: {}, ignored: world.ignored } : world,
  });
  if (history) await realiseHistory(repo, world);
  if (world.attributes !== undefined) writeAttributes(repo.dir, world.attributes);
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

const checkAttrStarts = (recording: { readonly starts: readonly RecordedSpec[] }): RecordedSpec[] =>
  recording.starts.filter((s) => subcommand(s) === 'check-attr');

describe('real Source Tree sourceSet', () => {
  const OPTIONS = { extensions: ['.ts'], maxBytes: 1000 } as const;

  it('reads committed .gitattributes for linguist-generated and linguist-vendored (one check-attr run, 60 s timeout)', async (t) => {
    const { repo, recording, tree } = await realTree(t, {
      files: {
        '.gitattributes': 'gen/** linguist-generated\nvendor/** linguist-vendored\ngen/keep.ts -linguist-generated\n',
        'a.ts': 'a\n',
        'gen/out.ts': 'g\n',
        'gen/keep.ts': 'k\n',
        'vendor/v.ts': 'v\n',
        'z.ts': 'z\n',
      },
    });
    const { files } = await tree.snapshot(repo.dir);
    recording.reset();
    const result = await tree.sourceSet(repo.dir, files, OPTIONS);
    assert.deepEqual([...result.files.keys()], ['a.ts', 'gen/keep.ts', 'z.ts']);
    assert.deepEqual(codes(result.skipped).filter((c) => !c.startsWith('extension_not_claimed')), [
      'generated_skipped:gen/out.ts',
      'vendored_skipped:vendor/v.ts',
    ]);
    const attrs = checkAttrStarts(recording);
    assert.equal(attrs.length, 1);
    assert.equal(recording.starts.length, 1, recording.starts.map((s) => subcommand(s)).join(','));
    assert.equal(attrs[0]?.timeoutMs, 60000);
    assert.ok(attrs[0]?.args.includes('--stdin') && attrs[0].args.includes('-z'));
  });

  it('starts no git for an empty extension list or an empty file map', async (t) => {
    const { repo, recording, tree } = await realTree(t, { files: { 'a.ts': 'a\n' } });
    const { files } = await tree.snapshot(repo.dir);
    recording.reset();
    assert.equal((await tree.sourceSet(repo.dir, files, { extensions: [], maxBytes: 1000 })).files.size, 0);
    assert.equal((await tree.sourceSet(repo.dir, new Map(), OPTIONS)).files.size, 0);
    assert.equal(recording.starts.length, 0);
  });

  it('starts no check-attr when no path survives the extension filter', async (t) => {
    const { repo, recording, tree } = await realTree(t, { files: { 'a.md': 'a\n' } });
    const { files } = await tree.snapshot(repo.dir);
    recording.reset();
    const result = await tree.sourceSet(repo.dir, files, OPTIONS);
    assert.equal(result.files.size, 0);
    assert.equal(recording.starts.length, 0);
    assert.deepEqual(codes(result.skipped).map((c) => c.split(':')[0]), ['extension_not_claimed']);
  });

  it('inspects at most the first 8 KB (binary), compares the cap to the file size and detects an LFS pointer by its first line', async (t) => {
    const { repo, tree } = await realTree(t, {
      files: {
        'nul-at-8191.ts': `${'x'.repeat(8191)}\0`,
        'nul-at-8192.ts': `${'x'.repeat(8192)}\0`,
        'exactly-cap.ts': 'e'.repeat(1000),
        'one-over.ts': 'o'.repeat(1001),
        'pointer-lookalike.ts': 'see version https://git-lfs.github.com/spec/v1 in the docs\n',
      },
    });
    const { files } = await tree.snapshot(repo.dir);
    const roomy = await tree.sourceSet(repo.dir, files, { extensions: ['.ts'], maxBytes: 9000 });
    assert.deepEqual([...roomy.files.keys()], ['exactly-cap.ts', 'nul-at-8192.ts', 'one-over.ts', 'pointer-lookalike.ts']);
    assert.deepEqual(codes(roomy.skipped), ['binary_skipped:nul-at-8191.ts']);
    const tight = await tree.sourceSet(repo.dir, files, { extensions: ['.ts'], maxBytes: 1000 });
    assert.deepEqual([...tight.files.keys()], ['exactly-cap.ts', 'pointer-lookalike.ts']);
    assert.deepEqual(codes(tight.skipped), [
      'source_too_large:nul-at-8191.ts',
      'source_too_large:nul-at-8192.ts',
      'source_too_large:one-over.ts',
    ]);
  });

  it(
    'reports symlink_skipped for a file replaced by a link after listing and keeps the rest',
    { skip: notOnWindows('creating a symlink needs privileges on Windows') },
    async (t) => {
      const { repo, tree } = await realTree(t, { files: { 'a.ts': 'a\n', 'b.ts': 'b\n', 'real.ts': 'r\n' } });
      const { files } = await tree.snapshot(repo.dir);
      repo.remove('a.ts');
      fs.symlinkSync('real.ts', path.join(repo.dir, 'a.ts'));
      repo.remove('b.ts');
      const result = await tree.sourceSet(repo.dir, files, OPTIONS);
      assert.deepEqual([...result.files.keys()], ['real.ts']);
      assert.deepEqual(codes(result.skipped), ['missing_on_disk:b.ts', 'symlink_skipped:a.ts']);
    },
  );

  it('rejects a name that cannot be inspected safely with unhashable_path and keeps the rest', async (t) => {
    const { repo, tree } = await realTree(t, { files: { 'a.ts': 'a\n' } });
    const { files } = await tree.snapshot(repo.dir);
    const result = await tree.sourceSet(repo.dir, new Map([...files, ['../escape.ts', '1'.repeat(40)], ['"q".ts', '2'.repeat(40)]]), OPTIONS);
    assert.deepEqual([...result.files.keys()], ['a.ts']);
    assert.deepEqual(codes(result.skipped), ['unhashable_path:"q".ts', 'unhashable_path:../escape.ts']);
  });

  it('fails closed when git check-attr fails or returns fewer records than asked', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.ts': 'a\n' } });
    t.after(() => repo.cleanup());
    for (const answer of [{ exitCode: 128 }, { stdout: '' }]) {
      const recording = createRecordingRunner({ respond: () => answer });
      const tree = createSourceTree({ runner: recording, repoDir: repo.dir });
      await assert.rejects(() => tree.sourceSet(repo.dir, new Map([['a.ts', '1'.repeat(40)]]), OPTIONS), { code: 'git_failed' });
    }
  });
});

describe('parseWorktreeList', () => {
  const z = (...fields: string[]): string => fields.map((f) => `${f}\0`).join('');

  it('groups NUL-separated fields into records and handles bare, locked (with and without a reason) and prunable', () => {
    const output =
      z('worktree /repo with space/é', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '') +
      z('worktree /bare.git', 'bare', '') +
      z('worktree /detached', 'HEAD ' + 'b'.repeat(40), 'detached', 'locked', '') +
      z('worktree /why', 'HEAD ' + 'c'.repeat(40), 'branch refs/heads/feature/x', 'locked on a usb stick', 'prunable gitdir file points to non-existent location', '') +
      z('worktree /unborn', 'HEAD ' + '0'.repeat(40), 'branch refs/heads/main', '');
    assert.deepEqual(parseWorktreeList(output), [
      { path: '/repo with space/é', head: 'a'.repeat(40), branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/bare.git', head: null, branch: null, detached: false, bare: true, locked: false, prunable: false },
      { path: '/detached', head: 'b'.repeat(40), branch: null, detached: true, bare: false, locked: true, prunable: false },
      { path: '/why', head: 'c'.repeat(40), branch: 'feature/x', detached: false, bare: false, locked: true, prunable: true },
      { path: '/unborn', head: null, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    ]);
  });

  it('does not depend on field order after the record start and ignores unknown fields and an empty output', () => {
    assert.deepEqual(parseWorktreeList(''), []);
    const output = z('worktree /w', 'future-field value', 'detached', 'HEAD ' + 'd'.repeat(40), '');
    assert.deepEqual(parseWorktreeList(output), [
      { path: '/w', head: 'd'.repeat(40), branch: null, detached: true, bare: false, locked: false, prunable: false },
    ]);
  });
});

describe('real Source Tree worktrees and identity', () => {
  it('lists the main worktree and each linked one (detached, on a branch, locked, prunable) with canonical real paths', async (t) => {
    const { repo, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    const base = path.dirname(repo.dir);
    const detachedDir = path.join(base, 'wt detached é');
    const branchDir = path.join(base, 'wt-branch');
    const goneDir = path.join(base, 'wt-gone');
    await repo.git(['worktree', 'add', '--quiet', '--detach', detachedDir]);
    await repo.git(['worktree', 'add', '--quiet', '-b', 'feature/x', branchDir]);
    await repo.git(['worktree', 'lock', branchDir, '--reason', 'on a usb stick']);
    await repo.git(['worktree', 'add', '--quiet', '--detach', goneDir]);
    fs.rmSync(goneDir, { recursive: true, force: true });

    const list = await tree.worktrees();
    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
    const real = (p: string): string => fs.realpathSync.native(p);
    // git lists the main worktree first; the order of the linked ones is git's, so look them up by path.
    const byPath = new Map(list.map((w) => [w.path, w]));
    assert.equal(list.length, 4);
    assert.deepEqual(list[0], { path: real(repo.dir), head, branch: 'main', detached: false, bare: false, locked: false, prunable: false });
    assert.deepEqual(byPath.get(real(detachedDir)), { path: real(detachedDir), head, branch: null, detached: true, bare: false, locked: false, prunable: false });
    assert.deepEqual(byPath.get(real(branchDir)), { path: real(branchDir), head, branch: 'feature/x', detached: false, bare: false, locked: true, prunable: false });
    assert.equal(byPath.get(goneDir)?.prunable, true, 'a directory that no longer exists is kept as given and marked prunable');
  });

  it('names git 2.36 when the -z form is not understood', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    const recording = createRecordingRunner({ respond: () => ({ exitCode: 129, stderr: 'usage: git worktree list [-v | --porcelain]' }) });
    const tree = createSourceTree({ runner: recording, repoDir: repo.dir });
    await assert.rejects(() => tree.worktrees(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'git_failed');
      assert.match(error.message, /git 2\.36/);
      return true;
    });
  });

  it('starts one git run for worktrees() with the approved timeout (git.timeoutMs 60000)', async (t) => {
    const { recording, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    await tree.worktrees();
    assert.deepEqual(recording.starts.map(subcommand), ['worktree']);
    assert.equal(recording.starts[0]?.timeoutMs, 60000);
    assert.deepEqual(recording.starts[0]?.args.slice(-3), ['list', '--porcelain', '-z']);
  });

  it('identity.commonDir is the canonical real path of the common git directory', async (t) => {
    const { repo, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    assert.equal((await tree.identity()).commonDir, fs.realpathSync.native(path.join(repo.dir, '.git')));
  });
});

describe('real Source Tree readText', () => {
  it('reads inside a linked worktree and decodes invalid UTF-8 without throwing', async (t) => {
    const { repo, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    repo.write('bad.txt', new Uint8Array([0xff, 0x41]));
    assert.deepEqual(await tree.readText(repo.dir, 'bad.txt'), { kind: 'ok', text: '�A' });
    const linked = path.join(path.dirname(repo.dir), 'wt-read');
    await repo.git(['worktree', 'add', '--quiet', '--detach', linked]);
    assert.deepEqual(await tree.readText(linked, 'a.txt'), { kind: 'ok', text: 'a\n' });
  });

  it(
    'refuses a final-component link (not_file) and a path through a symlinked directory that leaves the worktree (escape)',
    { skip: notOnWindows('creating a symlink needs privileges on Windows') },
    async (t) => {
      const { repo, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
      const outside = path.join(path.dirname(repo.dir), 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
      fs.symlinkSync(outside, path.join(repo.dir, 'linkdir'));
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo.dir, 'link-out.txt'));
      fs.symlinkSync('a.txt', path.join(repo.dir, 'link-in.txt'));
      assert.deepEqual(await tree.readText(repo.dir, 'linkdir/secret.txt'), { kind: 'escape' });
      assert.deepEqual(await tree.readText(repo.dir, 'link-out.txt'), { kind: 'not_file' });
      assert.deepEqual(await tree.readText(repo.dir, 'link-in.txt'), { kind: 'not_file' });
      assert.deepEqual(await tree.readText(repo.dir, 'a.txt'), { kind: 'ok', text: 'a\n' });
    },
  );

  it('starts no git', async (t) => {
    const { repo, recording, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    await tree.readText(repo.dir, 'a.txt');
    await tree.readText(repo.dir, '../x');
    assert.equal(recording.starts.length, 0);
  });
});

describe('fake Source Tree worktrees', () => {
  it('returns the worktrees the world describes, and a single main entry when it describes none', async () => {
    const linked = { path: '/w/linked', head: 'e'.repeat(40), branch: null, detached: true, bare: false, locked: false, prunable: false };
    assert.deepEqual(await createFakeSourceTree({ worktrees: [linked] }).worktrees(), [linked]);
    assert.equal((await createFakeSourceTree({}).worktrees()).length, 1);
  });
});

describe('real Source Tree hashPaths', () => {
  it('hashes a CRLF file under `*.ts text eol=lf` to the id git stores (CRLF case)', async (t) => {
    const { repo, tree } = await realTree(t, { files: { '.gitattributes': '*.ts text eol=lf\n' } });
    repo.write('crlf.ts', 'one\r\ntwo\r\n');
    const { files, diagnostics } = await tree.hashPaths(repo.dir, ['crlf.ts']);
    assert.deepEqual(diagnostics, []);
    assert.equal(files.get('crlf.ts'), blobId('one\ntwo\n'));
    await repo.git(['add', 'crlf.ts']);
    assert.equal(files.get('crlf.ts'), (await repo.git(['rev-parse', ':crlf.ts'])).trim());
  });

  it('starts git exactly twice for N paths (filter enumeration, one batched hash) and hashes duplicates once', async (t) => {
    const { repo, recording, tree } = await realTree(t, {
      files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
    });
    const { files } = await tree.hashPaths(repo.dir, ['c.txt', 'a.txt', 'b.txt', 'a.txt']);
    assert.deepEqual([...files.keys()], ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(recording.starts.length, 2, recording.starts.map((s) => subcommand(s)).join(','));
    assert.deepEqual(recording.starts.map(subcommand), ['config', 'hash-object']);
    const [, hash] = recording.starts;
    assert.deepEqual(String(hash?.stdin).split('\n').filter((l) => l !== ''), ['a.txt', 'b.txt', 'c.txt']);
  });

  it('starts no git for an empty list, and no hash run when nothing in the list can be hashed', async (t) => {
    const { repo, recording, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    assert.equal((await tree.hashPaths(repo.dir, [])).files.size, 0);
    assert.equal(recording.starts.length, 0);
    const { files, diagnostics } = await tree.hashPaths(repo.dir, ['no/such.txt']);
    assert.equal(files.size, 0);
    assert.deepEqual(codes(diagnostics), ['missing_on_disk:no/such.txt']);
    assert.equal(hashStarts(recording), 0);
  });

  it('carries the approved git timeouts from 02-CONSTANTS.md on its specs (git.timeoutMs 60000, git.hashBatchTimeoutMs 120000)', async (t) => {
    const { repo, recording, tree } = await realTree(t, { files: { 'a.txt': 'a\n' } });
    await tree.hashPaths(repo.dir, ['a.txt']);
    const hash = recording.starts.find((s) => subcommand(s) === 'hash-object');
    assert.equal(hash?.timeoutMs, 120000);
    await tree.snapshot(repo.dir);
    const listings = recording.starts.filter((s) => subcommand(s) === 'ls-files');
    assert.ok(listings.length > 0);
    assert.ok(listings.every((s) => s.timeoutMs === 60000));
  });

  it('throws hash_output_mismatch when git returns a different number of ids than paths', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    t.after(() => repo.cleanup());
    const lying = createRecordingRunner({
      respond: (spec) => (subcommand(spec) === 'config' ? { stdout: probeListing(spec) } : { stdout: `${'3'.repeat(40)}\n` }),
    });
    const tree = createSourceTree({ runner: lying, repoDir: repo.dir });
    await assert.rejects(() => tree.hashPaths(repo.dir, ['a.txt', 'b.txt']), { code: 'hash_output_mismatch' });
  });

  it('fails closed: a failed filter enumeration rejects hashPaths and starts no hash-object', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    const recording = createRecordingRunner({ respond: (spec) => (subcommand(spec) === 'config' ? { exitCode: 128 } : { stdout: '' }) });
    const tree = createSourceTree({ runner: recording, repoDir: repo.dir });
    await assert.rejects(() => tree.hashPaths(repo.dir, ['a.txt']), { code: 'filter_enumeration_failed' });
    assert.equal(hashStarts(recording), 0);
  });
});

describe('real Source Tree history reads (STO-09)', () => {
  const names = Array.from({ length: 40 }, (_, i) => `src/file${String(i)}.ts`);
  const world = Object.fromEntries(names.map((n) => [n, `export const v = '${n}';\n`]));

  it('reads a historical blob and many more through exactly one cat-file --batch start, with the vetted commit:path lines on stdin', async (t) => {
    const { repo, recording, tree } = await realTree(t, { files: world });
    const commit = await tree.resolveCommit('HEAD');
    assert.ok(commit !== null);
    repo.write(names[0] as string, 'export const edited = 1;\n');
    await repo.commitAll('edit');
    recording.reset();

    const { blobs } = await tree.readMany(commit, names);
    assert.equal(blobs.size, names.length);
    assert.equal(Buffer.from(blobs.get(names[0] as string) ?? new Uint8Array()).toString('utf8'), world[names[0] as string]);
    const batches = recording.starts.filter((s) => subcommand(s) === 'cat-file');
    assert.equal(batches.length, 1);
    assert.equal(recording.starts.length, 1, recording.starts.map((s) => subcommand(s)).join(','));
    assert.ok(batches[0]?.args.includes('--batch'));
    assert.equal(batches[0]?.timeoutMs, 120000);
    const lines = String(batches[0]?.stdin).split('\n').filter((l) => l !== '');
    assert.ok(lines.includes(`${commit}:${names[1] as string}`));
    assert.equal(recording.denials.length, 0);
  });

  it('starts no git for an empty path list and none for an option-like or NUL revision', async (t) => {
    const { recording, tree } = await realTree(t, { files: { 'a.ts': 'a\n' } });
    assert.equal((await tree.readMany('f'.repeat(40), [])).blobs.size, 0);
    await assert.rejects(() => tree.resolveCommit('--output=x'), { code: 'invalid_argument' });
    await assert.rejects(() => tree.resolveCommit('a\0b'), { code: 'invalid_argument' });
    await assert.rejects(() => tree.listTree('--x'), { code: 'invalid_argument' });
    assert.equal(recording.starts.length, 0);
  });

  it('pins lazy fetch and transport off on every history spec', async (t) => {
    const { recording, tree } = await realTree(t, { files: { 'a.ts': 'a\n' } });
    const commit = await tree.resolveCommit('HEAD');
    assert.ok(commit !== null);
    await tree.listTree(commit);
    await tree.readMany(commit, ['a.ts']);
    assert.equal(recording.starts.length, 3);
    for (const s of recording.starts) {
      assert.equal(s.env?.['GIT_NO_LAZY_FETCH'], '1');
      assert.equal(s.env?.['GIT_ALLOW_PROTOCOL'], 'none');
    }
    assert.ok(recording.starts.every((s) => !['fetch', 'pull', 'clone', 'remote'].includes(subcommand(s) ?? '')));
  });

  it('parses a header-and-body stream binary-safely even when a body contains header-looking lines and newlines', async (t) => {
    const tricky = Buffer.from(`${'0'.repeat(40)} blob 3\nabc\n${'1'.repeat(40)} missing\n`);
    const oid = (c: string): string => c.repeat(40);
    const stream = Buffer.concat([
      Buffer.from(`${oid('a')} commit 4\nroot\n`),
      Buffer.from(`${oid('b')} blob ${String(tricky.length)}\n`),
      tricky,
      Buffer.from('\n'),
      Buffer.from('HEAD:gone.ts missing\n'),
    ]);
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.ts': 'a\n' } });
    t.after(() => repo.cleanup());
    const fake = createRecordingRunner({ respond: () => ({ stdout: stream }) });
    const tree = createSourceTree({ runner: fake, repoDir: repo.dir, envOverlay: repo.envOverlay });
    const { blobs } = await tree.readMany('HEAD', ['tricky.ts', 'gone.ts']);
    assert.deepEqual(Buffer.from(blobs.get('tricky.ts') ?? new Uint8Array()), tricky);
    assert.equal(blobs.get('gone.ts'), null);
  });

  it('throws git_failed when the batch output is shorter than the request', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, files: { 'a.ts': 'a\n' } });
    t.after(() => repo.cleanup());
    const fake = createRecordingRunner({ respond: () => ({ stdout: `${'a'.repeat(40)} commit 0\n\n` }) });
    const tree = createSourceTree({ runner: fake, repoDir: repo.dir, envOverlay: repo.envOverlay });
    await assert.rejects(() => tree.readMany('HEAD', ['a.ts']), { code: 'git_failed' });
  });
});
