import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { FactStore, Reader, Resolver } from '../fact-store/index.ts';
import type { Clock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor } from '../governor/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { FakeClock, createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { DEFAULT_INDEXER_CONFIG, IndexerError, createIndexer, createManualEventSource } from './index.ts';
import type { Indexer, IndexerConfig, IndexerNotice } from './index.ts';

const { debounceMs } = DEFAULT_INDEXER_CONFIG;

/** A FakeClock that counts the timers armed through `after` that have neither fired nor been cancelled. */
class SpyClock extends FakeClock {
  live = 0;

  override after(ms: number, fn: () => void): () => void {
    this.live += 1;
    let open = true;
    const settle = (): void => {
      if (open) {
        open = false;
        this.live -= 1;
      }
    };
    const cancel = super.after(ms, () => {
      settle();
      fn();
    });
    return () => {
      settle();
      cancel();
    };
  }
}

/** What the Indexer asked Source Tree, in order. */
interface TreeLog {
  readonly hashPaths: string[][];
  snapshots: number;
  readonly readTexts: string[];
}

const newLog = (): TreeLog => ({ hashPaths: [], snapshots: 0, readTexts: [] });

/** Wraps a Source Tree so a test can see which paths were hashed and read. */
function recordingTree(log: TreeLog): (tree: SourceTree) => SourceTree {
  return (tree) => ({
    snapshot: (worktree) => {
      log.snapshots += 1;
      return tree.snapshot(worktree);
    },
    hashPaths: (worktree, paths) => {
      log.hashPaths.push([...paths]);
      return tree.hashPaths(worktree, paths);
    },
    sourceSet: (worktree, files, options) => tree.sourceSet(worktree, files, options),
    worktrees: () => tree.worktrees(),
    readText: (worktree, path, options) => {
      log.readTexts.push(path);
      return tree.readText(worktree, path, options);
    },
    hasObject: (hash) => tree.hasObject(hash),
    read: (commit, path) => tree.read(commit, path),
    identity: () => tree.identity(),
  });
}

/** Poll until `check` holds; the work behind it runs on real I/O, so there is no clock to advance. */
async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** The toy language module lives here; a `builtinDir` pointing at it makes `.toy` a claimed extension. */
const toyModules = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

/** A store without a precise resolver: it resolves nothing. */
const noResolver: Resolver = async function* () {
  // resolves nothing
};

