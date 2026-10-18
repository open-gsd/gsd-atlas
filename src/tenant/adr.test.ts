/**
 * The tenant's ADR directory (plan 03-28, TSM-04, D-20): file names are parsed by their leading number, a citation's number
 * matches a file by value, and the listing is remembered per directory modification time so an unchanged directory costs one stat.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeSourceTree } from '../source-tree/index.ts';
import type { DirectoryListing, SourceTree } from '../source-tree/index.ts';
import { DEFAULT_ADR_DIRS, chooseAdrDirs, createAdrDirectory, parseAdrFileName } from './adr.ts';
import { readRepoConfig } from './repo-config.ts';

const WORKTREE = '/fake';

/** A tree over the fake world that counts how every listing was asked and lets a test move the directory's mtime. */
function countingTree(files: Readonly<Record<string, string>>): {
  readonly tree: Pick<SourceTree, 'listDirectory'>;
  readonly calls: Array<{ readonly dir: string; readonly ifMtimeMs: number | undefined }>;
  world: Record<string, string>;
  mtimeMs: number;
} {
  const state = {
    world: { ...files } as Record<string, string>,
    mtimeMs: 100,
    calls: [] as Array<{ dir: string; ifMtimeMs: number | undefined }>,
  };
  const tree: Pick<SourceTree, 'listDirectory'> = {
    async listDirectory(worktree, dir, options): Promise<DirectoryListing> {
      state.calls.push({ dir, ifMtimeMs: options?.ifMtimeMs });
      const inner = createFakeSourceTree({ committed: state.world });
      const listing = await inner.listDirectory(worktree, dir);
      if (listing.status !== 'ok') return listing;
      if (options?.ifMtimeMs === state.mtimeMs) return { status: 'ok', names: [], mtimeMs: state.mtimeMs, truncated: false, unchanged: true };
      return { ...listing, mtimeMs: state.mtimeMs };
    },
  };
  return {
    tree,
    calls: state.calls,
    get world() {
      return state.world;
    },
    set world(value) {
      state.world = value;
    },
    get mtimeMs() {
      return state.mtimeMs;
    },
    set mtimeMs(value) {
      state.mtimeMs = value;
    },
  };
}

const ADR_FILES: Readonly<Record<string, string>> = {
  'docs/adr/0001-first.md': '# first\n',
  'docs/adr/2-second.md': '# second\n',
  'docs/adr/README.md': 'readme\n',
};

describe('parseAdrFileName: the file name table', () => {
  const table: ReadonlyArray<readonly [string, number | null]> = [
    ['0001-first.md', 1],
    ['2-second.md', 2],
    ['0010-file-operation-engine-module.md', 10],
    ['00-zero.md', 0],
    ['007-bond.md', 7],
    ['README.md', null],
    ['adr-0003.md', null],
    ['12.md', null],
    ['0003-third.markdown', null],
    ['0003-third.MD', null],
    ['0003-.md', null],
    ['-3-negative.md', null],
    ['3_underscore.md', null],
    ['3 space.md', null],
    ['', null],
    ['99999999999999999999-too-big.md', null],
    ['1-a.md.bak', null],
  ];
  for (const [name, expected] of table) {
    it(`file name table: ${JSON.stringify(name)} is ${String(expected)}`, () => {
      assert.equal(parseAdrFileName(name), expected);
    });
  }
});

