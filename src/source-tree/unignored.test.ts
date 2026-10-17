/**
 * `SourceTree.unignoredPaths` against real git (plan 02-46): the ignore check is one pathspec-free
 * `ls-files -z --cached --others --exclude-standard` listing filtered in process by exact name. These tests pin the
 * verdict to the old oracle (`snapshot()`), the exact-name rule, the spec that reaches git and the failure semantics.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { RecordingRunner, ScriptedResult } from '../command-runner/index.ts';
import { diagnostic } from '../facts/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { createSourceTree } from './index.ts';
import type { SourceTree } from './index.ts';

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

const sorted = (set: Iterable<string>): string[] => [...set].sort();

/** True on the operating systems whose file names cannot hold `?`, `*` or `:`. */
const RESTRICTED_NAMES = process.platform === 'win32';

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommandOf = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

interface RichRepo {
  readonly repo: TempGitRepo;
  /** True when this run could create a symbolic link on disk (Windows may refuse without privileges). */
  readonly symlink: boolean;
}

/**
 * A repository with every category the ignore check meets: tracked, untracked, ignored (by pattern and by directory),
 * a `.gitignore` negation, a tracked file that is also ignored, a nested repository, a gitlink over a directory that
 * also holds a file, a symbolic link, a directory and names git or a shell could misread.
 */
async function richRepo(t: { after(fn: () => void): void }): Promise<RichRepo> {
  const committed: Record<string, string> = {
    '.gitignore': '*.log\n!keep.log\nbuild/\n',
    'tracked.ts': 'export const tracked = 1;\n',
    'dir/inner.ts': 'export const inner = 1;\n',
    'sp ace.ts': 'export const space = 1;\n',
    'a[1].ts': 'export const bracket = 1;\n',
    'a1.ts': 'export const a1 = 1;\n',
    'ünï-ç.ts': 'export const unicode = 1;\n',
    '-leading.ts': 'export const leading = 1;\n',
  };
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed } });
  t.after(() => repo.cleanup());
  // Tracked although a pattern ignores it: only `add -f` can put it in the index.
  repo.write('forced.log', 'tracked but ignored\n');
  await repo.git(['add', '-f', 'forced.log']);
  await repo.git(['commit', '--quiet', '--no-verify', '-m', 'forced']);

  repo.write('untracked.ts', 'export const untracked = 1;\n');
  repo.write('keep.log', 'negated by !keep.log\n');
  repo.write('drop.log', 'ignored by *.log\n');
  repo.write('build/out.js', 'inside an ignored directory\n');
  repo.write('deep/er/c.ts', 'nested untracked\n');
  if (!RESTRICTED_NAMES) {
    repo.write('x?y.ts', 'export const question = 1;\n');
    repo.write('*.ts', 'export const star = 1;\n');
    repo.write(':(top)odd.ts', 'export const magic = 1;\n');
  }
  repo.write('vendor/sub/inner.ts', 'export const insideGitlink = 1;\n');
  const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await repo.git(['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`]);
  const init = await setupRunner.run({ executable: 'git', args: ['init', '--quiet', 'nested'], cwd: repo.dir, env: repo.envOverlay });
  assert.equal(init.ok, true, 'nested repository');
  repo.write('nested/file.ts', 'export const insideNested = 1;\n');
  fs.mkdirSync(path.join(repo.dir, 'empty-dir'));
  let symlink = true;
  try {
    fs.symlinkSync('tracked.ts', path.join(repo.dir, 'link.ts'));
  } catch {
    symlink = false;
  }
  return { repo, symlink };
}

function treeOver(repo: TempGitRepo, runner = createRealRunner()): SourceTree {
  return createSourceTree({ runner, repoDir: repo.dir, envOverlay: repo.envOverlay });
}

/** Every entry below `root` (files and directories, POSIX relative names), without descending into `.git`. */
function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    out.push(child);
    if (entry.isDirectory()) out.push(...walk(root, child));
  }
  return out;
}

