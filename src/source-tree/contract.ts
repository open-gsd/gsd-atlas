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
  });
}