/** Independent oracle: the git blob id of `content` in a SHA-1 repository. */
const blobId = (content: string | Uint8Array): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${String(body.length)}\0`).update(body).digest('hex');
};

interface WorldOptions {
  readonly files: Readonly<Record<string, string>>;
  /** Repo-relative paths kept out of git through `.git/info/exclude`; written as working files when listed in `working`. */
  readonly ignored?: readonly string[];
  /** Working-tree edits applied after the commit (a string edits or adds, `null` deletes). */
  readonly working?: Readonly<Record<string, string | null>>;
  readonly config?: Partial<IndexerConfig>;
  readonly clock?: FakeClock;
  readonly engine?: (real: GrammarEngine) => GrammarEngine;
  readonly governor?: (clock: Clock) => Governor;
  readonly wrapTree?: (tree: SourceTree) => SourceTree;
  /** Where the language modules are looked up. Default: the toy fixture module. */
  readonly builtinDir?: string | null;
  readonly onNotice?: (notice: IndexerNotice) => void;
}

interface World {
  readonly repo: TempGitRepo;
  readonly dir: string;
  readonly store: FactStore;
  readonly reader: Reader;
  readonly indexer: Indexer;
  readonly clock: FakeClock;
  readonly governor: Governor;
  readonly tree: SourceTree;
  /** A second Indexer over the same repository and store; the first must be stopped before it can write. */
  another(overrides?: Partial<WorldOptions>): Indexer;
}

/** A real repository, a real store and Source Tree, the real in-process engine, the real Governor and a fake clock. */
async function makeWorld(t: TestContext, options: WorldOptions): Promise<World> {
  const repo = await createTempGitRepo({
    runner: setupRunner,
    world: { committed: options.files, ignored: options.ignored ?? [], working: options.working ?? {} },
  });
  const tmp = makeTempDir();
  const clock = options.clock ?? new FakeClock(1000);
  const store = await openFactStore(
    path.join(tmp.path, 'store'),
    { resolver: noResolver, clock, gitHas: () => Promise.resolve(true) },
    { repo: 'toy', version: 'test' },
  );
  const realTree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
  const tree = options.wrapTree === undefined ? realTree : options.wrapTree(realTree);
  const realEngine = createGrammarEngine();
  const engine = options.engine === undefined ? realEngine : options.engine(realEngine);
  const governor = options.governor === undefined ? createGovernor({ clock }) : options.governor(clock);
  const roots = {
    repoRoot: repo.dir,
    userDir: path.join(tmp.path, 'user'),
    builtinDir: options.builtinDir === undefined ? toyModules : options.builtinDir,
    npmRoots: [],
  };
  const created: Indexer[] = [];
  const make = (overrides: Partial<WorldOptions> = {}): Indexer => {
    const indexer = createIndexer({
      tenant: 'test',
      tree,
      store,
      engine,
      roots: { ...roots, builtinDir: overrides.builtinDir === undefined ? roots.builtinDir : overrides.builtinDir },
      governor,
      clock,
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
    });
    created.push(indexer);
    return indexer;
  };
  const indexer = make();
  t.after(async () => {
    for (const each of created) await each.stop();
    await realEngine.dispose();
    await store.close();
    tmp.cleanup();
    repo.cleanup();
  });
  return { repo, dir: repo.dir, store, reader: store.at(repo.dir), indexer, clock, governor, tree, another: make };
}

const THREE_FILES = {
  'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'c.toy': 'type Widget {\n}\n',
  'README.md': '# toy repository\n',
};

describe('Indexer tracer: build a three-file toy repository and find a definition', () => {
  it('stores facts that find returns, with the blob id git computes as the overlay hash', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES, ignored: ['secret.log'], working: { 'secret.log': 'not source\n' } });
    const result = await world.indexer.build(world.dir);

    assert.equal(result.files, 3);
    assert.equal(result.parsed, 3);
    assert.equal(result.linked, 0);
    assert.equal(result.removed, 0);
    assert.deepEqual(result.failed, []);
    const unclaimed = result.skipped.filter((d) => d.code === 'extension_not_claimed');
    assert.equal(unclaimed.length, 1, 'the README is one aggregated unclaimed count');
    assert.match(unclaimed[0]?.message ?? '', /^1 file has an extension no loaded module claims/);
    assert.ok(!result.skipped.some((d) => d.subject === 'secret.log'), 'an ignored file never reaches the source set');

    const found = await world.reader.find('helper');
    assert.equal(found.data.length, 1);
    assert.equal(found.data[0]?.source_path, 'b.toy');
    assert.equal(found.data[0]?.identity.qualifiedName, 'helper');

    const a = await world.reader.fileFacts('a.toy');
    assert.deepEqual(a.data?.symbols.map((s) => s.name), ['main', 'boot']);
    assert.deepEqual(
      a.data?.refSites.map((s) => [s.name, s.kind, s.enclosing]),
      [['boot', 'call', 0]],
      'a call to a definition of the same file keeps its kind and its enclosing symbol (main is symbol 0)',
    );

    for (const file of ['a.toy', 'b.toy', 'c.toy']) {
      const stored = (await world.reader.fileFacts(file)).data?.contentHash;
      const oracle = (await world.repo.git(['hash-object', file])).trim();
      assert.equal(stored, oracle, `${file}: the stored hash is the one git hash-object prints`);
      assert.equal(stored, blobId(THREE_FILES[file as 'a.toy' | 'b.toy' | 'c.toy']));
    }
    assert.equal((await world.reader.fileFacts('README.md')).data, null);
    assert.equal((await world.reader.fileFacts('secret.log')).data, null);
  });

  it('a second build of unchanged files parses nothing, links all three and leaves the watermark where it was', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);
    const before = (await world.reader.find('helper')).watermark.seq;
    const again = await world.indexer.build(world.dir);
    assert.equal(again.parsed, 0);
    assert.equal(again.linked, 3);
    assert.equal(again.files, 3);
    assert.equal((await world.reader.find('helper')).watermark.seq, before);
  });

  it('content shared by two paths is attached with link, not parsed again', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);
    world.repo.write('d.toy', THREE_FILES['b.toy']);
    const again = await world.indexer.build(world.dir);
    assert.equal(again.parsed, 0, 'the hash of b.toy is known, so d.toy is linked to its facts');
    assert.equal(again.linked, 4);
    const found = await world.reader.find('helper');
    assert.deepEqual(found.data.map((r) => r.source_path).sort(), ['b.toy', 'd.toy']);
  });

  it('identical content in one first build is parsed once and linked for the other paths', async (t) => {
    const world = await makeWorld(t, { files: { 'one.toy': 'fn same {\n}\n', 'two.toy': 'fn same {\n}\n', 'three.toy': 'fn same {\n}\n' } });
    const result = await world.indexer.build(world.dir);
    assert.equal(result.files, 3);
    assert.equal(result.parsed, 1);
    assert.equal(result.linked, 2);
    assert.equal((await world.reader.find('same')).data.length, 3);
  });

  it('a CRLF working copy under eol=lf is stored under the blob id of its LF content, with the spans of the LF text', async (t) => {
    const lf = 'type Widget {\n}\n';
    const world = await makeWorld(t, { files: { '.gitattributes': '*.toy text eol=lf\n', 'c.toy': lf } });
    world.repo.write('c.toy', 'type Widget {\r\n}\r\n');
    const result = await world.indexer.build(world.dir);
    assert.equal(result.parsed, 1);
    const facts = (await world.reader.fileFacts('c.toy')).data;
    assert.equal(facts?.contentHash, blobId(lf));
    assert.equal(facts?.contentHash, (await world.repo.git(['hash-object', 'c.toy'])).trim());
    assert.deepEqual(facts?.symbols[0]?.span, { startLine: 0, startColumn: 0, endLine: 1, endColumn: 1 });
  });

  it('a BOM file has symbols that start after the BOM: the first token is at line 0, column 0', async (t) => {
    const world = await makeWorld(t, { files: { 'bom.toy': '﻿fn a {\n}\n' } });
    await world.indexer.build(world.dir);
    const facts = (await world.reader.fileFacts('bom.toy')).data;
    assert.equal(facts?.symbols[0]?.name, 'a');
    assert.equal(facts?.symbols[0]?.span.startLine, 0);
    assert.equal(facts?.symbols[0]?.span.startColumn, 0);
    assert.equal(facts?.contentHash, blobId('﻿fn a {\n}\n'), 'the hash covers the bytes with the BOM');
  });

  it('build throws lease_held while another holder has the writer slot, and works once it is released', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    const other = world.store.writer();
    await assert.rejects(world.indexer.build(world.dir), (error: unknown) => error instanceof IndexerError && error.code === 'lease_held');
    other.release();
    const result = await world.indexer.build(world.dir);
    assert.equal(result.parsed, 3);
  });

  it('build of a directory that is not a worktree of the repository throws unknown_worktree', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await assert.rejects(
      world.indexer.build(path.join(world.dir, 'nowhere')),
      (error: unknown) => error instanceof IndexerError && error.code === 'unknown_worktree',
    );
  });
});

describe('Indexer events: the coalescing queue and the event source', () => {
  it('a saved change reaches the store after the debounce, and no work starts before it', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log), clock: new SpyClock(1000) });
    await world.indexer.build(world.dir);
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    log.hashPaths.length = 0;

    world.repo.write('b.toy', 'fn helper {\n}\nfn extra {\n}\n');
    manual.emit(world.dir, 'b.toy');
    await world.clock.advance(debounceMs - 1);
    assert.equal(log.hashPaths.length, 0, 'nothing is hashed inside the debounce window');
    await world.clock.advance(1);
    await eventually(async () => (await world.reader.find('extra')).data.length === 1, 'the edit to reach the store');
    assert.deepEqual(log.hashPaths, [['b.toy']], 'one batched hash for the one path');
    assert.equal((await world.reader.find('helper')).data.length, 1);
  });

  it('a new file appears and a deleted file disappears', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES, clock: new SpyClock(1000) });
    await world.indexer.build(world.dir);
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);

    world.repo.write('e.toy', 'fn fresh {\n}\n');
    world.repo.remove('b.toy');
    manual.emit(world.dir, 'e.toy');
    manual.emit(world.dir, 'b.toy');
    await world.clock.advance(debounceMs);
    await eventually(
      async () => (await world.reader.find('fresh')).data.length === 1 && (await world.reader.find('helper')).data.length === 0,
      'the new file to appear and the deleted one to go',
    );
    assert.equal((await world.reader.fileFacts('b.toy')).data, null);
  });

  it('an event for an ignored file never reaches hashPaths or the parser, even with a claimed extension', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, {
      files: THREE_FILES,
      ignored: ['skip.toy'],
      working: { 'skip.toy': 'fn Secret {\n}\n' },
      wrapTree: recordingTree(log),
      clock: new SpyClock(1000),
    });
    await world.indexer.build(world.dir);
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    log.hashPaths.length = 0;
    log.readTexts.length = 0;
    const snapshotsAfterBuild = log.snapshots;

    world.repo.write('skip.toy', 'fn Secret {\n}\nfn Another {\n}\n');
    world.repo.write('b.toy', 'fn helper {\n}\nfn marker {\n}\n');
    manual.emit(world.dir, 'skip.toy');
    manual.emit(world.dir, 'b.toy');
    await world.clock.advance(debounceMs);
    await eventually(async () => (await world.reader.find('marker')).data.length === 1, 'the same batch to finish');

    assert.deepEqual(log.hashPaths, [['b.toy']], 'hashPaths hashes what it is asked, so the ignored path is dropped before it');
    assert.ok(!log.readTexts.includes('skip.toy'));
    assert.equal(log.snapshots, snapshotsAfterBuild + 1, 'one snapshot decided that the unknown path is ignored');
    assert.equal((await world.reader.find('Secret')).data.length, 0);

    // The verdict is remembered: the same ignored path costs no second snapshot.
    manual.emit(world.dir, 'skip.toy');
    manual.emit(world.dir, 'c.toy');
    await world.clock.advance(debounceMs);
    await eventually(async () => log.hashPaths.length === 2, 'the second batch to be hashed');
    assert.deepEqual(log.hashPaths[1], ['c.toy']);
    assert.equal(log.snapshots, snapshotsAfterBuild + 1);
  });

  it('events arriving in reverse path order are hashed in code-unit path order', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log), clock: new SpyClock(1000) });
    await world.indexer.build(world.dir);
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    log.hashPaths.length = 0;

    for (const path of ['c.toy', 'b.toy', 'a.toy']) manual.emit(world.dir, path);
    await world.clock.advance(debounceMs);
    await eventually(async () => log.hashPaths.length === 1, 'the batch to be hashed');
    assert.deepEqual(log.hashPaths[0], ['a.toy', 'b.toy', 'c.toy']);
  });

  it('submit drops a path that is absolute, climbs out with .. or holds NUL', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log), clock: new SpyClock(1000) });
    await world.indexer.build(world.dir);
    log.hashPaths.length = 0;
    for (const bad of ['/etc/passwd.toy', '../outside.toy', 'a/../../outside.toy', 'nul\0.toy', '']) world.indexer.submit(world.dir, bad);
    world.indexer.submit(world.dir, 'b.toy');
    await world.clock.advance(debounceMs * 3);
    await eventually(async () => log.hashPaths.length >= 1, 'the valid path to be hashed');
    assert.deepEqual(log.hashPaths, [['b.toy']], 'only the repo-relative path is ever hashed');
  });

  it('watcher problems are recorded per worktree and kind, and stop unsubscribes the source and leaves no timer', async (t) => {
    const clock = new SpyClock(1000);
    const world = await makeWorld(t, { files: THREE_FILES, clock });
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    assert.equal(manual.subscriptions(), 1);
    manual.emitProblem(world.dir, 'overflow');
    manual.emitProblem(world.dir, 'overflow');
    manual.emitProblem(world.dir, 'error');
    assert.deepEqual(world.indexer.status().watchProblems, [
      { worktree: world.dir, kind: 'error', count: 1 },
      { worktree: world.dir, kind: 'overflow', count: 2 },
    ]);
    manual.emit(world.dir, 'a.toy');
    assert.equal(clock.live, 1, 'an event arms the queue timer');
    await world.indexer.stop();
    assert.equal(manual.subscriptions(), 0);
    assert.equal(clock.live, 0);
  });
});
