/**
 * `gsd-atlas init`: register the stdio MCP server at user scope for each detected agent host.
 *
 * Safety rules (HST-04, trust-boundaries ADR): every path comes from the injected home directory,
 * never from the working directory, so nothing is ever written into a repository; a config file that
 * does not parse is refused untouched; init edits files only and launches no program. The home
 * directory, working directory, platform, environment and launch command are all injected (the bin
 * supplies them), so tests use a temporary home. Imports node: built-ins only (adapter rule).
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Diagnostic } from '../host-client/index.ts';
import { ConfigChangedError, ConfigInUseError, detectHomeFile, readUserFile, writeUserFile } from './init-files.ts';
import type { UserFile } from './init-files.ts';
import { TARGETS } from './init-targets.ts';
import type { AgentId, McpLaunch, Target } from './init-targets.ts';

export const INIT_SCHEMA = 'gsd-atlas.init/1';

/** The Host's answer about the repository around the working directory (see `indexState` below). */
export type IndexState =
  | { readonly kind: 'indexed' }
  | { readonly kind: 'not_indexed'; readonly repo: string }
  | { readonly kind: 'unknown' };

/** Everything init needs from the outside world. `env` is carried for the bin and not read by init yet. */
export interface InitEnvironment {
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The launch command to register: the node executable and the absolute path of the gsd-atlas-mcp entry. */
  readonly mcp: McpLaunch;
  /**
   * Asks the Host whether the repository around `cwd` has an index. Supplied by the CLI from its HostClient; init
   * never launches a program, and it calls this only when it registered something, it is not a dry run and a `.git`
   * entry exists above the working directory. Absent: the file-system probe alone decides.
   */
  readonly indexState?: (cwd: string) => Promise<IndexState>;
  /** TEST ONLY: called with the config file path just before it is written (never on a dry run). */
  readonly beforeWrite?: (file: string) => void | Promise<void>;
  /** TEST ONLY: called after the temp file is written and before the final compare and the rename. */
  readonly afterTemp?: (file: string) => void | Promise<void>;
  /** TEST ONLY: replaces the final rename, so a test can script the error the operating system gives. */
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

export interface InitOptions {
  readonly dryRun: boolean;
  readonly agents: readonly AgentId[] | 'all';
}

export type InitAction = 'created' | 'updated' | 'unchanged' | 'skipped' | 'refused';

export interface InitHostResult {
  readonly agent: AgentId;
  readonly file: string;
  readonly action: InitAction;
  readonly reason?: string;
}

/** The init envelope. `data` is always present (unlike a host Envelope) because a refusal still lists every host. */
export interface InitEnvelope {
  readonly schema: typeof INIT_SCHEMA;
  readonly ok: boolean;
  readonly data: { readonly dryRun: boolean; readonly hosts: readonly InitHostResult[] };
  readonly diagnostics: readonly Diagnostic[];
}

export interface InitResult {
  readonly envelope: InitEnvelope;
  readonly exitCode: number;
  /** Human lines for stderr, without line terminators. */
  readonly stderrLines: readonly string[];
}

const EXIT_OK = 0;
const EXIT_FAILURE = 2;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The launch command must be absolute paths: a PATH lookup or a free-form string is never registered (T-02-74). */
function launchProblem(env: InitEnvironment): string | null {
  const isAbsolute = env.platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const last = env.mcp.args.at(-1);
  if (!isAbsolute(env.mcp.command)) {
    return `the MCP launch command must be an absolute path, got "${env.mcp.command}"`;
  }
  if (last !== undefined && !isAbsolute(last)) {
    return `the MCP server entry must be an absolute path, got "${last}"`;
  }
  return null;
}

interface HostOutcome {
  readonly result: InitHostResult;
  readonly stderr: readonly string[];
}

async function registerWith(target: Target, dryRun: boolean, env: InitEnvironment): Promise<HostOutcome> {
  const file = target.file(env.home);
  const done = (action: InitAction, reason?: string, stderr: readonly string[] = []): HostOutcome => ({
    result: { agent: target.agent, file, action, ...(reason === undefined ? {} : { reason }) },
    stderr,
  });
  const refuse = (reason: string): HostOutcome =>
    done('refused', reason, [`gsd-atlas: init ${target.agent}: refused ${file}: ${reason}`]);

  let existing: UserFile | null = null;
  try {
    const detection = await target.detect(env.home);
    if (detection === 'none') {
      return done('skipped', 'not_detected');
    }
    if (detection === 'unusable') {
      return refuse('the path exists but is not a regular file');
    }
    if (detection === 'file') {
      const read = await readUserFile(file);
      if (!read.ok) {
        return refuse(read.reason);
      }
      existing = read.file;
    } else if (!target.createsFile) {
      const lines = [`gsd-atlas: init ${target.agent}: ${file} was not found; the host creates it itself, so register by hand with:`];
      if (target.manualCommand !== undefined) {
        lines.push(target.manualCommand(env.mcp, env.platform));
      }
      return done('skipped', 'config_not_found', lines);
    }
  } catch (error) {
    return refuse(`could not read the file: ${reasonOf(error)}`);
  }

  const rendered = target.render(existing, env.mcp);
  if (rendered.kind === 'refused') {
    return refuse(rendered.reason);
  }
  if (!rendered.changed) {
    return done('unchanged');
  }
  if (!dryRun) {
    try {
      await env.beforeWrite?.(file);
      await writeUserFile(file, rendered.text, {
        bom: existing?.bom ?? false,
        expected: existing === null ? { absent: true } : { digest: existing.digest },
        ...(env.afterTemp === undefined ? {} : { afterTemp: env.afterTemp }),
        ...(env.renameFile === undefined ? {} : { renameFile: env.renameFile }),
      });
    } catch (error) {
      if (error instanceof ConfigChangedError) {
        return refuse('config_changed_during_init: the file changed while init was running, so nothing was written; run init again');
      }
      if (error instanceof ConfigInUseError) {
        return refuse(
          `config_in_use: the config file could not be replaced because another process holds it open, or its folder is not writable (${error.errno}); nothing was changed; close the program that uses it and run init again`,
        );
      }
      return refuse(`could not write the file: ${reasonOf(error)}`);
    }
  }
  return done(existing === null ? 'created' : 'updated');
}

/**
 * The git COMMON directory for a git directory: a linked worktree's git directory holds a `commondir`
 * file (relative to it, or absolute) naming the main one; any other git directory is its own.
 */
async function commonGitDir(gitDir: string): Promise<string> {
  const text = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);
  const line = text?.split(/\r?\n/, 1)[0]?.trim();
  return line === undefined || line === '' ? gitDir : path.resolve(gitDir, line);
}

