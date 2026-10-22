/**
 * `.atlasignore` (quick task 261021-re7, D-02 and D-04): the vetting of a repository-supplied ignore file, the fixed
 * notes, the fake's small rule set, and the cases only the real tree can answer because they need git's full syntax or
 * a failing git. The trust-boundaries ADR and ADR 5 amendments of 2026-10-21 describe the feature.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { CommandResult, CommandRunner, RecordingRunner } from '../command-runner/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempGitRepo, TempGitRepoOptions } from '../test-kit/index.ts';
import { exclusionNotes, vetAtlasignore } from './atlasignore.ts';
import { ATLASIGNORE_MAX_BYTES, defaultPatterns } from './default-excludes.ts';
import { ignoredByRuleFiles, parseRuleFile } from './fake-rules.ts';
import { createFakeSourceTree, createSourceTree } from './index.ts';

const setupRunner = createRealRunner({ decide: allowAll });
const notOnWindows = (why: string): string | false => (process.platform === 'win32' ? why : false);

/** The values that follow `--exclude` tokens in an argument list. */
const excludeValues = (args: readonly string[]): string[] => args.flatMap((arg, i) => (args[i - 1] === '--exclude' ? [arg] : []));

const subcommand = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

describe('exclusionNotes: fixed wording, no path', () => {
  it('says nothing when nothing was left out and the file was usable', () => {
    assert.deepEqual(exclusionNotes({ byDefaults: 0, byAtlasignore: 0 }, false), []);
  });

  it('reports each count once, singular and plural, defaults first, as info without a subject', () => {
    const [one, two] = exclusionNotes({ byDefaults: 1, byAtlasignore: 2 }, false);
    assert.deepEqual(one, {
      code: 'index_excluded_by_defaults',
      severity: 'info',
      message: '1 file was left out of the index by the built-in tooling and build-output exclusions',
    });
    assert.deepEqual(two, {
      code: 'index_excluded_by_atlasignore',
      severity: 'info',
      message: '2 files were left out of the index by .atlasignore',
    });
    const [plural] = exclusionNotes({ byDefaults: 3, byAtlasignore: 0 }, false);
    assert.equal(plural?.message, '3 files were left out of the index by the built-in tooling and build-output exclusions');
    const [single] = exclusionNotes({ byDefaults: 0, byAtlasignore: 1 }, false);
    assert.equal(single?.message, '1 file was left out of the index by .atlasignore');
  });

  it('reports an unusable file with one warning, last, whatever the counts', () => {
    const notes = exclusionNotes({ byDefaults: 2, byAtlasignore: 0 }, true);
    assert.deepEqual(notes.map((n) => n.code), ['index_excluded_by_defaults', 'atlasignore_unusable']);
    assert.deepEqual(notes[1], {
      code: 'atlasignore_unusable',
      severity: 'warning',
      message: 'a .atlasignore file was not used: it is larger than 64 KiB in total, is not valid text, or is not a regular file',
    });
  });
});

