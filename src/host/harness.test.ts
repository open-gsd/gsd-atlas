/**
 * Test helper for the Host and Tenant tests (no test inside it): real temporary git repositories, the real runner,
 * the real in-process Grammar Engine, the real Governor and the system clock, with a manual event source so no
 * test depends on a native watcher. Each world is cleaned up when its test ends.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import type { CommandRunner } from '../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import type { Governor } from '../governor/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { createManualEventSource } from '../indexer/index.ts';
import type { ManualEventSource } from '../indexer/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../test-kit/index.ts';
import { createHost } from './index.ts';
import type { Host, HostOptions } from './index.ts';

/** The toy language module lives here; a `builtinDir` pointing at it makes `.toy` a claimed extension. */
export const toyModules = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
export const setupRunner = createRealRunner({ decide: allowAll });

export const THREE_FILES: Readonly<Record<string, string>> = {
  'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'c.toy': 'type Widget {\n}\n',
  'README.md': '# toy repository\n',
};

export interface WorldOptions {
  /** Files committed to the repository. Default: {@link THREE_FILES}. */
  readonly files?: Readonly<Record<string, string>>;
  /** Overrides of the Host options. */
  readonly host?: Partial<HostOptions>;
  /** Governor for the Host. Default: the Host's own. */
  readonly governor?: Governor;
  /** Share the manual event source of another world, so a test can count both Hosts' watchers together. */
  readonly manual?: ManualEventSource;
  /** Share another world's engine (and leave its disposal to that world). */
  readonly engine?: GrammarEngine;
  /** Share another world's temporary directory. */
  readonly tmp?: TempDir;
}

export interface World {
  readonly host: Host;
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  readonly manual: ManualEventSource;
  readonly engine: GrammarEngine;
  readonly runner: CommandRunner;
  readonly options: HostOptions;
  /** Send one request through the Host. */
  ask(kind: string, args?: unknown, extra?: { readonly fresh?: readonly string[]; readonly budget_tokens?: number }): Promise<Envelope>;
  /** A second Host over the same options (another process, for the follower tests). The caller closes it. */
  anotherHost(overrides?: Partial<HostOptions>): Host;
  /** Add a linked worktree on a new branch (`git worktree add -b`) and return its canonical root. */
  addWorktree(branch: string): Promise<string>;
}

/** The store id git gives the repository at `repoDir`, as Source Tree computes it. */
export async function storeIdOf(repo: TempGitRepo): Promise<string> {
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
  return (await tree.identity()).storeId;
}

/** Write `files` (repo-relative path to text) into the working tree at `root`. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

/** A real repository, a Host over it and the doubles the tests need. */
export async function makeWorld(t: TestContext, options: WorldOptions = {}): Promise<World> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: options.files ?? THREE_FILES } });
  const tmp = options.tmp ?? makeTempDir();
  const manual = options.manual ?? createManualEventSource();
  const ownEngine = options.engine === undefined;
  const engine = options.engine ?? createGrammarEngine();
  const runner = createRealRunner();
  const hostOptions: HostOptions = {
    roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: toyModules, npmRoots: [] },
    engine,
    runner,
    cwd: repo.dir,
    userDir: path.join(tmp.path, 'user'),
    cacheRoot: path.join(tmp.path, 'cache'),
    gitEnv: repo.envOverlay,
    eventSource: () => manual.source,
    ...(options.governor === undefined ? {} : { governor: options.governor }),
    ...options.host,
  };
  const hosts: Host[] = [];
  const open = (overrides: Partial<HostOptions> = {}): Host => {
    const host = createHost({ ...hostOptions, ...overrides });
    hosts.push(host);
    return host;
  };
  const host = open();
  t.after(async () => {
    for (const each of hosts) await each.close();
    if (ownEngine) await engine.dispose();
    if (options.tmp === undefined) tmp.cleanup();
    repo.cleanup();
  });
  return {
    host,
    repo,
    tmp,
    manual,
    engine,
    runner,
    options: hostOptions,
    ask: (kind, args, extra = {}) =>
      host.handle({
        protocol: PROTOCOL_VERSION,
        kind,
        ...(args === undefined ? {} : { args }),
        ...(extra.fresh === undefined ? {} : { fresh: extra.fresh }),
        ...(extra.budget_tokens === undefined ? {} : { budget_tokens: extra.budget_tokens }),
      }),
    anotherHost: open,
    addWorktree: async (branch) => {
      const where = path.join(tmp.path, `wt-${branch}`);
      await repo.git(['worktree', 'add', '-b', branch, where]);
      return realPath(where);
    },
  };
}