describe('createAdrDirectory: lookup by value', () => {
  it('lookup by value: the citation number matches a file regardless of leading zeros, and a number with no file is unresolved', async () => {
    const adr = createAdrDirectory({ tree: createFakeSourceTree({ committed: ADR_FILES }), dirsFor: () => ['docs/adr'] });
    assert.deepEqual(await adr.lookup(WORKTREE, 1), { status: 'resolved', files: ['docs/adr/0001-first.md'] });
    assert.deepEqual(await adr.lookup(WORKTREE, 2), { status: 'resolved', files: ['docs/adr/2-second.md'] });
    assert.deepEqual(await adr.lookup(WORKTREE, 3), { status: 'unresolved', files: [] });
    // `README.md` carries no number: it can never be the answer to a number.
    assert.deepEqual(await adr.lookup(WORKTREE, 0), { status: 'unresolved', files: [] });
  });

  it('duplicate numbers: several files with one number are ambiguous and listed sorted', async () => {
    const adr = createAdrDirectory({
      tree: createFakeSourceTree({
        committed: {
          'docs/adr/0010-b-second.md': 'b\n',
          'docs/adr/0010-a-first.md': 'a\n',
          'docs/adr/0011-only.md': 'c\n',
          'docs/adr/10-third-spelling.md': 'd\n',
        },
      }),
      dirsFor: () => ['docs/adr'],
    });
    assert.deepEqual(await adr.lookup(WORKTREE, 10), {
      status: 'ambiguous',
      files: ['docs/adr/0010-a-first.md', 'docs/adr/0010-b-second.md', 'docs/adr/10-third-spelling.md'],
    });
    assert.deepEqual(await adr.lookup(WORKTREE, 11), { status: 'resolved', files: ['docs/adr/0011-only.md'] });
  });

  it('known: several directories are united in the order given, a missing or refused one is reported and lists nothing', async () => {
    const adr = createAdrDirectory({
      tree: createFakeSourceTree({ committed: { ...ADR_FILES, 'adr/0005-five.md': '5\n' } }),
      dirsFor: () => ['adr', 'doc/adr', '../outside', 'docs/adr'],
    });
    const index = await adr.known(WORKTREE);
    assert.deepEqual(
      index.dirs.map((entry) => [entry.dir, entry.status]),
      [
        ['adr', 'ok'],
        ['doc/adr', 'missing'],
        ['../outside', 'escape'],
        ['docs/adr', 'ok'],
      ],
    );
    assert.deepEqual([...index.byNumber.keys()].sort((a, b) => a - b), [1, 2, 5]);
    assert.deepEqual(index.byNumber.get(5), ['adr/0005-five.md']);
  });

  it('a directory listing the tree cut is reported, so a missing number is not claimed to be absent', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`docs/adr/${String(i + 1).padStart(4, '0')}-n.md`, 'x\n']));
    const adr = createAdrDirectory({ tree: createFakeSourceTree({ committed: files }), dirsFor: () => ['docs/adr'], maxEntries: 3 });
    assert.deepEqual(await adr.lookup(WORKTREE, 2), { status: 'resolved', files: ['docs/adr/0002-n.md'] });
    assert.deepEqual(await adr.lookup(WORKTREE, 6), { status: 'unresolved', files: [], listTruncated: true });
  });
});