describe('vetAtlasignore: a repository-supplied file is untrusted data (D-04)', () => {
  const dirWith = (t: TestContext, files: Readonly<Record<string, string | Uint8Array>>): string => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const root = realPath(tmp.path);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
  };
  const listed = (...paths: string[]) => paths.map((p) => ({ path: p }));

  it('is "none" when no listed path is named .atlasignore, or the listed file is not on disk', async (t) => {
    const root = dirWith(t, { 'a.ts': 'x\n' });
    assert.equal(await vetAtlasignore(root, listed('a.ts', 'my.atlasignore', '.atlasignore.bak', 'dir/x.ts')), 'none');
    assert.equal(await vetAtlasignore(root, listed('.atlasignore')), 'none', 'a deleted tracked file has nothing to read');
  });

  it('is "usable" for a root file, a nested file and text with a byte order mark and CRLF endings', async (t) => {
    const root = dirWith(t, { '.atlasignore': '﻿build-out\r\n*.snap\r\n', 'sub/.atlasignore': 'x\n' });
    assert.equal(await vetAtlasignore(root, listed('.atlasignore')), 'usable');
    assert.equal(await vetAtlasignore(root, listed('.atlasignore', 'sub/.atlasignore')), 'usable');
  });

  it('allows exactly 64 KiB in total and refuses one byte more', async (t) => {
    assert.equal(ATLASIGNORE_MAX_BYTES, 65536);
    const root = dirWith(t, { 'ok/.atlasignore': 'a'.repeat(ATLASIGNORE_MAX_BYTES), 'big/.atlasignore': 'a'.repeat(ATLASIGNORE_MAX_BYTES + 1) });
    assert.equal(await vetAtlasignore(root, listed('ok/.atlasignore')), 'usable');
    assert.equal(await vetAtlasignore(root, listed('big/.atlasignore')), 'unusable');
  });

  it('counts the bytes of all files together: two files of 40,000 bytes are refused, one is fine', async (t) => {
    const root = dirWith(t, { 'a/.atlasignore': 'a'.repeat(40000), 'b/.atlasignore': 'b'.repeat(40000) });
    assert.equal(await vetAtlasignore(root, listed('a/.atlasignore')), 'usable');
    assert.equal(await vetAtlasignore(root, listed('a/.atlasignore', 'b/.atlasignore')), 'unusable');
  });

  it('refuses a NUL byte and bytes that are not valid UTF-8', async (t) => {
    const root = dirWith(t, {
      'nul/.atlasignore': 'x\n\0\n',
      'bad/.atlasignore': Uint8Array.from([0x78, 0x0a, 0xff, 0xfe, 0x0a]),
      'good/.atlasignore': 'grüße.txt\n',
    });
    assert.equal(await vetAtlasignore(root, listed('nul/.atlasignore')), 'unusable');
    assert.equal(await vetAtlasignore(root, listed('bad/.atlasignore')), 'unusable');
    assert.equal(await vetAtlasignore(root, listed('good/.atlasignore')), 'usable');
  });

  it('refuses a directory named .atlasignore (a listed path below it) and a tracked link or submodule mode, without reading', async (t) => {
    const root = dirWith(t, { 'ok/.atlasignore': 'x\n' });
    assert.equal(await vetAtlasignore(root, listed('.atlasignore/inner.txt')), 'unusable');
    assert.equal(await vetAtlasignore(root, listed('sub/.atlasignore/deep/inner.txt')), 'unusable');
    assert.equal(await vetAtlasignore(root, [{ path: 'ok/.atlasignore', mode: '120000' }]), 'unusable');
    assert.equal(await vetAtlasignore(root, [{ path: 'ok/.atlasignore', mode: '160000' }]), 'unusable');
    assert.equal(await vetAtlasignore(root, [{ path: 'ok/.atlasignore', mode: '100644' }]), 'usable');
  });

  it(
    'refuses a link on disk and never reads what it points to',
    { skip: notOnWindows('creating a symlink needs privileges on Windows') },
    async (t) => {
      const root = dirWith(t, { 'outside/rules.txt': 'secret.ts\n', 'outside/.atlasignore': 'secret.ts\n', 'repo/a.ts': 'x\n' });
      fs.symlinkSync(path.join(root, 'outside', 'rules.txt'), path.join(root, 'repo', '.atlasignore'));
      assert.equal(await vetAtlasignore(path.join(root, 'repo'), listed('.atlasignore')), 'unusable');
      // A link that points outside the worktree through a directory is refused too.
      fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'repo', 'linkdir'));
      assert.equal(await vetAtlasignore(path.join(root, 'repo'), listed('linkdir/.atlasignore')), 'unusable');
    },
  );

  it('never throws', async () => {
    assert.equal(await vetAtlasignore('/no/such/worktree', listed('.atlasignore')), 'none');
    assert.equal(await vetAtlasignore('/no/such/worktree', listed('../escape/.atlasignore')), 'unusable');
  });
});

