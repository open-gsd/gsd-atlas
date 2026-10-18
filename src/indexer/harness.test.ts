/**
 * Test helper for the Reconcile, worktree and watcher tests (no test inside it): a real temporary git repository,
 * a real Fact Store and Source Tree, the real in-process Grammar Engine, the real Governor and a clock. The
 * Indexer under test gets whatever event source the test names.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import type { CommandRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { FactStore, Reader, Resolver } from '../fact-store/index.ts';
import type { Clock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor, Job } from '../governor/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { FakeClock, createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { createIndexer } from './index.ts';
import type { EventSource, Indexer, IndexerConfig, IndexerNotice } from './index.ts';

/** A FakeClock that counts the timers armed through `after` that have neither fired nor been cancelled. */
export class SpyClock extends FakeClock {
  live = 0;
  private readonly byDelay = new Map<number, number>();

  /** How many of the live timers were armed with exactly this delay. */
  liveWith(ms: number): number {
    return this.byDelay.get(ms) ?? 0;
  }

  override after(ms: number, fn: () => void): () => void {
    this.live += 1;
    this.byDelay.set(ms, (this.byDelay.get(ms) ?? 0) + 1);
    let open = true;
    const settle = (): void => {
      if (open) {
        open = false;
        this.live -= 1;
        this.byDelay.set(ms, (this.byDelay.get(ms) ?? 1) - 1);
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
export interface TreeLog {
  readonly hashPaths: string[][];
  snapshots: number;
  /** The paths of each `unignoredPaths` call: the ignore verdicts the Indexer asked for. */
  readonly unignored: string[][];
  readonly readTexts: string[];
}

export const newLog = (): TreeLog => ({ hashPaths: [], snapshots: 0, unignored: [], readTexts: [] });

/** Wraps a Source Tree so a test can see which paths were hashed and read. */
export function recordingTree(log: TreeLog): (tree: SourceTree) => SourceTree {
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
    pathAttributes: (worktree, paths) => tree.pathAttributes(worktree, paths),
    unignoredPaths: (worktree, paths) => {
      log.unignored.push([...paths]);
      return tree.unignoredPaths(worktree, paths);
    },
    worktrees: () => tree.worktrees(),
    readText: (worktree, relPath, options) => {
      log.readTexts.push(relPath);
      return tree.readText(worktree, relPath, options);
    },
    listDirectory: (worktree, dir, options) => tree.listDirectory(worktree, dir, options),
    hasObject: (hash) => tree.hasObject(hash),
    read: (commit, relPath) => tree.read(commit, relPath),
    identity: () => tree.identity(),
    resolveCommit: (rev) => tree.resolveCommit(rev),
    listTree: (commit) => tree.listTree(commit),
    readMany: (commit, paths, options) => tree.readMany(commit, paths, options),
  });
}

/** Poll until `check` holds; the work behind it runs on real I/O, so there is no clock to advance. */
export async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** The toy language module lives here; a `builtinDir` pointing at it makes `.toy` a claimed extension. */
export const toyModules = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');

/** The shipped language modules (TypeScript and JavaScript). */
export const shippedModules = path.resolve(import.meta.dirname, '..', '..', 'modules');

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
export const setupRunner = createRealRunner({ decide: allowAll });

/** A store without a precise resolver: it resolves nothing. */
export const noResolver: Resolver = async function* () {
  // resolves nothing
};

/** The git blob id of `content` in a SHA-1 repository. */
export const blobId = (content: string | Uint8Array): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${String(body.length)}\0`).update(body).digest('hex');
};

/** A Governor that records every job it is asked to run and delegates to a real one. */
export function spyGovernor(
  real: Governor,
  jobs: Job[],
  hooks: { readonly onStart?: (job: Job) => void } = {},
): Governor {
  return {
    run<T>(job: Job, fn: (signal: AbortSignal) => Promise<T>) {
      jobs.push(job);
      return real.run(job, (signal) => {
        hooks.onStart?.(job);
        return fn(signal);
      });
    },
    lease: (key, estimatedBytes, onEvict) => real.lease(key, estimatedBytes, onEvict),
    status: () => real.status(),
  };
}

/** The sources the engine was asked to parse, in order; a test gives every file distinctive text to count by. */
export interface EngineLog {
  readonly sources: string[];
  /** When set, called before every parse; it may wait. */
  onRun?: (source: string) => Promise<void> | void;
}

/** The real engine with a log of every parse. */
export function countingEngine(log: EngineLog): (real: GrammarEngine) => GrammarEngine {
  return (real) => ({
    load: async (input) => {
      const grammar = await real.load(input);
      return {
        name: grammar.name,
        abi: grammar.abi,
        run: async (source) => {
          log.sources.push(source);
          await log.onRun?.(source);
          return grammar.run(source);
        },
        dispose: () => grammar.dispose(),
      };
    },
    dispose: () => real.dispose(),
  });
}

export interface WorldOptions {
  readonly files: Readonly<Record<string, string>>;
  readonly config?: Partial<IndexerConfig>;
  readonly clock?: FakeClock;
  readonly engine?: (real: GrammarEngine) => GrammarEngine;
  readonly governor?: (clock: Clock) => Governor;
  readonly wrapTree?: (tree: SourceTree) => SourceTree;
  /** Wraps the runner the Source Tree starts every process through (a test that counts spawns). */
  readonly wrapRunner?: (runner: CommandRunner) => CommandRunner;
  /** Where the language modules are looked up. Default: the toy fixture module. */
  readonly builtinDir?: string | null;
  readonly onNotice?: (notice: IndexerNotice) => void;
  /** The event source the Indexer is built with. Absent: the Indexer runs reconcile-only. */
  readonly source?: EventSource;
}

export interface World {
  readonly repo: TempGitRepo;
  readonly dir: string;
  readonly store: FactStore;
  readonly reader: Reader;
  readonly indexer: Indexer;
  readonly clock: FakeClock;
  readonly governor: Governor;
  readonly tree: SourceTree;
  readonly storeDir: string;
  /** A second Indexer over the same repository and store; the first must be stopped before it can write. */
  another(overrides?: Partial<WorldOptions>): Indexer;
  /** Add a linked worktree on a new branch (`git worktree add -b`) and return its canonical root. */
  addWorktree(branch: string): Promise<string>;
}

/** A real repository, a real store and Source Tree, the real in-process engine, the real Governor. */
export async function makeWorld(t: TestContext, options: WorldOptions): Promise<World> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: options.files } });
  const tmp = makeTempDir();
  const clock = options.clock ?? new FakeClock(1000);
  const storeDir = path.join(tmp.path, 'store');
  const store = await openFactStore(
    storeDir,
    { resolver: noResolver, clock, gitHas: () => Promise.resolve(true) },
    { repo: 'toy', version: 'test' },
  );
  const runner = options.wrapRunner === undefined ? createRealRunner() : options.wrapRunner(createRealRunner());
  const realTree = createSourceTree({ runner, repoDir: repo.dir, envOverlay: repo.envOverlay });
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
    const source = overrides.source ?? options.source;
    const indexer = createIndexer({
      tenant: 'test',
      tree,
      store,
      engine,
      roots: { ...roots, builtinDir: overrides.builtinDir === undefined ? roots.builtinDir : overrides.builtinDir },
      governor,
      clock,
      ...(source === undefined ? {} : { source }),
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
  return {
    repo,
    dir: repo.dir,
    store,
    reader: store.at(repo.dir),
    indexer,
    clock,
    governor,
    tree,
    storeDir,
    another: make,
    addWorktree: async (branch) => {
      const where = path.join(tmp.path, `wt-${branch}`);
      await repo.git(['worktree', 'add', '-b', branch, where]);
      return realPath(where);
    },
  };
}

/** Write `files` (repo-relative path to text) into the worktree at `root`. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

export const THREE_FILES = {
  'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'c.toy': 'type Widget {\n}\n',
  'README.md': '# toy repository\n',
};