const isRegularFile = (root: string, rel: string): boolean => {
  try {
    return fs.lstatSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
};

describe('unignoredPaths against real git', () => {
  it('categories', async (t) => {
    const { repo } = await richRepo(t);
    const tree = treeOver(repo);
    const asked = [
      'tracked.ts', // tracked
      'dir/inner.ts', // tracked, in a directory
      'untracked.ts', // untracked, not ignored
      'deep/er/c.ts', // untracked in an untracked directory
      'keep.log', // untracked, matches a .gitignore negation
      'forced.log', // tracked although a pattern ignores it
      'drop.log', // ignored by pattern
      'build/out.js', // inside an ignored directory
      'dir', // a directory
      'nested', // a nested repository (listed as `nested/`)
      'nested/file.ts', // inside the nested repository
      'vendor/sub', // a gitlink (listed through --cached)
      'vendor/sub/inner.ts', // inside the gitlink directory
      'empty-dir',
      'no/such.ts', // does not exist and is not tracked
    ];
    const listed = await tree.unignoredPaths(repo.dir, asked);
    assert.deepEqual(sorted(listed), ['deep/er/c.ts', 'dir/inner.ts', 'forced.log', 'keep.log', 'tracked.ts', 'untracked.ts', 'vendor/sub']);
  });

  it('parity with the snapshot', async (t) => {
    const { repo, symlink } = await richRepo(t);
    const tree = treeOver(repo);
    const everything = walk(repo.dir);
    assert.ok(everything.length > 20, 'the repository holds the categories');
    assert.ok(!symlink || everything.includes('link.ts'), 'the link is on disk');

    const listed = await tree.unignoredPaths(repo.dir, everything);
    const { files } = await tree.snapshot(repo.dir);
    const disagreements: string[] = [];
    for (const rel of everything) {
      const now = listed.has(rel) && isRegularFile(repo.dir, rel);
      const before = files.has(rel);
      if (now !== before) disagreements.push(`${rel}: unignoredPaths+lstat says ${String(now)}, snapshot says ${String(before)}`);
    }
    assert.deepEqual(disagreements, []);
    // The explicit categories behind the parity, so a vacuous pass cannot hide a regression.
    for (const kept of ['tracked.ts', 'untracked.ts', 'keep.log', 'forced.log', 'dir/inner.ts']) assert.ok(files.has(kept), kept);
    for (const dropped of ['drop.log', 'build/out.js', 'dir', 'empty-dir']) assert.ok(!files.has(dropped), dropped);
  });

  it('gitlink and nested repository parity', async (t) => {
    const { repo, symlink } = await richRepo(t);
    const tree = treeOver(repo);
    const listed = await tree.unignoredPaths(repo.dir, ['vendor/sub', 'vendor/sub/inner.ts', 'nested', 'nested/file.ts', 'link.ts']);
    const { files, diagnostics } = await tree.snapshot(repo.dir);

    // The gitlink path is a --cached entry, so it is listed; the old `-s` listing skipped mode 160000, and the
    // regular-file test of the caller is what drops it: lstat says directory.
    assert.ok(listed.has('vendor/sub'), 'the gitlink path is listed');
    assert.equal(fs.lstatSync(path.join(repo.dir, 'vendor/sub')).isDirectory(), true);
    assert.equal(files.has('vendor/sub'), false);
    // Files inside a registered gitlink directory are named by neither listing.
    assert.equal(listed.has('vendor/sub/inner.ts'), false);
    assert.equal(files.has('vendor/sub/inner.ts'), false);
    // An untracked nested repository is one `nested/` entry: it is never named `nested`, and nothing in it is listed.
    assert.equal(listed.has('nested'), false);
    assert.equal(listed.has('nested/file.ts'), false);
    assert.equal(files.has('nested/file.ts'), false);
    assert.ok(
      diagnostics.some((d) => d.code === 'gitlink_skipped' && d.subject === 'nested'),
      'the snapshot reports the nested repository',
    );
    // A symbolic link is a tracked-or-untracked name but never a regular file.
    if (symlink) {
      assert.equal(files.has('link.ts'), false);
      assert.equal(isRegularFile(repo.dir, 'link.ts'), false);
    }
  });

  it('exact names, no patterns', async (t) => {
    const { repo } = await richRepo(t);
    const recorder = createRecordingRunner({ delegate: createRealRunner() });
    const tree = treeOver(repo, recorder);

    // A bracket, a question mark, a space, a non-ASCII letter, a leading dash and a magic pathspec are plain names.
    const weird = ['a[1].ts', 'sp ace.ts', 'ünï-ç.ts', '-leading.ts'];
    if (!RESTRICTED_NAMES) weird.push('x?y.ts', '*.ts', ':(top)odd.ts');
    for (const name of weird) {
      assert.deepEqual(sorted(await tree.unignoredPaths(repo.dir, [name])), [name], name);
    }
    // Asking one name never returns a sibling the same text could match as a pattern.
    assert.equal((await tree.unignoredPaths(repo.dir, ['a[1].ts'])).has('a1.ts'), false);
    assert.deepEqual(sorted(await tree.unignoredPaths(repo.dir, ['a1.ts'])), ['a1.ts']);
    // Pattern text with no file of that exact name returns nothing.
    const patterns = ['a?.ts', 'a[0-9].ts', '**/*.ts', ':(top)tracked.ts', ':(glob)dir/*.ts', ':(literal)tracked.ts', '[tracked].ts', 'dir/**'];
    assert.equal((await tree.unignoredPaths(repo.dir, patterns)).size, 0);

    // The spec that reaches git is the same fixed list of tokens for every request, with nothing on stdin.
    const listings = recorder.starts.filter((s) => subcommandOf(s) === 'ls-files');
    assert.equal(listings.length, recorder.starts.length, 'only the listing was started');
    const [first] = listings;
    assert.ok(first !== undefined);
    for (const each of listings) {
      assert.deepEqual(each.args, first.args);
      assert.deepEqual(each.env, first.env);
      assert.equal(each.stdin, undefined, 'no name on stdin');
    }
    const tokens = first.args.slice(first.args.indexOf('ls-files'));
    assert.deepEqual(tokens, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    for (const name of [...weird, ...patterns]) {
      assert.ok(
        first.args.every((arg) => arg !== name && !arg.includes(name)),
        `${name} must not appear in an argument`,
      );
    }
  });

  it('case folding on a case-folding file system', async (t) => {
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: { 'src/Foo.ts': 'export const foo = 1;\n' } } });
    t.after(() => repo.cleanup());
    const folds = fs.existsSync(path.join(repo.dir, 'src', 'foo.ts'));
    if (!folds) {
      t.skip('the file system does not fold case; the scripted variant covers the comparison');
      return;
    }
    const tree = treeOver(repo);
    // The new verdict equals the old one: git lists the index spelling, and only that spelling is "not ignored".
    const listed = await tree.unignoredPaths(repo.dir, ['src/foo.ts', 'src/Foo.ts']);
    assert.deepEqual(sorted(listed), ['src/Foo.ts']);
    const { files } = await tree.snapshot(repo.dir);
    assert.equal(files.has('src/foo.ts'), false);
    assert.equal(files.has('src/Foo.ts'), true);
  });

  it('case folding with a different index spelling', async (t) => {
    // The index spells the file `src/Foo.ts`; the disk (as on a case-folding file system) holds `src/foo.ts`.
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const root = realPath(tmp.path);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    const runner = scripted((s) => (s.args.includes('--cached') ? { stdout: 'src/Foo.ts\0' } : undefined));
    const tree = createSourceTree({ runner, repoDir: root });

    const listed = await tree.unignoredPaths(root, ['src/foo.ts', 'src/Foo.ts']);
    assert.deepEqual(sorted(listed), ['src/Foo.ts']);
    assert.equal(runner.starts.length, 1);
  });

  it('refused paths start no git', async (t) => {
    const { repo } = await richRepo(t);
    const recorder = createRecordingRunner({ delegate: createRealRunner() });
    const tree = treeOver(repo, recorder);
    for (const bad of ['../outside.ts', '/abs/path.ts', 'a/../../b.ts', 'a\0b', '', 'C:drive.ts', '..']) {
      await assert.rejects(() => tree.unignoredPaths(repo.dir, [bad]), { code: 'invalid_argument' }, JSON.stringify(bad));
      await assert.rejects(() => tree.unignoredPaths(repo.dir, ['tracked.ts', bad]), { code: 'invalid_argument' }, JSON.stringify(bad));
    }
    assert.equal(recorder.starts.length, 0, 'no git started for a refused request');
    assert.equal(recorder.denials.length, 0);
    // An empty list starts no git either.
    assert.equal((await tree.unignoredPaths(repo.dir, [])).size, 0);
    assert.equal(recorder.starts.length, 0);
  });

  it('a failed listing is git_failed and changes nothing', async () => {
    const denied = { allowed: false, diagnostic: diagnostic('command_denied', 'error', 'refused for the test', 'git') } as const;
    const failures: Array<[string, RecordingRunner]> = [
      ['exit 128', scripted(() => ({ exitCode: 128, stderr: 'fatal: not a git repository' }))],
      ['output over the cap', scripted(() => ({ truncated: true, stdout: 'a.ts\0' }))],
      ['timeout', scripted(() => ({ timedOut: true, exitCode: null }))],
      ['denial', createRecordingRunner({ decide: () => denied })],
    ];
    for (const [label, runner] of failures) {
      const tree = createSourceTree({ runner, repoDir: '/nowhere' });
      await assert.rejects(() => tree.unignoredPaths('/nowhere', ['a.ts']), { code: 'git_failed' }, label);
    }
  });
});

/** A recording runner (production rule) that answers every allowed run from `respond`, and succeeds with no output otherwise. */
function scripted(respond: (spec: { readonly args: readonly string[] }) => ScriptedResult | undefined): RecordingRunner {
  return createRecordingRunner({ respond: (spec) => respond(spec) });
}