describe('createAdrDirectory: memo per mtime', () => {
  it('memo per mtime: an unchanged directory costs the one stat, a changed one is listed again', async () => {
    const counting = countingTree(ADR_FILES);
    const adr = createAdrDirectory({ tree: counting.tree, dirsFor: () => ['docs/adr'] });

    assert.equal((await adr.lookup(WORKTREE, 1)).status, 'resolved');
    assert.deepEqual(counting.calls, [{ dir: 'docs/adr', ifMtimeMs: undefined }], 'the first lookup lists the directory');

    assert.equal((await adr.lookup(WORKTREE, 2)).status, 'resolved');
    assert.equal((await adr.lookup(WORKTREE, 3)).status, 'unresolved');
    assert.deepEqual(
      counting.calls.slice(1),
      [
        { dir: 'docs/adr', ifMtimeMs: 100 },
        { dir: 'docs/adr', ifMtimeMs: 100 },
      ],
      'later lookups ask only whether the directory changed since the remembered mtime',
    );

    counting.world = { ...ADR_FILES, 'docs/adr/0003-third.md': '# third\n' };
    counting.mtimeMs = 200;
    assert.deepEqual(await adr.lookup(WORKTREE, 3), { status: 'resolved', files: ['docs/adr/0003-third.md'] });
    assert.equal(counting.calls.at(-1)?.ifMtimeMs, 100, 'the change is noticed because the remembered mtime no longer matches');
    assert.deepEqual(await adr.lookup(WORKTREE, 3), { status: 'resolved', files: ['docs/adr/0003-third.md'] });
    assert.equal(counting.calls.at(-1)?.ifMtimeMs, 200);
  });

  it('memo per mtime: two worktrees and two directory lists never share an entry', async () => {
    const counting = countingTree(ADR_FILES);
    let dirs: readonly string[] = ['docs/adr'];
    const adr = createAdrDirectory({ tree: counting.tree, dirsFor: () => dirs });
    await adr.lookup('/one', 1);
    await adr.lookup('/two', 1);
    assert.deepEqual(
      counting.calls.map((call) => call.ifMtimeMs),
      [undefined, undefined],
      'each worktree lists for itself the first time',
    );
    dirs = ['docs/adr', 'adr'];
    await adr.lookup('/one', 1);
    assert.deepEqual(
      counting.calls.slice(2).map((call) => [call.dir, call.ifMtimeMs]),
      [
        ['docs/adr', 100],
        ['adr', undefined],
      ],
      'the new list asks about the directory it already knows and lists the new one',
    );
  });

  it('memo per mtime: a directory that went missing is reported missing, not remembered as it was', async () => {
    const counting = countingTree(ADR_FILES);
    const adr = createAdrDirectory({ tree: counting.tree, dirsFor: () => ['docs/adr'] });
    assert.equal((await adr.lookup(WORKTREE, 1)).status, 'resolved');
    counting.world = {};
    assert.deepEqual(await adr.lookup(WORKTREE, 1), { status: 'unresolved', files: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// The repository config file and the choice of directories (plan 03-28, Task 2; ADR 5 amendment, point 4)

const CONFIG = '.gsd-atlas/config.json';
const IGNORED = 'repo_config_ignored';

const repoTree = (files: Readonly<Record<string, string>>) => createFakeSourceTree({ committed: files });

describe('readRepoConfig: untrusted data that can only name ADR directories', () => {
  it('no file is no config and no diagnostic', async () => {
    assert.deepEqual(await readRepoConfig(repoTree({ 'a.txt': 'x\n' }), WORKTREE), { diagnostics: [] });
  });

  it('repo config replaces the list: a file with adrDirs gives exactly those directories', async () => {
    const config = await readRepoConfig(repoTree({ [CONFIG]: '{"adrDirs":["documentation/decisions","adr"]}' }), WORKTREE);
    assert.deepEqual(config, { adrDirs: ['documentation/decisions', 'adr'], diagnostics: [] });
  });

  it('hostile keys ignored: permissions, commands, diagnostics, autoSubmit and unknown keys have no effect and give one fixed diagnostic', async () => {
    const hostile = JSON.stringify({
      adrDirs: ['docs/adr'],
      permissions: { allow: [{ executable: 'node' }] },
      commands: [{ executable: 'node', args: ['mark.js'] }],
      diagnostics: { enabled: true },
      autoSubmit: true,
      somethingNew: 1,
    });
    const config = await readRepoConfig(repoTree({ [CONFIG]: hostile }), WORKTREE);
    assert.deepEqual(config.adrDirs, ['docs/adr']);
    assert.equal(config.diagnostics.length, 1, 'one diagnostic however many keys were ignored');
    const [note] = config.diagnostics;
    assert.equal(note?.code, IGNORED);
    assert.equal(note?.severity, 'info');
    assert.equal(note?.subject, undefined);
    assert.ok(!/permissions|commands|autoSubmit|somethingNew|mark/.test(note?.message ?? ''), 'fixed text: nothing from the file is repeated');
    // The same kind of file with other keys in another order gives the same fixed text.
    const again = await readRepoConfig(repoTree({ [CONFIG]: JSON.stringify({ autoSubmit: true, adrDirs: ['docs/adr'] }) }), WORKTREE);
    assert.equal(again.diagnostics[0]?.message, note?.message);
    // Without adrDirs the hostile file is only noted: no directories, nothing enabled.
    const only = await readRepoConfig(repoTree({ [CONFIG]: '{"permissions":{"allow":[]}}' }), WORKTREE);
    assert.deepEqual(only, { diagnostics: [{ code: IGNORED, severity: 'info', message: note?.message ?? '' }] });
  });

  it('an adrDirs entry that is not a plain relative path is dropped and the rest are kept', async () => {
    const entries = ['good/adr', '../../etc', '/abs', 'C:/x', 'docs\\adr', '', 7, 'also/good'];
    const config = await readRepoConfig(repoTree({ [CONFIG]: JSON.stringify({ adrDirs: entries }) }), WORKTREE);
    assert.deepEqual(config.adrDirs, ['good/adr', 'also/good']);
    assert.deepEqual(config.diagnostics.map((d) => d.code), [IGNORED]);
  });

  it('more than eight entries keep the first eight, and an adrDirs that is not a list is ignored', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `d${String(i)}`);
    const config = await readRepoConfig(repoTree({ [CONFIG]: JSON.stringify({ adrDirs: nine }) }), WORKTREE);
    assert.deepEqual(config.adrDirs, nine.slice(0, 8));
    assert.equal(config.diagnostics.length, 1);
    const text = await readRepoConfig(repoTree({ [CONFIG]: '{"adrDirs":"docs/adr"}' }), WORKTREE);
    assert.equal(text.adrDirs, undefined);
    assert.equal(text.diagnostics.length, 1);
  });

  it('a file over 64 KiB, invalid JSON and a JSON value that is not an object are ignored whole', async () => {
    const big = JSON.stringify({ adrDirs: ['docs/adr'], pad: 'x'.repeat(64 * 1024) });
    for (const text of [big, '{ nope', '[1,2]', '"adrDirs"', 'null', '']) {
      const config = await readRepoConfig(repoTree({ [CONFIG]: text }), WORKTREE);
      assert.equal(config.adrDirs, undefined, text.slice(0, 20));
      assert.deepEqual(config.diagnostics.map((d) => d.code), [IGNORED], text.slice(0, 20));
    }
    // Exactly the cap is read: 64 KiB of valid JSON.
    const base = JSON.stringify({ adrDirs: ['docs/adr'] });
    const exact = `${base.slice(0, -1)}${' '.repeat(64 * 1024 - base.length)}}`;
    assert.equal(Buffer.byteLength(exact), 64 * 1024);
    assert.deepEqual((await readRepoConfig(repoTree({ [CONFIG]: exact }), WORKTREE)).adrDirs, ['docs/adr']);
  });

  it('a config that cannot be read at all (the tree throws) is no config, never an error', async () => {
    const throwing = { readText: () => Promise.reject(new Error('boom')) };
    assert.deepEqual(await readRepoConfig(throwing, WORKTREE), { diagnostics: [] });
  });
});

describe('chooseAdrDirs: repository config, then module manifests, then the convention list', () => {
  it('repo config replaces the list: the repository list wins over every module, even an empty one', () => {
    assert.deepEqual(chooseAdrDirs({ diagnostics: [], adrDirs: ['documentation/decisions'] }, [['docs/adr'], ['adr']]), ['documentation/decisions']);
    assert.deepEqual(chooseAdrDirs({ diagnostics: [], adrDirs: [] }, [['docs/adr']]), []);
  });

  it('the union of the modules lists, first seen first and deduplicated, when the repository names none', () => {
    assert.deepEqual(chooseAdrDirs({ diagnostics: [] }, [['docs/adr', 'adr'], ['adr', 'doc/adr'], []]), ['docs/adr', 'adr', 'doc/adr']);
  });

  it('the convention list when nothing names a directory', () => {
    assert.deepEqual(chooseAdrDirs({ diagnostics: [] }, []), ['docs/adr', 'docs/adrs', 'doc/adr', 'adr']);
    assert.deepEqual(chooseAdrDirs({ diagnostics: [] }, [[], []]), DEFAULT_ADR_DIRS);
  });
});

describe('createAdrDirectory with the repository config: what is listed', () => {
  const files = {
    'documentation/decisions/0001-config-dir.md': '# one\n',
    'docs/adr/0001-manifest-dir.md': '# one too\n',
    'docs/adr/0002-second.md': '# two\n',
  };

  it('repo config replaces the list: only the configured directory is listed, and its diagnostics reach the lookup', async () => {
    const tree = repoTree({ ...files, [CONFIG]: JSON.stringify({ adrDirs: ['documentation/decisions'], autoSubmit: true }) });
    const adr = createAdrDirectory({
      tree,
      dirsFor: async (worktree) => {
        const config = await readRepoConfig(tree, worktree);
        return { dirs: chooseAdrDirs(config, [['docs/adr']]), diagnostics: config.diagnostics };
      },
    });
    const index = await adr.known(WORKTREE);
    assert.deepEqual(index.dirs.map((entry) => entry.dir), ['documentation/decisions']);
    assert.deepEqual(await adr.lookup(WORKTREE, 2), { status: 'unresolved', files: [], diagnostics: index.diagnostics });
    const one = await adr.lookup(WORKTREE, 1);
    assert.equal(one.status, 'resolved');
    assert.deepEqual(one.files, ['documentation/decisions/0001-config-dir.md']);
    assert.deepEqual(one.diagnostics?.map((d) => d.code), [IGNORED]);
  });

  it('escape refused: a directory that leaves the repository lists nothing and is reported escape', async () => {
    const tree = repoTree({ ...files });
    const adr = createAdrDirectory({ tree, dirsFor: () => ['../../etc', '/etc', 'docs/adr', 'C:/Windows'] });
    const index = await adr.known(WORKTREE);
    assert.deepEqual(
      index.dirs.map((entry) => [entry.dir, entry.status]),
      [
        ['../../etc', 'escape'],
        ['/etc', 'escape'],
        ['docs/adr', 'ok'],
        ['C:/Windows', 'escape'],
      ],
    );
    assert.deepEqual([...index.byNumber.keys()].sort(), [1, 2]);
  });
});