describe('the fake rule set (DD-6)', () => {
  const files = (...entries: Array<[string, string]>) => entries.map(([base, text]) => parseRuleFile(text, base));
  const hit = (rules: ReturnType<typeof files>, rel: string): boolean => ignoredByRuleFiles(rules, rel);

  it('evaluates name, name/, /name, dir/name, *.ext and *.ext/ with last-match-wins and negation', () => {
    const rules = files(['', '# comment\n\nbuild/\n*.snap\n!keep.snap\n/root-only.txt\ndocs/gen\nlocal.txt\n*.egg-info/\n']);
    assert.equal(hit(rules, 'build/x.js'), true, 'a directory rule hides what is below it');
    assert.equal(hit(rules, 'pkg/build/x.js'), true, 'at any depth');
    assert.equal(hit(rules, 'pkg/build'), false, 'a file named like a directory rule is not matched');
    assert.equal(hit(rules, 'a.snap'), true);
    assert.equal(hit(rules, 'deep/a.snap'), true);
    assert.equal(hit(rules, 'keep.snap'), false, 'the negation comes later');
    assert.equal(hit(rules, 'root-only.txt'), true);
    assert.equal(hit(rules, 'sub/root-only.txt'), false, 'anchored');
    assert.equal(hit(rules, 'docs/gen'), true);
    assert.equal(hit(rules, 'docs/gen/x.md'), true);
    assert.equal(hit(rules, 'other/docs/gen'), false, 'a rule with a slash is anchored');
    assert.equal(hit(rules, 'a/b/local.txt'), true);
    assert.equal(hit(rules, 'pkg.egg-info/PKG-INFO'), true);
    assert.equal(hit(rules, 'src/a.ts'), false);
  });

  it('applies a nested file only below its directory, after the outer file', () => {
    const rules = files(['', '*.snap\nlocal.txt\n'], ['sub', '!a.snap\n/anchored.txt\n']);
    assert.equal(hit(rules, 'sub/a.snap'), false, 'the nested negation overrides the root rule');
    assert.equal(hit(rules, 'a.snap'), true);
    assert.equal(hit(rules, 'sub/b.snap'), true);
    assert.equal(hit(rules, 'sub/anchored.txt'), true);
    assert.equal(hit(rules, 'sub/x/anchored.txt'), false);
    assert.equal(hit(rules, 'other/anchored.txt'), false);
    assert.equal(hit(rules, 'sub/deeper/local.txt'), true);
  });

  it('a file below an excluded directory stays excluded whatever a later negation of the file says', () => {
    const rules = files(['', 'build/\n!build/keep.js\n']);
    assert.equal(hit(rules, 'build/keep.js'), true);
  });

  it('refuses syntax outside the subset with invalid_argument', () => {
    for (const bad of ['**/x', 'a/**', '[ab].txt', 'q?.txt', '\\#x', 'a*b', 'trailing \n', '*', 'foo/*', '../x', 'a//b']) {
      assert.throws(() => parseRuleFile(bad, ''), { code: 'invalid_argument' }, JSON.stringify(bad));
    }
  });

  it('createFakeSourceTree rejects a usable .atlasignore with unsupported syntax when the world is built, and ignores an unusable one', () => {
    assert.throws(
      () => createFakeSourceTree({ committed: { 'a.ts': 'x\n', '.atlasignore': '**/generated\n' }, working: {}, ignored: [] }),
      { code: 'invalid_argument' },
    );
    assert.doesNotThrow(() => createFakeSourceTree({ committed: { 'a.ts': 'x\n', '.atlasignore': '**/generated\n\0' }, working: {}, ignored: [] }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real tree only
// ---------------------------------------------------------------------------------------------------------------

async function realTree(
  t: TestContext,
  options: Omit<TempGitRepoOptions, 'runner'>,
  wrap: (inner: CommandRunner) => CommandRunner = (inner) => inner,
): Promise<{ repo: TempGitRepo; recording: RecordingRunner; tree: ReturnType<typeof createSourceTree> }> {
  const repo = await createTempGitRepo({ runner: setupRunner, ...options });
  t.after(() => repo.cleanup());
  const recording = createRecordingRunner({ delegate: wrap(createRealRunner()) });
  const tree = createSourceTree({ runner: recording, repoDir: repo.dir, envOverlay: repo.envOverlay });
  return { repo, recording, tree };
}

const RULE_LINES = [
  '# comment',
  '\\#hash.txt',
  '\\!bang.txt',
  'trail\\ ',
  'plain   ',
  '*.log',
  '!important.log',
  '**/deep-*.tmp',
  'docs/**/gen/',
  '[ab]c.txt',
  'q?.txt',
  '/anchored.txt',
  'only-dir/',
  'sp ace.txt',
  '',
];
const SYNTAX_FILES = [
  '#hash.txt',
  '!bang.txt',
  'trail ',
  'plain',
  'x.log',
  'important.log',
  'sub/y.log',
  'deep-a.tmp',
  'a/b/deep-c.tmp',
  'keep-deep.tmp',
  'docs/one/two/gen/f.md',
  'docs/gen/f.md',
  'docs/gen.md',
  'ac.txt',
  'bc.txt',
  'cc.txt',
  'qq.txt',
  'q/x.txt',
  'anchored.txt',
  'sub/anchored.txt',
  'only-dir/f.txt',
  'x/only-dir',
  'sp ace.txt',
  'normal.ts',
];
/** What the rules above must hide, as evaluated by git itself (probed on git 2.54). */
const SYNTAX_HIDDEN = [
  '#hash.txt',
  '!bang.txt',
  'trail ',
  'plain',
  'x.log',
  'sub/y.log',
  'deep-a.tmp',
  'a/b/deep-c.tmp',
  'docs/one/two/gen/f.md',
  'docs/gen/f.md',
  'ac.txt',
  'bc.txt',
  'qq.txt',
  'anchored.txt',
  'only-dir/f.txt',
  'sp ace.txt',
];

describe('real Source Tree: full gitignore syntax is evaluated by git (D-02)', () => {
  // A name that ends in a space cannot exist on Windows.
  const names = process.platform === 'win32' ? SYNTAX_FILES.filter((f) => f !== 'trail ') : SYNTAX_FILES;
  const hidden = process.platform === 'win32' ? SYNTAX_HIDDEN.filter((f) => f !== 'trail ') : SYNTAX_HIDDEN;
  const variants: ReadonlyArray<readonly [string, string]> = [
    ['LF', RULE_LINES.join('\n')],
    ['CRLF', RULE_LINES.join('\r\n')],
    ['a leading byte order mark', `﻿${RULE_LINES.join('\n')}`],
  ];

  for (const [label, text] of variants) {
    for (const mode of ['untracked', 'tracked'] as const) {
      it(`${label}, files ${mode}: git hides exactly the files its own syntax names`, async (t) => {
        const files = Object.fromEntries(names.map((n) => [n, `${n}\n`]));
        const { tree, repo } = await realTree(t, {
          world: mode === 'tracked' ? { committed: { ...files, '.atlasignore': text }, working: {} } : { committed: {}, working: { ...files, '.atlasignore': text } },
        });
        const { files: kept, excluded } = await tree.snapshot(repo.dir).then((r) => ({ files: [...r.files.keys()].sort(), excluded: r.excluded }));
        assert.deepEqual(kept, [...names.filter((n) => !hidden.includes(n)), '.atlasignore'].sort());
        assert.equal(excluded.byAtlasignore, hidden.length);
        assert.equal(excluded.byDefaults, 0);
      });
    }
  }

  it('a nested .atlasignore overrides the root in its own directory', async (t) => {
    const { tree, repo } = await realTree(t, {
      world: {
        committed: { '.atlasignore': '*.gen.ts\n', 'sub/.atlasignore': '!keep.gen.ts\n', 'a.gen.ts': 'a\n', 'sub/keep.gen.ts': 'k\n', 'sub/b.gen.ts': 'b\n' },
        working: { 'sub/deep/c.gen.ts': 'c\n', 'sub/deep/keep.gen.ts': 'd\n' },
      },
    });
    const { files } = await tree.snapshot(repo.dir);
    assert.deepEqual([...files.keys()].sort(), ['.atlasignore', 'sub/.atlasignore', 'sub/deep/keep.gen.ts', 'sub/keep.gen.ts']);
  });

  it('.atlasignore is evaluated apart from .gitignore and intersected with it: neither re-includes what the other hides', async (t) => {
    const { tree, repo } = await realTree(t, {
      world: {
        committed: { '.gitignore': 'by-git.txt\nboth.txt\n', '.atlasignore': 'by-atlas.txt\nboth.txt\n!by-git.txt\n', 'keep.ts': 'k\n' },
        working: { 'by-git.txt': 'g\n', 'by-atlas.txt': 'a\n', 'both.txt': 'b\n', 'free.txt': 'f\n' },
      },
    });
    const result = await tree.snapshot(repo.dir);
    assert.deepEqual([...result.files.keys()].sort(), ['.atlasignore', '.gitignore', 'free.txt', 'keep.ts']);
    // `by-atlas.txt` is the only file .atlasignore alone removed; `both.txt` is hidden by git already and counted by neither.
    assert.equal(result.excluded.byAtlasignore, 1);
    const listed = await tree.unignoredPaths(repo.dir, ['by-git.txt', 'by-atlas.txt', 'both.txt', 'free.txt', 'keep.ts']);
    assert.deepEqual([...listed].sort(), ['free.txt', 'keep.ts']);
  });
});

describe('real Source Tree: an unusable .atlasignore is never given to git (D-04, T-re7-01, T-re7-02)', () => {
  const FLAG = '--exclude-per-directory=.atlasignore';
  const flagged = (recording: RecordingRunner): number => recording.starts.filter((s) => s.args.includes(FLAG)).length;

  it('a tracked 70,000-byte file never reaches git: no spec carries the flag, one warning, nothing is hidden', async (t) => {
    const text = `hidden.txt\n${'#'.repeat(70000)}\n`;
    const { tree, repo, recording } = await realTree(t, { world: { committed: { '.atlasignore': text, 'hidden.txt': 'h\n', 'a.ts': 'a\n' }, working: {} } });
    const result = await tree.snapshot(repo.dir);
    await tree.unignoredPaths(repo.dir, ['hidden.txt']);
    assert.ok(result.files.has('hidden.txt'));
    assert.equal(result.diagnostics.filter((d) => d.code === 'atlasignore_unusable').length, 1);
    assert.equal(flagged(recording), 0, 'git was never told to read the file');
    assert.equal(recording.denials.length, 0);
  });

  it('invalid UTF-8 makes the file unusable (git itself would accept it)', async (t) => {
    const { tree, repo, recording } = await realTree(t, { world: { committed: { 'hide-me.ts': 'h\n', 'other.ts': 'o\n' }, working: {} } });
    fs.writeFileSync(path.join(repo.dir, '.atlasignore'), Buffer.concat([Buffer.from('hide-me.ts\n'), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0a])]));
    const result = await tree.snapshot(repo.dir);
    assert.ok(result.files.has('hide-me.ts'));
    assert.equal(result.diagnostics.filter((d) => d.code === 'atlasignore_unusable').length, 1);
    assert.equal(flagged(recording), 0);
  });

  it(
    'a link to a file outside the repository is never read and its rules never apply',
    { skip: notOnWindows('creating a symlink needs privileges on Windows') },
    async (t) => {
      const { tree, repo, recording } = await realTree(t, { world: { committed: { 'secret.ts': 's\n', 'a.ts': 'a\n' }, working: {} } });
      const outside = path.join(path.dirname(repo.dir), 'outside-rules.txt');
      fs.writeFileSync(outside, 'secret.ts\n');
      fs.symlinkSync(outside, path.join(repo.dir, '.atlasignore'));
      const result = await tree.snapshot(repo.dir);
      assert.ok(result.files.has('secret.ts'));
      assert.ok(!result.files.has('.atlasignore'), 'a link is never a file of the index');
      assert.equal(result.diagnostics.filter((d) => d.code === 'atlasignore_unusable').length, 1);
      assert.equal(flagged(recording), 0);
    },
  );

  it('a usable file sends the flag in exactly two listings, both with constant values only and neither with --exclude-standard', async (t) => {
    const { tree, repo, recording } = await realTree(t, {
      world: { committed: { '.atlasignore': 'hidden.txt\n', 'hidden.txt': 'h\n', 'a.ts': 'a\n' }, working: { 'new.txt': 'n\n' } },
    });
    const result = await tree.snapshot(repo.dir);
    assert.deepEqual([...result.files.keys()].sort(), ['.atlasignore', 'a.ts', 'new.txt']);
    assert.deepEqual(result.diagnostics.filter((d) => d.code === 'atlasignore_unusable'), []);
    const stageTwo = recording.starts.filter((s) => s.args.includes(FLAG));
    assert.equal(stageTwo.length, 2);
    const all = new Set(defaultPatterns('all'));
    for (const spec of stageTwo) {
      assert.ok(!spec.args.includes('--exclude-standard'));
      assert.equal(spec.stdin, undefined);
      for (const value of excludeValues(spec.args)) assert.ok(all.has(value), `${value} is a built-in default`);
    }
    const untracked = stageTwo.find((s) => s.args.includes('--others'));
    const tracked = stageTwo.find((s) => s.args.includes('--cached'));
    assert.ok(untracked !== undefined && tracked !== undefined);
    assert.ok(tracked.args.includes('--ignored'));
    assert.deepEqual(excludeValues(untracked.args), [...defaultPatterns('all')]);
    assert.deepEqual(excludeValues(tracked.args), [...defaultPatterns('tracked')]);
  });

  for (const how of ['exit 128', 'a timeout'] as const) {
    it(`a failing second stage (${how}) falls back to the first stage with the warning and the listing still succeeds`, async (t) => {
      const failed: CommandResult = {
        ok: false,
        exitCode: how === 'exit 128' ? 128 : null,
        signal: null,
        stdout: new Uint8Array(0),
        stderr: new TextEncoder().encode('fatal: injected failure'),
        truncated: false,
        timedOut: how === 'a timeout',
        diagnostics: [],
      };
      const { tree, repo, recording } = await realTree(
        t,
        { world: { committed: { '.atlasignore': 'hidden.txt\n', 'hidden.txt': 'h\n', 'a.ts': 'a\n' }, working: { 'new.txt': 'n\n' } } },
        (inner) => ({
          stream: (spec, ctx) => inner.stream(spec, ctx),
          run: (spec, ctx) => (spec.args.includes(FLAG) ? Promise.resolve(failed) : inner.run(spec, ctx)),
        }),
      );
      const result = await tree.snapshot(repo.dir);
      assert.deepEqual([...result.files.keys()].sort(), ['.atlasignore', 'a.ts', 'hidden.txt', 'new.txt']);
      assert.equal(result.diagnostics.filter((d) => d.code === 'atlasignore_unusable').length, 1);
      assert.deepEqual(result.excluded, { byDefaults: 0, byAtlasignore: 0 });
      const listed = await tree.unignoredPaths(repo.dir, ['hidden.txt', 'new.txt']);
      assert.deepEqual([...listed].sort(), ['hidden.txt', 'new.txt']);
      assert.equal(recording.starts.filter((s) => s.args.includes(FLAG)).length >= 2, true, 'the second stage was attempted');
      assert.equal(recording.denials.length, 0);
    });
  }

  it('nothing from the repository reaches an argument: every --exclude value is a constant default and the other tokens are fixed', async (t) => {
    const { tree, repo, recording } = await realTree(t, {
      world: {
        committed: { '.atlasignore': '--help\n-x\n--exclude=evil\nhidden.txt\n', '.gitignore': '--exclude-from=/etc/passwd\n', 'hidden.txt': 'h\n' },
        working: { '--help': 'h\n', '-x': 'x\n', 'a b.ts': 'ab\n' },
      },
    });
    await tree.snapshot(repo.dir);
    await tree.unignoredPaths(repo.dir, ['hidden.txt', '--help', '-x']);
    const all = new Set(defaultPatterns('all'));
    const fixed = new Set(['-z', '-s', '--cached', '--others', '--ignored', '--exclude-standard', '--exclude', FLAG]);
    for (const spec of recording.starts.filter((s) => subcommand(s) === 'ls-files')) {
      const rest = spec.args.slice(spec.args.indexOf('ls-files') + 1);
      rest.forEach((token, i) => {
        if (rest[i - 1] === '--exclude') assert.ok(all.has(token), `value ${token}`);
        else assert.ok(fixed.has(token), `token ${token}`);
      });
    }
  });
});
