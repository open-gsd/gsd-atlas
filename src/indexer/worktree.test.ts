import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { UnknownWorktree } from '../fact-store/index.ts';
import { makeTempDir, realPath } from '../test-kit/index.ts';
import { DEFAULT_INDEXER_CONFIG, createManualEventSource, gitDirNameOf, isInside } from './index.ts';
import {
  SpyClock,
  THREE_FILES,
  countingEngine,
  eventually,
  makeWorld,
  shippedModules,
  writeFiles,
} from './harness.test.ts';
import type { EngineLog, World } from './harness.test.ts';

const { debounceMs } = DEFAULT_INDEXER_CONFIG;

/** Wait until no Reconcile is running; a HEAD or worktrees event starts its run synchronously. */
const idle = (world: World): Promise<void> =>
  eventually(async () => !world.indexer.status().reconciling, 'the Reconcile to finish');

const commonDirOf = async (world: World): Promise<string> => (await world.tree.identity()).commonDir;

/**
 * Replace the `.git` file of a linked worktree. On Windows git marks `.git` hidden, and Windows refuses to open a hidden
 * file for writing (EPERM, found by plan 02-26 on Windows CI), so the file is removed first.
 */
function writeGitFile(worktree: string, text: string): void {
  const file = path.join(worktree, '.git');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text);
}

/** A reader of a worktree the store may not know yet: the symbol names found, or null while the overlay is unknown. */
async function namesIn(world: World, worktree: string, name: string): Promise<number | null> {
  try {
    return (await world.store.at(worktree).find(name)).data.length;
  } catch (error) {
    if (error instanceof UnknownWorktree) return null;
    throw error;
  }
}

