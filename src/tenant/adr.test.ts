/**
 * The tenant's ADR directory (plan 03-28, TSM-04, D-20): file names are parsed by their leading number, a citation's number
 * matches a file by value, and the listing is remembered per directory modification time so an unchanged directory costs one stat.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeSourceTree } from '../source-tree/index.ts';
import type { DirectoryListing, SourceTree } from '../source-tree/index.ts';
import { createAdrDirectory, parseAdrFileName } from './adr.ts';

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
