/**
 * A real temporary git repository for tests, with git configuration isolated from the machine.
 *
 * Test-kit is a leaf (it imports only `src/facts` and node built-ins), so it cannot import the
 * CommandRunner. The setup commands (`init`, `add`, `commit`, `config`) are not in the production
 * allowlist anyway; the calling test builds a real runner with the allow-all rule and passes it in,
 * typed here by the structural {@link SetupRunner} so the real `CommandRunner` satisfies it.
 *
 * Isolation: an empty file stands in for the global and system config, HOME and XDG_CONFIG_HOME point at
 * the temp base, and `core.autocrlf` is off in the repo, so results are identical on every OS. The same
 * variables are exposed as `envOverlay` so production code under test runs with the same isolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, realPath } from './tmpdir.ts';

/** The argv-style spec the setup runner is given. Never a shell string. */
export interface SetupSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
}

export interface SetupResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** Method syntax on purpose: it keeps the real `CommandRunner` assignable to this structurally. */
export interface SetupRunner {
  run(spec: SetupSpec): Promise<SetupResult>;
}

/**
 * A repository described as data. `committed` is the content of the single commit, `working` overrides
 * it in the working tree (a string edits or adds a file, `null` deletes a tracked one), and `ignored`
 * lists repo-relative paths (a trailing `/` makes it a directory) kept out through `.git/info/exclude`.
 */
export interface GitRepoWorld {
  readonly committed: Readonly<Record<string, string>>;
  readonly working: Readonly<Record<string, string | null>>;
  readonly ignored: readonly string[];
}

export interface TempGitRepoOptions {
  readonly runner: SetupRunner;
  readonly world?: Partial<GitRepoWorld>;
  /** Shorthand for extra committed files, merged into `world.committed`. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface TempGitRepo {
  /** Canonical absolute path of the working tree. */
  readonly dir: string;
  /** Environment that isolates git from user and system config; pass to production code under test. */
  readonly envOverlay: Readonly<Record<string, string>>;
  /** Runs `git <args>` in the repo and returns stdout as text. Throws with git's stderr on failure. */
  git(args: readonly string[], input?: string | Uint8Array): Promise<string>;
  write(relPath: string, content: string | Uint8Array): void;
  remove(relPath: string): void;
  commitAll(message: string): Promise<void>;
  setConfig(key: string, value: string): Promise<void>;
  cleanup(): void;
}

const decoder = new TextDecoder();

export async function createTempGitRepo(options: TempGitRepoOptions): Promise<TempGitRepo> {
  const { runner } = options;
  const tmp = makeTempDir();
  try {
    const base = realPath(tmp.path);
    const emptyConfig = path.join(base, 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');
    const dir = path.join(base, 'repo');
    fs.mkdirSync(dir);
    const home = path.join(base, 'home');
    fs.mkdirSync(home);

    const envOverlay: Readonly<Record<string, string>> = {
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_SYSTEM: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Atlas Test',
      GIT_AUTHOR_EMAIL: 'atlas@example.invalid',
      GIT_COMMITTER_NAME: 'Atlas Test',
      GIT_COMMITTER_EMAIL: 'atlas@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    };

    const abs = (rel: string): string => {
      const full = path.resolve(dir, rel);
      if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error(`path escapes the repo: ${rel}`);
      return full;
    };

    const run = async (cwd: string, args: readonly string[], input?: string | Uint8Array): Promise<string> => {
      const result = await runner.run({
        executable: 'git',
        args,
        cwd,
        env: envOverlay,
        ...(input === undefined ? {} : { stdin: input }),
      });
      if (!result.ok) {
        throw new Error(`git ${args.join(' ')} failed (exit ${String(result.exitCode)}): ${decoder.decode(result.stderr).trim()}`);
      }
      return decoder.decode(result.stdout);
    };
    const git = (args: readonly string[], input?: string | Uint8Array): Promise<string> => run(dir, args, input);

    const write = (rel: string, content: string | Uint8Array): void => {
      const target = abs(rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    const remove = (rel: string): void => {
      fs.rmSync(abs(rel), { recursive: true, force: true });
    };

    await run(base, ['init', '--quiet', '--object-format=sha1', '--initial-branch=main', dir]);
    await git(['config', 'core.autocrlf', 'false']);
    await git(['config', 'commit.gpgsign', 'false']);

    const repo: TempGitRepo = {
      dir,
      envOverlay,
      git,
      write,
      remove,
      async commitAll(message) {
        await git(['add', '-A']);
        await git(['commit', '--quiet', '--no-verify', '-m', message]);
      },
      async setConfig(key, value) {
        await git(['config', key, value]);
      },
      cleanup: () => tmp.cleanup(),
    };

    // Realise the world: ignore patterns first (so ignored files never enter the commit), then the commit,
    // then the working-tree edits.
    const world = options.world ?? {};
    const committed = { ...world.committed, ...options.files };
    const ignored = world.ignored ?? [];
    if (ignored.length > 0) {
      const exclude = path.join(dir, '.git', 'info', 'exclude');
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, ignored.map((p) => `/${p}`).join('\n') + '\n');
    }
    const committedPaths = Object.keys(committed);
    if (committedPaths.length > 0) {
      for (const rel of committedPaths) write(rel, committed[rel] ?? '');
      await repo.commitAll('initial');
    }
    for (const [rel, content] of Object.entries(world.working ?? {})) {
      if (content === null) remove(rel);
      else write(rel, content);
    }
    return repo;
  } catch (error) {
    tmp.cleanup();
    throw error;
  }
}
