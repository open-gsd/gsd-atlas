/**
 * The shared Source Tree contract suite (D-10). Test code: only `source-tree.test.ts` imports it, as
 * `./contract.ts`, and `index.ts` never exports it. It runs against the fake and against the real
 * implementation on a realised temporary git repository, from one data description of the repository.
 *
 * The expectations are computed here from the world with an independent sha1 oracle, never by asking an
 * implementation what it would say.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { SourceTree, SourceTreeWorld } from './types.ts';

export interface SourceTreeHarness {
  readonly tree: SourceTree;
  /** The directory to pass to `snapshot` (any string for the fake). */
  readonly worktree: string;
  cleanup(): void | Promise<void>;
}

/** Builds an implementation over the given repository description. */
export type MakeSourceTree = (world: SourceTreeWorld) => Promise<SourceTreeHarness>;

const blobId = (content: string): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

const byPath = ([a]: readonly [string, string], [b]: readonly [string, string]): number => (a < b ? -1 : a > b ? 1 : 0);

export const CONTRACT_WORLD: SourceTreeWorld = {
  committed: {
    'a.txt': 'alpha\n',
    'dir/b.ts': 'export const b = 1;\n',
    'sp ace.txt': 'space\n',
    'keep/deleted.txt': 'gone soon\n',
  },
  working: {
    'a.txt': 'alpha edited\n',
    'new.txt': 'brand new\n',
    'deep/er/c.txt': 'nested untracked\n',
    'keep/deleted.txt': null,
    'build/out.js': 'ignored output\n',
    'secret.log': 'ignored file\n',
  },
  ignored: ['build/', 'secret.log'],
};

/** Options every sourceSet case passes: two claimed extensions and a 10,000-byte cap. */
export const SOURCE_SET_OPTIONS = { extensions: ['.ts', '.cjs'], maxBytes: 10000 } as const;

/**
 * A world for the source-set cases: claimed and unclaimed extensions, linguist attributes (set and explicitly
 * unset), a binary, a Git LFS pointer, a file over the byte cap, a NUL byte only after the first 8 KB, a file
 * deleted after listing and an ignored secret that must never surface.
 */
export const SOURCE_SET_WORLD: SourceTreeWorld = {
  committed: {
    'src/a.ts': 'export const a = 1;\n',
    'src/Upper.TS': 'export const upper = 1;\n',
    'lib/b.cjs': 'module.exports = 1;\n',
    'README.md': '# readme\n',
    'notes.txt': 'notes\n',
    'gen/out.ts': 'export const generated = 1;\n',
    'gen/unset.ts': 'export const kept = 1;\n',
    'third_party/v.ts': 'export const vendored = 1;\n',
    'bin/blob.ts': 'MZ\0\0binary payload\n',
    'lfs/pointer.ts': `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`,
    'big/huge.ts': `${'y'.repeat(20000)}\n`,
    // Not named `nul.ts`: NUL is a reserved device name on Windows, where git cannot add such a file (found by plan 02-26).
    'late/nulbyte.ts': `${'x'.repeat(9000)}\0\n`,
    'gone/deleted.ts': 'export const gone = 1;\n',
  },
  working: {
    'gone/deleted.ts': null,
    'config/secrets.ts': 'export const token = "never indexed";\n',
  },
  ignored: ['config/secrets.ts'],
  attributes: {
    'gen/out.ts': { generated: true },
    'gen/unset.ts': { generated: false },
    'third_party/v.ts': { vendored: true },
  },
};

/** A world for the readText cases: a BOM with CRLF endings, a file of exactly 100 bytes, a directory and non-ASCII names. */
export const READ_TEXT_WORLD: SourceTreeWorld = {
  committed: {
    'bom.txt': '﻿hello\r\nworld\r\n',
    'hundred.txt': 'z'.repeat(100),
    'dir/inner.txt': 'inner\n',
    'café dir/ü file.txt': 'unicode\n',
  },
  working: { 'untracked.txt': 'not committed\n' },
  ignored: [],
};

