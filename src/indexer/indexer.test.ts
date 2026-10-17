import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { FactStore, Reader, Resolver } from '../fact-store/index.ts';
import type { Clock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor, Job } from '../governor/index.ts';
import { GrammarRunError, createGrammarEngine } from '../grammar-engine/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { FakeClock, createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { DEFAULT_INDEXER_CONFIG, IndexerError, createIndexer, createManualEventSource } from './index.ts';
import type { EventSource, Indexer, IndexerConfig, IndexerNotice } from './index.ts';

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
    resolveCommit: (rev) => tree.resolveCommit(rev),
    listTree: (commit) => tree.listTree(commit),
    readMany: (commit, paths, options) => tree.readMany(commit, paths, options),
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

/** A Governor that records every job it is asked to run and delegates to a real one. */
function spyGovernor(real: Governor, jobs: Job[]): Governor {
  return {
    run<T>(job: Job, fn: (signal: AbortSignal) => Promise<T>) {
      jobs.push(job);
      return real.run(job, fn);
    },
    lease: (key, estimatedBytes, onEvict) => real.lease(key, estimatedBytes, onEvict),
    status: () => real.status(),
  };
}

/** The real engine with a hook that runs before every parse; the hook may reject or wait. */
function scriptedEngine(onRun: (source: string) => Promise<void> | void): (real: GrammarEngine) => GrammarEngine {
  return (real) => ({
    load: async (input) => {
      const grammar = await real.load(input);
      return {
        name: grammar.name,
        abi: grammar.abi,
        run: async (source) => {
          await onRun(source);
          return grammar.run(source);
        },
        dispose: () => grammar.dispose(),
      };
    },
    dispose: () => real.dispose(),
  });
}

interface RaceHook {
  armed: boolean;
  reads: number;
  /** The content to write into a.toy after its read number `reads`, or undefined to leave it alone. */
  next(reads: number): string | undefined;
}

/** A Source Tree that rewrites a.toy right after the Indexer has read it: the file changes during indexing. */
function racingTree(log: TreeLog, hook: RaceHook): (tree: SourceTree) => SourceTree {
  const record = recordingTree(log);
  return (tree) => {
    const wrapped = record(tree);
    return {
      ...wrapped,
      readText: async (worktree, relPath, options) => {
        const result = await wrapped.readText(worktree, relPath, options);
        if (hook.armed && relPath === 'a.toy') {
          hook.reads += 1;
          const content = hook.next(hook.reads);
          if (content !== undefined) fs.writeFileSync(path.join(worktree, relPath), content);
        }
        return result;
      },
    };
  };
}

const requeued = (notices: readonly IndexerNotice[]): number => notices.filter((n) => n.kind === 'requeued').length;