/**
 * The working tree root and git directory of the repository `cwd` is inside, found by looking for a `.git` entry
 * upwards, without running git. Null when there is none, or the entry is a file that does not point at a git directory.
 */
async function findRepository(cwd: string): Promise<{ readonly dir: string; readonly gitDir: string } | null> {
  let dir = cwd;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let info;
    try {
      info = await lstat(dotGit);
    } catch {
      info = null;
    }
    if (info !== null) {
      let gitDir: string | null = null;
      if (info.isDirectory()) {
        gitDir = dotGit;
      } else if (info.isFile()) {
        // A linked worktree: `.git` is a file reading `gitdir: <path>`.
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''));
        gitDir = pointer?.[1] === undefined ? null : path.resolve(dir, pointer[1]);
      }
      return gitDir === null ? null : { dir, gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** What the Host said about the working directory's repository; `unknown` for an error, a rejected call or any reply init does not understand. */
async function hostIndexState(indexState: (cwd: string) => Promise<IndexState>, cwd: string): Promise<IndexState> {
  try {
    return await indexState(cwd);
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The repository root to name in the `gsd-atlas build` hint, or null when no hint is due. Nothing is asked unless a
 * `.git` entry exists above `cwd`. The Host decides when it can (it applies the same store-location rules as every
 * read request, so a store kept in the cache directory, a synced folder or `store.dir` is seen). When there is no
 * `indexState` function, or the Host cannot answer, the common git directory is probed for a `gsd-atlas` folder,
 * which cannot see those other locations; the hint is worded not to claim the repository has no index.
 */
async function repoWithoutIndex(env: InitEnvironment): Promise<string | null> {
  const found = await findRepository(env.cwd);
  if (found === null) {
    return null;
  }
  if (env.indexState !== undefined) {
    const state = await hostIndexState(env.indexState, env.cwd);
    if (state.kind === 'indexed') {
      return null;
    }
    if (state.kind === 'not_indexed') {
      return state.repo;
    }
  }
  const common = await commonGitDir(found.gitDir);
  return (await detectHomeFile(path.join(common, 'gsd-atlas'))) === 'missing' ? found.dir : null;
}

export async function runInit(options: InitOptions, env: InitEnvironment): Promise<InitResult> {
  const problem = launchProblem(env);
  if (problem !== null) {
    return {
      envelope: {
        schema: INIT_SCHEMA,
        ok: false,
        data: { dryRun: options.dryRun, hosts: [] },
        diagnostics: [{ code: 'launch_command_invalid', severity: 'error', message: problem, subject: 'mcp' }],
      },
      exitCode: EXIT_FAILURE,
      stderrLines: [`gsd-atlas: init: ${problem}`],
    };
  }

  const selected = TARGETS.filter((target) => options.agents === 'all' || options.agents.includes(target.agent));
  const hosts: InitHostResult[] = [];
  const stderrLines: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const target of selected) {
    const outcome = await registerWith(target, options.dryRun, env);
    hosts.push(outcome.result);
    stderrLines.push(...outcome.stderr);
    if (outcome.result.action === 'refused') {
      diagnostics.push({
        code: 'config_refused',
        severity: 'error',
        message: `${target.agent}: ${outcome.result.reason ?? 'refused'}`,
        subject: outcome.result.file,
      });
    }
  }

  const refused = hosts.some((host) => host.action === 'refused');
  if (hosts.length > 0 && hosts.every((host) => host.reason === 'not_detected')) {
    stderrLines.push(`gsd-atlas: init: no agent host was found under ${env.home}`);
  }
  const registered = hosts.some((host) => host.action === 'created' || host.action === 'updated' || host.action === 'unchanged');
  if (registered && !refused && !options.dryRun) {
    const repo = await repoWithoutIndex(env);
    if (repo !== null) {
      stderrLines.push(`gsd-atlas: to index ${repo}, run \`gsd-atlas build\` inside it`);
    }
  }

  const exitCode = refused ? EXIT_FAILURE : EXIT_OK;
  return {
    envelope: { schema: INIT_SCHEMA, ok: exitCode === EXIT_OK, data: { dryRun: options.dryRun, hosts }, diagnostics },
    exitCode,
    stderrLines,
  };
}