/** The first commit of {@link HISTORY_WORLD}: a CRLF file, a binary file with NUL, a deleted-later file. */
export const HISTORY_FIRST: Readonly<Record<string, string>> = {
  'a.ts': 'export const a = 1;\n',
  'old.ts': 'export const old = 1;\n',
  'dir/c.ts': 'export const c = 1;\n',
  'crlf.ts': 'one\r\ntwo\r\n',
  'bin/blob.dat': 'MZ\0\0binary payload\n',
  'big.ts': `${'y'.repeat(300)}\n`,
  'sp ace/é.ts': 'export const spaced = 1;\n',
};

/** The second (HEAD) commit: `a.ts` edited, `old.ts` deleted, a link, an executable and a submodule added. */
export const HISTORY_SECOND: Readonly<Record<string, string>> = {
  'a.ts': 'export const a = 2;\n',
  'dir/c.ts': 'export const c = 1;\n',
  'crlf.ts': 'one\r\ntwo\r\n',
  'bin/blob.dat': 'MZ\0\0binary payload\n',
  'big.ts': `${'y'.repeat(300)}\n`,
  'sp ace/é.ts': 'export const spaced = 1;\n',
  'link.ts': 'a.ts',
  'tool.sh': '#!/bin/sh\necho tool\n',
  'vendor/sub': '',
};

/**
 * A world with two commits whose working tree differs from both, for the history reads (STO-09): `listTree` and
 * `readMany` must follow the commit and never the working tree.
 */
export const HISTORY_WORLD: SourceTreeWorld = {
  committed: HISTORY_SECOND,
  working: { 'a.ts': 'export const a = "working tree edit";\n', 'untracked.ts': 'export const u = 1;\n' },
  ignored: [],
  commits: [HISTORY_FIRST, HISTORY_SECOND],
  modes: { 'link.ts': 'symlink', 'tool.sh': 'executable', 'vendor/sub': 'gitlink' },
};

/** What a snapshot of {@link CONTRACT_WORLD} must be, derived from the world alone. */
function expectedFiles(world: SourceTreeWorld): Array<[string, string]> {
  const isIgnored = (rel: string): boolean => world.ignored.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e));
  const out = new Map<string, string>();
  for (const [rel, content] of Object.entries(world.committed)) out.set(rel, content);
  for (const [rel, content] of Object.entries(world.working)) {
    if (content === null) out.delete(rel);
    else if (Object.hasOwn(world.committed, rel) || !isIgnored(rel)) out.set(rel, content);
  }
  return [...out].map(([rel, content]): [string, string] => [rel, blobId(content)]).sort(byPath);
}