describe('Indexer ensureFresh, the hash and parse race, failures and status', () => {
  it('ensureFresh indexes the named path at once, with no clock advance, and cancels the pending debounce timer', async (t) => {
    const log = newLog();
    const notices: IndexerNotice[] = [];
    const clock = new SpyClock(1000);
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log), clock, onNotice: (n) => notices.push(n) });
    await world.indexer.build(world.dir);
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    log.hashPaths.length = 0;
    notices.length = 0;
    // The store keeps one timer of its own (the dirty-sentinel idle timer); the Indexer's timers are counted over it.
    const storeTimers = clock.live;

    world.repo.write('a.toy', 'fn main {\n}\nfn fresh_one {\n}\n');
    manual.emit(world.dir, 'a.toy');
    assert.equal(clock.live, storeTimers + 1, 'the event armed the queue timer');
    await clock.advance(30);
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);

    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.equal((await world.reader.find('fresh_one')).data.length, 1);
    assert.equal(clock.live, storeTimers, 'neither the debounce timer nor the wait timer is left');
    await clock.advance(debounceMs * 3);
    assert.deepEqual(log.hashPaths, [['a.toy']], 'the superseded queue entry did not run a second job');
    const indexed = notices.flatMap((n) => (n.kind === 'indexed' ? [n] : []));
    assert.deepEqual(
      indexed.map((n) => [n.path, n.lagMs]),
      [['a.toy', 30]],
      'lag is measured from the first event of the entry ensureFresh took over',
    );
  });

  it('a queue entry and ensureFresh for one path end with the newest content, in one job', async (t) => {
    const log = newLog();
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log), clock: new SpyClock(1000) });
    await world.indexer.build(world.dir);
    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    log.hashPaths.length = 0;

    world.repo.write('a.toy', 'fn first_edit {\n}\n');
    manual.emit(world.dir, 'a.toy');
    const newest = 'fn newest_edit {\n}\n';
    world.repo.write('a.toy', newest);
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);
    await world.clock.advance(debounceMs * 3);
    assert.equal(result.complete, true);
    assert.equal((await world.reader.fileFacts('a.toy')).data?.contentHash, blobId(newest));
    assert.equal((await world.reader.find('first_edit')).data.length, 0);
    assert.equal(log.hashPaths.length, 1);
  });

  it('fresh slot: ensureFresh of three paths runs every job in the fresh class under one request id', async (t) => {
    const jobs: Job[] = [];
    const world = await makeWorld(t, { files: THREE_FILES, governor: (clock) => spyGovernor(createGovernor({ clock }), jobs) });
    await world.indexer.build(world.dir);
    jobs.length = 0;

    world.repo.write('a.toy', 'fn main {\n}\nfn x1 {\n}\n');
    world.repo.write('b.toy', 'fn helper {\n}\nfn x2 {\n}\n');
    world.repo.write('c.toy', 'type Widget {\n}\nfn x3 {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['c.toy', 'a.toy', 'b.toy']);
    assert.equal(result.complete, true);
    assert.ok(jobs.length >= 4, `one preparation job and one per path, saw ${String(jobs.length)}`);
    assert.ok(jobs.every((job) => job.class === 'fresh'), 'no indexing-class job for a fresh request');
    const ids = new Set(jobs.map((job) => job.requestId));
    assert.equal(ids.size, 1, 'one request id, so the Governor gives the request one slot');
    assert.notEqual([...ids][0], undefined);
    for (const name of ['x1', 'x2', 'x3']) assert.equal((await world.reader.find(name)).data.length, 1);
  });

  it('invalid: absolute, dot-dot, NUL and symlink-escape paths are refused and never hashed or read', async (t) => {
    const log = newLog();
    const outside = makeTempDir();
    t.after(() => outside.cleanup());
    const target = path.join(outside.path, 'outside.toy');
    fs.writeFileSync(target, 'fn Outside {\n}\n');
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: recordingTree(log) });
    await world.indexer.build(world.dir);
    log.hashPaths.length = 0;
    log.readTexts.length = 0;

    const bad = ['/etc/hosts.toy', '../x.toy', 'sub/../../x.toy', 'nul\0.toy'];
    if (process.platform !== 'win32') {
      // Creating a symlink needs a privilege on Windows runners; the lexical refusals above still run there.
      fs.symlinkSync(target, path.join(world.dir, 'escape.toy'));
      bad.push('escape.toy');
    }
    world.repo.write('b.toy', 'fn helper {\n}\nfn valid_one {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, [...bad.slice(0, 2), 'b.toy', ...bad.slice(2)]);

    assert.deepEqual(result.invalid, bad, 'refused paths are listed in request order');
    assert.equal(result.complete, true);
    assert.deepEqual(result.stalePaths, []);
    assert.deepEqual(log.hashPaths, [['b.toy']]);
    assert.deepEqual(log.readTexts, ['b.toy']);
    assert.equal((await world.reader.find('Outside')).data.length, 0);
  });

  it('ensureFresh of a directory that is not a worktree of the repository throws unknown_worktree', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await assert.rejects(
      world.indexer.ensureFresh(path.join(world.dir, 'nowhere'), ['a.toy']),
      (error: unknown) => error instanceof IndexerError && error.code === 'unknown_worktree',
    );
  });

  it('race: a file edited while it is read is read again, and the stored facts match its final content', async (t) => {
    const log = newLog();
    const notices: IndexerNotice[] = [];
    const hook: RaceHook = { armed: false, reads: 0, next: (n) => (n === 1 ? 'fn racing {\n}\nfn second {\n}\n' : undefined) };
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: racingTree(log, hook), onNotice: (n) => notices.push(n) });
    await world.indexer.build(world.dir);
    world.repo.write('a.toy', 'fn firstversion {\n}\n');
    hook.armed = true;
    notices.length = 0;

    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.equal(hook.reads, 2, 'the interim content was read once, the final content once');
    assert.equal(requeued(notices), 1);
    const final = 'fn racing {\n}\nfn second {\n}\n';
    assert.equal((await world.reader.fileFacts('a.toy')).data?.contentHash, blobId(final));
    assert.equal((await world.reader.find('second')).data.length, 1);
    assert.equal((await world.reader.find('firstversion')).data.length, 0, 'nothing was committed for the interim content');
  });

  it('race: a file that changes on every read is given up after the configured retries and reported stale', async (t) => {
    const log = newLog();
    const notices: IndexerNotice[] = [];
    const hook: RaceHook = { armed: false, reads: 0, next: (n) => `fn changing${'x'.repeat(n)} {\n}\n` };
    const world = await makeWorld(t, { files: THREE_FILES, wrapTree: racingTree(log, hook), onNotice: (n) => notices.push(n) });
    await world.indexer.build(world.dir);
    world.repo.write('a.toy', 'fn startpoint {\n}\n');
    hook.armed = true;
    notices.length = 0;

    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.deepEqual(result, { complete: false, stalePaths: ['a.toy'], invalid: [] });
    assert.equal(hook.reads, 4, 'the first read and three more');
    assert.equal(requeued(notices), 3, 'one requeued notice per retry');
    assert.deepEqual(world.indexer.status().failed, [{ worktree: world.dir, path: 'a.toy', code: 'unstable' }]);
    assert.deepEqual((await world.reader.fileFacts('a.toy')).data?.symbols.map((s) => s.name), ['main', 'boot'], 'the earlier facts stay');
    assert.equal((await world.reader.find('changing', { mode: 'prefix' })).data.length, 0);
    assert.equal((await world.reader.find('startpoint')).data.length, 0);
  });

  it('busy governor: ensureFresh answers incomplete when the wait ends, and the queued work finishes later', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES, governor: (clock) => createGovernor({ clock, concurrency: 1 }) });
    await world.indexer.build(world.dir);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = world.governor.run({ tenant: 'other', class: 'indexing', cost: 1 }, () => gate);

    world.repo.write('a.toy', 'fn main {\n}\nfn late_one {\n}\n');
    const pending = world.indexer.ensureFresh(world.dir, ['a.toy'], 500);
    await world.clock.advance(500);
    const result = await pending;
    assert.deepEqual(result, { complete: false, stalePaths: ['a.toy'], invalid: [] });
    assert.equal(world.indexer.status().queued, 1, 'the work was not cancelled; it is waiting for a slot');
    assert.equal((await world.reader.find('late_one')).data.length, 0);

    release();
    await blocker;
    await eventually(async () => (await world.reader.find('late_one')).data.length === 1, 'the queued work to finish');
  });

  it('parse failure: a failing file keeps its earlier facts, is counted with its code, and the next file is still processed', async (t) => {
    const notices: IndexerNotice[] = [];
    const world = await makeWorld(t, {
      files: THREE_FILES,
      engine: scriptedEngine((source) => {
        if (source.includes('TIMEOUT_MARKER')) throw new GrammarRunError('parse_timeout', 'scripted parse timeout');
      }),
      onNotice: (n) => notices.push(n),
    });
    await world.indexer.build(world.dir);
    notices.length = 0;

    world.repo.write('a.toy', 'fn main {\n}\n# TIMEOUT_MARKER\n');
    world.repo.write('b.toy', 'fn helper {\n}\nfn after_failure {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy', 'b.toy']);

    assert.deepEqual(result, { complete: false, stalePaths: ['a.toy'], invalid: [] });
    assert.deepEqual((await world.reader.fileFacts('a.toy')).data?.symbols.map((s) => s.name), ['main', 'boot'], 'earlier facts kept');
    assert.equal((await world.reader.find('after_failure')).data.length, 1, 'the next path in the same batch went through');
    assert.deepEqual(world.indexer.status().failed, [{ worktree: world.dir, path: 'a.toy', code: 'parse_timeout' }]);
    assert.deepEqual(
      notices.filter((n) => n.kind === 'failed'),
      [{ kind: 'failed', worktree: world.dir, path: 'a.toy', code: 'parse_timeout' }],
    );

    world.repo.write('a.toy', 'fn main {\n}\nfn recovered {\n}\n');
    const again = await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.equal(again.complete, true);
    assert.deepEqual(world.indexer.status().failed, [], 'a later success clears the failure');
  });

  it('parse failure: a file over the byte cap keeps its earlier facts and is counted as source_too_large', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES, config: { maxFileBytes: 100 } });
    await world.indexer.build(world.dir);
    world.repo.write('c.toy', `type Widget {\n}\n# ${'x'.repeat(200)}\n`);
    const result = await world.indexer.ensureFresh(world.dir, ['c.toy']);
    assert.deepEqual(result, { complete: false, stalePaths: ['c.toy'], invalid: [] });
    assert.deepEqual(world.indexer.status().failed, [{ worktree: world.dir, path: 'c.toy', code: 'source_too_large' }]);
    assert.equal((await world.reader.find('Widget')).data.length, 1);
  });

  it('binary: a path that becomes binary leaves the overlay, and so does a path whose extension is no longer claimed', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);

    world.repo.write('b.toy', Buffer.from('fn helper {\n}\n\0binary tail'));
    const binary = await world.indexer.ensureFresh(world.dir, ['b.toy']);
    assert.equal(binary.complete, true);
    assert.equal((await world.reader.find('helper')).data.length, 0);
    assert.equal((await world.reader.fileFacts('b.toy')).data, null);

    await world.indexer.stop();
    const unclaiming = world.another({ builtinDir: null });
    const result = await unclaiming.ensureFresh(world.dir, ['c.toy']);
    assert.equal(result.complete, true);
    assert.equal((await world.reader.find('Widget')).data.length, 0, 'no loaded module claims .toy any more');
    assert.equal((await world.reader.fileFacts('a.toy')).data !== null, true, 'paths nobody asked about are untouched');
  });

  it('status reports queued and running paths, failed paths and the time of the last commit', async (t) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const world = await makeWorld(t, {
      files: THREE_FILES,
      engine: scriptedEngine(async (source) => {
        if (gated && source.includes('GATED')) await gate;
      }),
    });
    assert.deepEqual(world.indexer.status(), {
      queued: 0,
      running: 0,
      failed: [],
      lastIndexedAt: null,
      watchProblems: [],
      watchMode: 'reconcile-only',
      reconciling: false,
      lastReconcile: null,
    });
    await world.indexer.build(world.dir);
    assert.equal(world.indexer.status().lastIndexedAt, 1000, 'the injected clock, not the wall clock');

    gated = true;
    world.repo.write('b.toy', 'fn helper {\n}\n# GATED\n');
    await world.clock.advance(25);
    const pending = world.indexer.ensureFresh(world.dir, ['b.toy']);
    await eventually(async () => world.indexer.status().running === 1, 'the parse to start');
    assert.equal(world.indexer.status().queued, 0);
    release();
    assert.equal((await pending).complete, true);
    assert.deepEqual(world.indexer.status(), {
      queued: 0,
      running: 0,
      failed: [],
      lastIndexedAt: 1025,
      watchProblems: [],
      watchMode: 'reconcile-only',
      reconciling: false,
      lastReconcile: null,
    });

    const manual = createManualEventSource();
    await world.indexer.attach(manual.source, [world.dir]);
    manual.emit(world.dir, 'a.toy');
    assert.equal(world.indexer.status().queued, 1, 'an event waiting for its debounce window is queued');
  });
});