describe('git directory names: the .git of a worktree leads into the common git directory or nowhere', () => {
  it('names the main worktree with the empty name and a linked worktree with its directory under worktrees', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    const common = await commonDirOf(world);
    const linked = await world.addWorktree('named');
    assert.equal(gitDirNameOf(world.dir, common), '');
    const name = gitDirNameOf(linked, common);
    assert.ok(name !== null && name !== '', 'a linked worktree has a name');
    assert.equal(fs.existsSync(path.join(common, 'worktrees', name)), true);
  });

  it('refuses a .git file that names a directory outside the common git directory', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    const common = await commonDirOf(world);
    const linked = await world.addWorktree('escape');
    const outside = makeTempDir();
    t.after(() => outside.cleanup());

    writeGitFile(linked, `gitdir: ${outside.path}\n`);
    assert.equal(gitDirNameOf(linked, common), null, 'a directory outside the common git directory');

    fs.mkdirSync(path.join(outside.path, 'worktrees', 'fake'), { recursive: true });
    writeGitFile(linked, `gitdir: ${path.join(outside.path, 'worktrees', 'fake')}\n`);
    assert.equal(gitDirNameOf(linked, common), null, 'a look-alike worktrees directory somewhere else');

    writeGitFile(linked, `gitdir: ${path.join(common, 'objects')}\n`);
    assert.equal(gitDirNameOf(linked, common), null, 'inside the common git directory but not a worktree entry');

    writeGitFile(linked, 'not a git file\n');
    assert.equal(gitDirNameOf(linked, common), null, 'no gitdir line');
    fs.rmSync(path.join(linked, '.git'), { force: true });
    assert.equal(gitDirNameOf(linked, common), null, 'no .git at all');
  });

  it('follows a relative gitdir and reads at most a short file', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    const common = await commonDirOf(world);
    const linked = await world.addWorktree('relative');
    const name = gitDirNameOf(linked, common) as string;
    writeGitFile(linked, `gitdir: ${path.relative(linked, path.join(common, 'worktrees', name))}\n`);
    assert.equal(gitDirNameOf(linked, common), name);
    writeGitFile(linked, `${'#'.repeat(10000)}\ngitdir: ${path.join(common, 'worktrees', name)}\n`);
    assert.equal(gitDirNameOf(linked, common), null, 'the gitdir line lies beyond the bytes that are read');
  });

  it('isInside compares real paths with a trailing separator, so a sibling with the same prefix is not inside', () => {
    const tmp = makeTempDir();
    try {
      const base = realPath(tmp.path);
      fs.mkdirSync(path.join(base, 'b', 'deep'), { recursive: true });
      fs.mkdirSync(path.join(base, 'bc'));
      assert.equal(isInside(path.join(base, 'b'), path.join(base, 'b', 'deep')), true);
      assert.equal(isInside(path.join(base, 'b'), path.join(base, 'b')), true);
      assert.equal(isInside(path.join(base, 'b'), path.join(base, 'bc')), false);
      assert.equal(isInside(path.join(base, 'b'), path.join(base, 'missing')), false);
      if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(base, 'bc'), path.join(base, 'b', 'link'));
        assert.equal(isInside(path.join(base, 'b'), path.join(base, 'b', 'link')), false, 'a link out of the parent resolves outside');
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('Indexer worktrees: every worktree is covered by one leader over one shared store', () => {
  it('start subscribes both worktree roots and the common git directory once, and the store holds each content once', async (t) => {
    const manual = createManualEventSource();
    const engine: EngineLog = { sources: [] };
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source, engine: countingEngine(engine) });
    const other = await world.addWorktree('second');

    await world.indexer.start();

    assert.equal(manual.subscriptions(), 2);
    assert.deepEqual(manual.gitSubscriptions(), [await commonDirOf(world)]);
    assert.equal(engine.sources.length, 3, 'three distinct contents are parsed once; the second worktree links to them');
    assert.equal((await world.store.at(world.dir).find('helper')).data.length, 1);
    assert.equal((await world.store.at(other).find('helper')).data.length, 1);
    assert.deepEqual(
      (await world.store.at(other).find('helper')).data.map((r) => r.source_path),
      ['b.toy'],
    );
  });

  it('the leader indexes every worktree: an event in each root updates its own overlay and not the other', async (t) => {
    const manual = createManualEventSource();
    const clock = new SpyClock(1000);
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source, clock });
    const other = await world.addWorktree('second');
    await world.indexer.start();

    writeFiles(world.dir, { 'a.toy': 'fn main {\n}\nfn only_in_main {\n}\n' });
    writeFiles(other, { 'b.toy': 'fn helper {\n}\nfn only_in_second {\n}\n' });
    manual.emit(world.dir, 'a.toy');
    manual.emit(other, 'b.toy');
    await clock.advance(debounceMs);
    await eventually(
      async () => (await namesIn(world, world.dir, 'only_in_main')) === 1 && (await namesIn(world, other, 'only_in_second')) === 1,
      'both overlays to update',
    );
    assert.equal(await namesIn(world, world.dir, 'only_in_second'), 0);
    assert.equal(await namesIn(world, other, 'only_in_main'), 0);
  });

  it('a HEAD event of a linked worktree reconciles that worktree and no other', async (t) => {
    const manual = createManualEventSource();
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source });
    const other = await world.addWorktree('second');
    await world.indexer.start();

    writeFiles(world.dir, { 'a.toy': 'fn main {\n}\nfn missed_in_main {\n}\n' });
    writeFiles(other, { 'a.toy': 'fn main {\n}\nfn missed_in_second {\n}\n' });
    manual.emitHead(other);
    await eventually(async () => (await namesIn(world, other, 'missed_in_second')) === 1, 'the linked worktree to reconcile');
    await idle(world);
    assert.equal(await namesIn(world, world.dir, 'missed_in_main'), 0, 'the main worktree was not asked');
  });

  it('a worktree added after start is subscribed and indexed, and a removed one is unsubscribed and its overlay dropped', async (t) => {
    const manual = createManualEventSource();
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source });
    await world.indexer.start();
    assert.equal(manual.subscriptions(), 1);

    const added = await world.addWorktree('late');
    manual.emitWorktrees();
    await eventually(async () => (await namesIn(world, added, 'helper')) === 1, 'the new worktree to be indexed');
    assert.equal(manual.subscriptions(), 2);

    await world.repo.git(['worktree', 'remove', '--force', added]);
    manual.emitWorktrees();
    await eventually(async () => manual.subscriptions() === 1, 'the removed worktree to be unsubscribed');
    await idle(world);
    await assert.rejects(async () => world.store.at(added).find('helper'), (error: unknown) => error instanceof UnknownWorktree);
    assert.equal((await world.reader.find('helper')).data.length, 1, 'the other overlay and the shared facts remain');
  });

  it('start with named worktrees covers only those: a worktree added later is not indexed until attach', async (t) => {
    const manual = createManualEventSource();
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source });
    const other = await world.addWorktree('second');
    await world.indexer.start({ worktrees: [world.dir] });
    assert.equal(manual.subscriptions(), 1);
    assert.equal(await namesIn(world, other, 'helper'), null, 'nothing is indexed without an explicit request');

    manual.emitWorktrees();
    await idle(world);
    assert.equal(await namesIn(world, other, 'helper'), null, 'a new worktree is not covered by a named start');

    await world.indexer.attach(other);
    assert.equal(manual.subscriptions(), 2);
    assert.equal(await namesIn(world, other, 'helper'), 1);
    assert.equal(manual.gitSubscriptions().length, 1, 'the git directory is subscribed once');
  });

  it('a worktree whose .git file names a directory outside the common git directory is not watched or indexed', async (t) => {
    const manual = createManualEventSource();
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source });
    const hostile = await world.addWorktree('hostile');
    const outside = makeTempDir();
    t.after(() => outside.cleanup());
    writeGitFile(hostile, `gitdir: ${outside.path}\n`);

    await world.indexer.start();

    assert.equal(manual.subscriptions(), 1, 'only the main worktree root is watched');
    assert.equal(await namesIn(world, hostile, 'helper'), null);
    await assert.rejects(
      world.indexer.start({ worktrees: [hostile] }),
      (error: unknown) => (error as { code?: string }).code === 'unknown_worktree',
    );
    assert.equal(manual.subscriptions(), 1);
  });

  it('a problem of the git watch reconciles every covered worktree and is counted', async (t) => {
    const manual = createManualEventSource();
    const world = await makeWorld(t, { files: THREE_FILES, source: manual.source });
    await world.indexer.start();
    writeFiles(world.dir, { 'c.toy': 'type Widget {\n}\nfn after_git_problem {\n}\n' });

    manual.emitGitProblem('overflow');
    await eventually(async () => (await namesIn(world, world.dir, 'after_git_problem')) === 1, 'the Reconcile to repair the edit');
    assert.deepEqual(world.indexer.status().watchProblems, [
      { worktree: await commonDirOf(world), kind: 'overflow', count: 1 },
    ]);
  });
});