export function defineSourceTreeContract(label: string, make: MakeSourceTree): void {
  const withTree = (world: SourceTreeWorld, body: (h: SourceTreeHarness) => Promise<void>) => async (): Promise<void> => {
    const harness = await make(world);
    try {
      await body(harness);
    } finally {
      await harness.cleanup();
    }
  };

  describe(`SourceTree contract: ${label}`, () => {
    it(
      'snapshot keys are repo-relative POSIX paths and ids match the git blob oracle',
      withTree(CONTRACT_WORLD, async ({ tree, worktree }) => {
        const { files } = await tree.snapshot(worktree);
        assert.deepEqual([...files].sort(byPath), expectedFiles(CONTRACT_WORLD));
        for (const key of files.keys()) {
          assert.ok(!key.startsWith('./') && !key.startsWith('/'), `leading ./ or / in ${key}`);
          assert.ok(!key.includes('\\'), `backslash in ${key}`);
        }
      }),
    );

    it(
      'ignored files are absent, untracked non-ignored files are present, a deleted tracked file is absent and reported',
      withTree(CONTRACT_WORLD, async ({ tree, worktree }) => {
        const { files, diagnostics } = await tree.snapshot(worktree);
        assert.ok(!files.has('secret.log'));
        assert.ok(![...files.keys()].some((k) => k.startsWith('build/')));
        assert.ok(files.has('new.txt'));
        assert.ok(files.has('deep/er/c.txt'));
        assert.ok(!files.has('keep/deleted.txt'));
        assert.deepEqual(
          diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`),
          ['missing_on_disk:keep/deleted.txt'],
        );
      }),
    );

    it(
      'snapshot is deterministic',
      withTree(CONTRACT_WORLD, async ({ tree, worktree }) => {
        const first = await tree.snapshot(worktree);
        const second = await tree.snapshot(worktree);
        assert.deepEqual([...first.files], [...second.files]);
        assert.deepEqual(first.diagnostics, second.diagnostics);
      }),
    );

    it(
      'hasObject is true for each committed blob id and false for an unknown or malformed id',
      withTree(CONTRACT_WORLD, async ({ tree }) => {
        for (const content of Object.values(CONTRACT_WORLD.committed)) {
          assert.equal(await tree.hasObject(blobId(content)), true, content);
        }
        assert.equal(await tree.hasObject('1'.repeat(40)), false);
        assert.equal(await tree.hasObject('1'.repeat(64)), false);
        for (const bad of ['', '-h', '--help', 'abc', 'HEAD', 'ZZ'.repeat(20), 'a'.repeat(41)]) {
          assert.equal(await tree.hasObject(bad), false, JSON.stringify(bad));
        }
      }),
    );

    it(
      'read returns the committed bytes, null for a missing path, and rejects option-like or NUL arguments',
      withTree(CONTRACT_WORLD, async ({ tree }) => {
        const { rootCommit } = await tree.identity();
        assert.ok(rootCommit !== null);
        const bytes = await tree.read(rootCommit, 'dir/b.ts');
        assert.equal(new TextDecoder().decode(bytes ?? new Uint8Array()), 'export const b = 1;\n');
        // The committed content, not the working-tree edit.
        assert.equal(new TextDecoder().decode((await tree.read(rootCommit, 'a.txt')) ?? new Uint8Array()), 'alpha\n');
        assert.equal(await tree.read(rootCommit, 'no/such.txt'), null);
        assert.equal(await tree.read('f'.repeat(40), 'a.txt'), null);
        await assert.rejects(() => tree.read('--help', 'a.txt'), { code: 'invalid_argument' });
        await assert.rejects(() => tree.read('-x', 'a.txt'), { code: 'invalid_argument' });
        await assert.rejects(() => tree.read(rootCommit, 'a\0b'), { code: 'invalid_argument' });
        await assert.rejects(() => tree.read(rootCommit, 'a\nb'), { code: 'invalid_argument' });
      }),
    );

    it(
      'identity returns a 40 or 64 hex root commit and a stable 16 hex storeId',
      withTree(CONTRACT_WORLD, async ({ tree }) => {
        const first = await tree.identity();
        const second = await tree.identity();
        assert.match(first.rootCommit ?? '', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
        assert.match(first.storeId, /^[0-9a-f]{16}$/);
        assert.deepEqual(first, second);
      }),
    );

    it(
      'an empty repository has an empty snapshot, no root commit and no objects',
      withTree({ committed: {}, working: {}, ignored: [] }, async ({ tree, worktree }) => {
        const snapshot = await tree.snapshot(worktree);
        assert.equal(snapshot.files.size, 0);
        assert.deepEqual(snapshot.diagnostics, []);
        const id = await tree.identity();
        assert.equal(id.rootCommit, null);
        assert.match(id.storeId, /^[0-9a-f]{16}$/);
        assert.equal(await tree.hasObject(blobId('alpha\n')), false);
      }),
    );

    it(
      'hashPaths returns the snapshot ids for a coalesced path list, once per path, and an empty map for an empty list',
      withTree(CONTRACT_WORLD, async ({ tree, worktree }) => {
        const expected = new Map(expectedFiles(CONTRACT_WORLD));
        const { files, diagnostics } = await tree.hashPaths(worktree, ['new.txt', 'a.txt', 'new.txt', 'dir/b.ts']);
        assert.deepEqual(
          [...files].sort(byPath),
          ['a.txt', 'dir/b.ts', 'new.txt'].map((rel): [string, string] => [rel, expected.get(rel) ?? '']),
        );
        assert.deepEqual(diagnostics, []);
        const snapshot = await tree.snapshot(worktree);
        for (const [rel, id] of files) assert.equal(snapshot.files.get(rel), id, rel);
        const none = await tree.hashPaths(worktree, []);
        assert.equal(none.files.size, 0);
        assert.deepEqual(none.diagnostics, []);
      }),
    );

    it(
      'hashPaths leaves out an absent path, a directory and an unhashable name with one coded diagnostic each and still hashes the rest',
      withTree(CONTRACT_WORLD, async ({ tree, worktree }) => {
        const { files, diagnostics } = await tree.hashPaths(worktree, [
          'a.txt',
          'keep/deleted.txt',
          'no/such.txt',
          'dir',
          'bad\nname.txt',
        ]);
        assert.deepEqual([...files.keys()], ['a.txt']);
        assert.deepEqual(diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`).sort(), [
          'gitlink_skipped:dir',
          'missing_on_disk:keep/deleted.txt',
          'missing_on_disk:no/such.txt',
          'unhashable_path:bad\nname.txt',
        ]);
      }),
    );

    describe('sourceSet', () => {
      const run = async (tree: SourceTree, worktree: string, extra: ReadonlyMap<string, string> = new Map()) => {
        const { files } = await tree.snapshot(worktree);
        return tree.sourceSet(worktree, new Map([...files, ...extra]), SOURCE_SET_OPTIONS);
      };
      const coded = (skipped: ReadonlyArray<{ code: string; subject?: string }>): string[] =>
        skipped.map((d) => `${d.code}:${d.subject ?? ''}`).sort();

      it(
        'keeps only claimed extensions (case-insensitive) and reports the rest as one aggregated extension_not_claimed count',
        withTree(SOURCE_SET_WORLD, async ({ tree, worktree }) => {
          const { files, skipped } = await run(tree, worktree);
          for (const kept of ['src/a.ts', 'lib/b.cjs', 'src/Upper.TS']) assert.ok(files.has(kept), kept);
          for (const dropped of ['README.md', 'notes.txt']) assert.ok(!files.has(dropped), dropped);
          const info = skipped.filter((d) => d.code === 'extension_not_claimed');
          assert.equal(info.length, 1, 'one aggregated diagnostic, not one per file');
          assert.equal(info[0]?.severity, 'info');
          assert.match(info[0]?.message ?? '', /\b2\b/);
          assert.ok(!skipped.some((d) => d.subject === 'README.md' || d.subject === 'notes.txt'));
        }),
      );

      it(
        'drops linguist-generated and linguist-vendored files and keeps one whose linguist-generated is explicitly unset',
        withTree(SOURCE_SET_WORLD, async ({ tree, worktree }) => {
          const { files, skipped } = await run(tree, worktree);
          assert.ok(!files.has('gen/out.ts'));
          assert.ok(!files.has('third_party/v.ts'));
          assert.ok(files.has('gen/unset.ts'));
          assert.ok(coded(skipped).includes('generated_skipped:gen/out.ts'));
          assert.ok(coded(skipped).includes('vendored_skipped:third_party/v.ts'));
          assert.ok(!coded(skipped).includes('generated_skipped:gen/unset.ts'));
        }),
      );

      it(
        'drops binary files (NUL in the first 8 KB), Git LFS pointers and oversize files, and keeps a NUL after the first 8 KB',
        withTree(SOURCE_SET_WORLD, async ({ tree, worktree }) => {
          const { files, skipped } = await run(tree, worktree);
          for (const dropped of ['bin/blob.ts', 'lfs/pointer.ts', 'big/huge.ts']) assert.ok(!files.has(dropped), dropped);
          assert.ok(files.has('late/nulbyte.ts'), 'only the first 8 KB is inspected for NUL');
          assert.deepEqual(
            coded(skipped).filter((c) => /^(binary|lfs_pointer|source_too_large)/.test(c)),
            ['binary_skipped:bin/blob.ts', 'lfs_pointer_skipped:lfs/pointer.ts', 'source_too_large:big/huge.ts'],
          );
        }),
      );

      it(
        'returns the surviving ids sorted by path in code-unit order, identically on repeated calls, and never an ignored secret',
        withTree(SOURCE_SET_WORLD, async ({ tree, worktree }) => {
          const first = await run(tree, worktree);
          const second = await run(tree, worktree);
          const expectedKeep = [
            'gen/unset.ts',
            'late/nulbyte.ts',
            'lib/b.cjs',
            'src/Upper.TS',
            'src/a.ts',
          ];
          const keys = [...first.files.keys()];
          assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
          assert.deepEqual(keys, expectedKeep);
          const oracle = new Map(expectedFiles(SOURCE_SET_WORLD));
          for (const [rel, id] of first.files) assert.equal(id, oracle.get(rel), rel);
          assert.deepEqual([...second.files], [...first.files]);
          assert.deepEqual(second.skipped, first.skipped);
          assert.ok(!first.files.has('config/secrets.ts'));
          assert.ok(!first.skipped.some((d) => d.subject === 'config/secrets.ts'));
        }),
      );

      it(
        'a path deleted after the snapshot gets missing_on_disk and the rest of the set is unaffected',
        withTree(SOURCE_SET_WORLD, async ({ tree, worktree }) => {
          const base = await run(tree, worktree);
          const raced = await run(tree, worktree, new Map([['gone/deleted.ts', '0'.repeat(40)]]));
          assert.deepEqual([...raced.files], [...base.files]);
          assert.deepEqual(
            coded(raced.skipped).filter((c) => !coded(base.skipped).includes(c)),
            ['missing_on_disk:gone/deleted.ts'],
          );
        }),
      );

      it(
        'an empty extension list or an empty file map returns an empty result',
        withTree(SOURCE_SET_WORLD, async ({ tree, worktree }) => {
          const { files } = await tree.snapshot(worktree);
          const noExt = await tree.sourceSet(worktree, files, { extensions: [], maxBytes: SOURCE_SET_OPTIONS.maxBytes });
          assert.equal(noExt.files.size, 0);
          assert.deepEqual(noExt.skipped, []);
          const noFiles = await tree.sourceSet(worktree, new Map(), SOURCE_SET_OPTIONS);
          assert.equal(noFiles.files.size, 0);
          assert.deepEqual(noFiles.skipped, []);
        }),
      );
    });

    describe('readText', () => {
      it(
        'returns the working-tree text of a regular file, including names with spaces and non-ASCII letters',
        withTree(READ_TEXT_WORLD, async ({ tree, worktree }) => {
          assert.deepEqual(await tree.readText(worktree, 'dir/inner.txt'), { kind: 'ok', text: 'inner\n' });
          assert.deepEqual(await tree.readText(worktree, 'untracked.txt'), { kind: 'ok', text: 'not committed\n' });
          assert.deepEqual(await tree.readText(worktree, 'café dir/ü file.txt'), { kind: 'ok', text: 'unicode\n' });
        }),
      );

      it(
        'preserves a leading BOM and CRLF line endings for the caller to deal with',
        withTree(READ_TEXT_WORLD, async ({ tree, worktree }) => {
          assert.deepEqual(await tree.readText(worktree, 'bom.txt'), { kind: 'ok', text: '\uFEFFhello\r\nworld\r\n' });
        }),
      );

      it(
        'answers missing for an absent path and not_file for a directory, without throwing',
        withTree(READ_TEXT_WORLD, async ({ tree, worktree }) => {
          assert.deepEqual(await tree.readText(worktree, 'no/such.txt'), { kind: 'missing' });
          assert.deepEqual(await tree.readText(worktree, 'dir'), { kind: 'not_file' });
          assert.deepEqual(await tree.readText(worktree, 'café dir'), { kind: 'not_file' });
        }),
      );

      it(
        'answers escape for an empty, parent-relative, absolute or NUL path (no throw)',
        withTree(READ_TEXT_WORLD, async ({ tree, worktree }) => {
          for (const bad of ['', '..', '../x', 'dir/../../x', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\x', 'a\0b']) {
            assert.deepEqual(await tree.readText(worktree, bad), { kind: 'escape' }, JSON.stringify(bad));
          }
        }),
      );

      it(
        'answers too_large over the byte cap and ok at exactly the cap',
        withTree(READ_TEXT_WORLD, async ({ tree, worktree }) => {
          assert.deepEqual(await tree.readText(worktree, 'hundred.txt', { maxBytes: 99 }), { kind: 'too_large' });
          assert.deepEqual(await tree.readText(worktree, 'hundred.txt', { maxBytes: 100 }), { kind: 'ok', text: 'z'.repeat(100) });
          assert.equal((await tree.readText(worktree, 'hundred.txt')).kind, 'ok');
        }),
      );
    });

    describe('history reads', () => {
      const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
      const text = (bytes: Uint8Array | null | undefined): string | null => (bytes === null || bytes === undefined ? null : Buffer.from(bytes).toString('utf8'));
      const idsOf = async (tree: SourceTree): Promise<{ head: string; first: string }> => {
        const head = await tree.resolveCommit('HEAD');
        const first = await tree.resolveCommit('HEAD~1');
        assert.ok(head !== null && first !== null);
        return { head, first };
      };

      it(
        'resolveCommit returns the full id of HEAD and of an earlier commit, null for an unknown revision',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { head, first } = await idsOf(tree);
          assert.match(head, FULL_ID);
          assert.match(first, FULL_ID);
          assert.notEqual(head, first);
          assert.equal(await tree.resolveCommit(first), first);
          assert.equal(await tree.resolveCommit('nosuchrev'), null);
          assert.equal(await tree.resolveCommit('f'.repeat(40)), null);
        }),
      );

      it(
        'resolveCommit rejects a revision git could read as an option and one holding NUL or a line break',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          for (const bad of ['--output=x', '-x', 'a\0b', 'a\nb', '']) {
            await assert.rejects(() => tree.resolveCommit(bad), { code: 'invalid_argument' }, JSON.stringify(bad));
          }
        }),
      );

      it(
        'listTree returns every blob of the commit with its mode, type and the git blob oid, sorted by path, from the commit and not the working tree',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { first } = await idsOf(tree);
          const { entries, diagnostics } = await tree.listTree(first);
          const expected = Object.entries(HISTORY_FIRST)
            .map(([rel, content]): [string, string] => [rel, blobId(content)])
            .sort(byPath);
          assert.deepEqual(
            entries.map((e): [string, string] => [e.path, e.oid]),
            expected,
          );
          assert.ok(entries.every((e) => e.type === 'blob' && e.mode === '100644'));
          assert.deepEqual(diagnostics, []);
          assert.ok(!entries.some((e) => e.path === 'untracked.ts'), 'the working tree is never listed');
          assert.equal(entries.find((e) => e.path === 'a.ts')?.oid, blobId(HISTORY_FIRST['a.ts'] ?? ''));
        }),
      );

      it(
        'listTree reports a symlink as symlink_skipped and a submodule as gitlink_skipped, keeps an executable as a blob, and does not list them as entries',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { head } = await idsOf(tree);
          const { entries, diagnostics } = await tree.listTree(head);
          assert.deepEqual(
            diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`).sort(),
            ['gitlink_skipped:vendor/sub', 'symlink_skipped:link.ts'],
          );
          assert.ok(!entries.some((e) => e.path === 'link.ts' || e.path === 'vendor/sub'));
          assert.equal(entries.find((e) => e.path === 'tool.sh')?.mode, '100755');
          assert.equal(entries.find((e) => e.path === 'a.ts')?.oid, blobId(HISTORY_SECOND['a.ts'] ?? ''));
          assert.ok(!entries.some((e) => e.path === 'old.ts'), 'a file deleted in this commit is absent');
          assert.deepEqual(entries.map((e) => e.path), entries.map((e) => e.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        }),
      );

      it(
        'listTree of an unknown commit id throws commit_not_found',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          await assert.rejects(() => tree.listTree('f'.repeat(40)), { code: 'commit_not_found' });
          await assert.rejects(() => tree.listTree('-x'), { code: 'invalid_argument' });
        }),
      );

      it(
        'readMany returns the exact bytes of the commit, null for a missing path and for a file deleted later, never the working tree',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { first } = await idsOf(tree);
          const { blobs, diagnostics } = await tree.readMany(first, ['a.ts', 'old.ts', 'missing.ts']);
          assert.equal(text(blobs.get('a.ts')), HISTORY_FIRST['a.ts']);
          assert.equal(text(blobs.get('old.ts')), HISTORY_FIRST['old.ts']);
          assert.equal(blobs.get('missing.ts'), null);
          assert.equal(blobs.size, 3);
          assert.deepEqual(diagnostics, []);
          const { head } = await idsOf(tree);
          const later = await tree.readMany(head, ['a.ts', 'old.ts']);
          assert.equal(text(later.blobs.get('a.ts')), HISTORY_SECOND['a.ts']);
          assert.equal(later.blobs.get('old.ts'), null);
        }),
      );

      it(
        'readMany returns a binary blob with NUL and a CRLF blob byte for byte, and handles names with spaces and non-ASCII letters',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { first } = await idsOf(tree);
          const { blobs } = await tree.readMany(first, ['bin/blob.dat', 'crlf.ts', 'sp ace/é.ts']);
          assert.deepEqual(Buffer.from(blobs.get('bin/blob.dat') ?? new Uint8Array()), Buffer.from(HISTORY_FIRST['bin/blob.dat'] ?? ''));
          assert.ok(Buffer.from(blobs.get('bin/blob.dat') ?? new Uint8Array()).includes(0), 'the NUL survived');
          assert.deepEqual(Buffer.from(blobs.get('crlf.ts') ?? new Uint8Array()), Buffer.from('one\r\ntwo\r\n'));
          assert.equal(text(blobs.get('sp ace/é.ts')), HISTORY_FIRST['sp ace/é.ts']);
        }),
      );

      it(
        'readMany answers a blob over the size cap with null and source_too_large, and still reads the blobs after it',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { first } = await idsOf(tree);
          const { blobs, diagnostics } = await tree.readMany(first, ['big.ts', 'a.ts'], { maxBlobBytes: 100 });
          assert.equal(blobs.get('big.ts'), null);
          assert.equal(text(blobs.get('a.ts')), HISTORY_FIRST['a.ts']);
          assert.deepEqual(diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`), ['source_too_large:big.ts']);
          const exact = await tree.readMany(first, ['big.ts'], { maxBlobBytes: 301 });
          assert.equal(exact.blobs.get('big.ts')?.length, 301);
        }),
      );

      it(
        'readMany of an empty list is an empty map, of a duplicated path reads it once, and of a path with a newline is null with unhashable_path',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          const { first } = await idsOf(tree);
          const none = await tree.readMany(first, []);
          assert.equal(none.blobs.size, 0);
          assert.deepEqual(none.diagnostics, []);
          const dup = await tree.readMany(first, ['a.ts', 'a.ts']);
          assert.equal(dup.blobs.size, 1);
          const bad = await tree.readMany(first, ['bad\nname.ts', 'a.ts']);
          assert.equal(bad.blobs.get('bad\nname.ts'), null);
          assert.equal(text(bad.blobs.get('a.ts')), HISTORY_FIRST['a.ts']);
          assert.deepEqual(bad.diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`), ['unhashable_path:bad\nname.ts']);
        }),
      );

      it(
        'readMany of an unknown commit id throws commit_not_found, and of an option-like commit throws invalid_argument',
        withTree(HISTORY_WORLD, async ({ tree }) => {
          await assert.rejects(() => tree.readMany('f'.repeat(40), ['a.ts']), { code: 'commit_not_found' });
          await assert.rejects(() => tree.readMany('-x', ['a.ts']), { code: 'invalid_argument' });
        }),
      );

      it(
        'history reads leave a repository without commits answerable: resolveCommit is null',
        withTree({ committed: {}, working: {}, ignored: [] }, async ({ tree }) => {
          assert.equal(await tree.resolveCommit('HEAD'), null);
        }),
      );
    });

    describe('worktrees', () => {
      it(
        'lists the main worktree of a one-worktree repository on its short branch name, attached, with its HEAD',
        withTree(CONTRACT_WORLD, async ({ tree }) => {
          const { rootCommit } = await tree.identity();
          const list = await tree.worktrees();
          assert.equal(list.length, 1);
          assert.deepEqual(
            { ...list[0], path: '' },
            { path: '', head: rootCommit, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
          );
        }),
      );

      it(
        'lists a repository with no commits with no head',
        withTree({ committed: {}, working: {}, ignored: [] }, async ({ tree }) => {
          const list = await tree.worktrees();
          assert.equal(list.length, 1);
          assert.equal(list[0]?.head, null);
          assert.equal(list[0]?.branch, 'main');
        }),
      );

      it(
        'identity reports a stable commonDir',
        withTree(CONTRACT_WORLD, async ({ tree }) => {
          const first = await tree.identity();
          assert.ok(first.commonDir.length > 0);
          assert.equal((await tree.identity()).commonDir, first.commonDir);
        }),
      );
    });
  });
}