describe('Indexer.refresh: a forced re-extract of stale files (STO-10)', () => {
  it('re-extracts the files a grammar upgrade marked stale and clears them from the watermark', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);
    await world.indexer.stop();
    const writer = world.store.writer();
    assert.equal(await writer.markStale({ module: 'toy', grammarVersion: 'upgraded' }), 3);
    writer.release();
    assert.deepEqual((await world.reader.find('helper')).watermark.stalePaths, ['a.toy', 'b.toy', 'c.toy']);

    const next = world.another();
    assert.deepEqual(await next.refresh(world.dir), { processed: 3 });
    const after = await world.reader.find('helper');
    assert.deepEqual(after.watermark.stalePaths, []);
    assert.equal(after.degraded?.includes('stale') ?? false, false);
    assert.equal(after.data.length, 1);
  });

  it('a stale file that left the disk leaves the overlay, and refresh with nothing stale processes nothing', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await world.indexer.build(world.dir);
    assert.deepEqual(await world.indexer.refresh(world.dir), { processed: 0 });

    await world.indexer.stop();
    const writer = world.store.writer();
    await writer.markStale({ module: 'toy', grammarVersion: 'upgraded' });
    writer.release();
    world.repo.remove('c.toy');
    const next = world.another();
    assert.deepEqual(await next.refresh(world.dir), { processed: 3 });
    assert.deepEqual((await world.reader.find('helper')).watermark.stalePaths, []);
    assert.equal((await world.reader.fileFacts('c.toy')).data, null);
  });

  it('refuses a directory that is not a worktree of the repository', async (t) => {
    const world = await makeWorld(t, { files: THREE_FILES });
    await assert.rejects(
      world.indexer.refresh(path.join(world.dir, 'nowhere')),
      (error: unknown) => error instanceof IndexerError && error.code === 'unknown_worktree',
    );
  });
});