describe('Indexer branch switches: only the changed files are parsed and each branch resolves its own targets', () => {
  const nn = (n: number): string => String(n).padStart(2, '0');
  const thirty = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`f${nn(n)}.toy`, `fn sym_${nn(n)} {\n}\n`]));

  it('branch switch: parses exactly the 3 changed files, links the rest, and switching back parses 0', async (t) => {
    const manual = createManualEventSource();
    const engine: EngineLog = { sources: [] };
    const world = await makeWorld(t, { files: thirty, source: manual.source, engine: countingEngine(engine) });
    await world.indexer.start();
    assert.equal(engine.sources.length, 30);

    // Build the feature branch (2 files changed, 1 added) without telling the Indexer, then go back to main.
    await world.repo.git(['checkout', '--quiet', '-b', 'feature']);
    writeFiles(world.dir, {
      'f01.toy': 'fn sym_01 {\n}\nfn feature_01 {\n}\n',
      'f02.toy': 'fn sym_02 {\n}\nfn feature_02 {\n}\n',
      'f30.toy': 'fn feature_30 {\n}\n',
    });
    await world.repo.commitAll('feature work');
    await world.repo.git(['checkout', '--quiet', 'main']);
    assert.equal((await world.reader.find('feature_30')).data.length, 0, 'nothing was reported, so the store still shows main');

    engine.sources.length = 0;
    await world.repo.git(['checkout', '--quiet', 'feature']);
    manual.emitHead(world.dir);
    await eventually(async () => (await world.reader.find('feature_30')).data.length === 1, 'the branch switch to be reconciled');
    await idle(world);
    assert.equal(engine.sources.length, 3, 'exactly the 2 changed files and the 1 added file are parsed');
    assert.equal(world.indexer.status().lastReconcile?.changed, 3);
    assert.equal((await world.reader.find('sym_20')).data.length, 1, 'a symbol of an unchanged file is still found');
    assert.equal((await world.reader.find('feature_01')).data.length, 1);
    assert.equal(world.indexer.status().failed.length, 0);

    await world.repo.git(['checkout', '--quiet', 'main']);
    manual.emitHead(world.dir);
    await eventually(async () => (await world.reader.find('feature_30')).data.length === 0, 'the switch back to be reconciled');
    await idle(world);
    assert.equal(engine.sources.length, 3, 'switching back parses 0 files: every hash is known');
    assert.equal(world.indexer.status().lastReconcile?.changed, 3);
    assert.equal((await world.reader.find('sym_01')).data.length, 1);
    assert.equal((await world.reader.find('feature_01')).data.length, 0);
    assert.equal((await world.reader.find('sym_20')).data.length, 1);
  });

  it('two-branch targets: an unchanged importer resolves to src/b.ts on one branch and src/b/index.ts on the other', async (t) => {
    const manual = createManualEventSource();
    const engine: EngineLog = { sources: [] };
    const bTs = 'export function run(): number {\n  return 1;\n}\n';
    const bIndex = `// the module moved into a directory\n${bTs}`;
    const mainTs = "import { run } from './b';\n\nexport function go(): number {\n  return run();\n}\n";
    const world = await makeWorld(t, {
      files: { 'src/b.ts': bTs, 'src/main.ts': mainTs },
      source: manual.source,
      engine: countingEngine(engine),
      builtinDir: shippedModules,
    });
    await world.indexer.start();

    const sitesOf = async (identity: { repo: string; path: string; qualifiedName: string; kind: string }): Promise<string[]> =>
      (await world.reader.refs(identity)).data.map((r) => r.source_path);
    const runDefinition = async (): Promise<{ repo: string; path: string; qualifiedName: string; kind: string }> => {
      const found = (await world.reader.find('run')).data;
      assert.equal(found.length, 1);
      const [only] = found;
      assert.ok(only !== undefined);
      return only.identity;
    };

    const onMain = await runDefinition();
    assert.equal(onMain.path, 'src/b.ts');
    assert.deepEqual(await sitesOf(onMain), ['src/main.ts'], 'main: the call site in src/main.ts belongs to src/b.ts');
    assert.deepEqual(await sitesOf({ ...onMain, path: 'src/b/index.ts' }), [], 'main: the other target is not in the overlay');

    await world.repo.git(['checkout', '--quiet', '-b', 'feature']);
    await world.repo.git(['rm', '--quiet', 'src/b.ts']);
    writeFiles(world.dir, { 'src/b/index.ts': bIndex });
    await world.repo.commitAll('move b into a directory');
    await world.repo.git(['checkout', '--quiet', 'main']);

    await world.repo.git(['checkout', '--quiet', 'feature']);
    manual.emitHead(world.dir);
    await eventually(async () => (await world.reader.find('run')).data[0]?.source_path === 'src/b/index.ts', 'feature to be reconciled');
    await idle(world);
    const onFeature = await runDefinition();
    assert.equal(onFeature.path, 'src/b/index.ts');
    assert.deepEqual(await sitesOf(onFeature), ['src/main.ts'], 'feature: the same unchanged call site belongs to src/b/index.ts');
    assert.deepEqual(await sitesOf({ ...onFeature, path: 'src/b.ts' }), [], 'feature: the other target is not in the overlay');

    await world.repo.git(['checkout', '--quiet', 'main']);
    manual.emitHead(world.dir);
    await eventually(async () => (await world.reader.find('run')).data[0]?.source_path === 'src/b.ts', 'main to be reconciled');
    await idle(world);
    assert.deepEqual(await sitesOf(await runDefinition()), ['src/main.ts']);

    const importerParses = engine.sources.filter((source) => source.includes("from './b'")).length;
    assert.equal(importerParses, 1, 'src/main.ts is parsed once in total, across both switches');
    assert.equal(engine.sources.length, 3, 'src/main.ts, src/b.ts, and src/b/index.ts once each');
  });
});