describe('stop while a watch subscription is still opening (found by plan 02-23: a quick EOF left the process alive)', () => {
  /** A source whose `subscribe` or `subscribeGit` (the one named) resolves only after `open()`, and says when it was entered. */
  function gatedSource(which: 'file' | 'git') {
    const manual = createManualEventSource();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const source: EventSource = {
      ...manual.source,
      async subscribe(root, handler) {
        if (which === 'file') {
          entered();
          await gate;
        }
        return manual.source.subscribe(root, handler);
      },
      async subscribeGit(commonDir, handler) {
        if (which === 'git') {
          entered();
          await gate;
        }
        return manual.source.subscribeGit(commonDir, handler);
      },
    };
    return { manual, source, open: () => open(), entered: enteredGate };
  }

  for (const which of ['git', 'file'] as const) {
    it(`a ${which} watch that finishes opening after stop() is unsubscribed, so no native watcher outlives the Indexer`, async (t) => {
      const world = await makeWorld(t, { files: THREE_FILES });
      const gated = gatedSource(which);
      await world.indexer.attach(gated.source, []);
      const starting = world.indexer.start().catch(() => undefined);
      await gated.entered;
      const stopping = world.indexer.stop();
      gated.open();
      await starting;
      await stopping;
      // Opening finished after stop() had looked for something to close: the late subscription must close itself.
      assert.equal(gated.manual.subscriptions(), 0, 'no file watch is left open');
      assert.deepEqual(gated.manual.gitSubscriptions(), [], 'no git watch is left open');
    });
  }
});
