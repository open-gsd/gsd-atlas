/**
 * The one way to build a git command (FND-06, command-runner ADR decision 4, research Pitfall 3).
 *
 * Git runs repo-controlled code. A repository can name, in its own `.git/config`, a command for
 * `filter.<name>.clean|smudge|process` (applied through `.gitattributes`), for `core.fsmonitor` and for
 * a `core.hooksPath` hook folder. This was verified, not assumed: on git 2.54.0 a `filter.<name>.clean`
 * ran during `hash-object --stdin-paths`, and `core.fsmonitor` ran during `ls-files -o`.
 *
 * So every spec built here prepends overrides that switch all of that off, command-line `-c` values
 * taking precedence over every config file:
 *   - `core.fsmonitor=false`, `core.hooksPath=<null device>`, `core.quotepath=off` (paths come back verbatim);
 *   - for EVERY configured filter driver, `clean`, `smudge` and `process` emptied and `required=false`.
 *
 * There is NO allowlist of drivers. A repo-controlled config can name any command `lfs`, so exempting a
 * driver by name would let a hostile repository pick the exempt name. A repository that really uses Git
 * LFS gets its pointer files hashed as ordinary files here; source-set rules for them are Phase 2 (LNG-05).
 *
 * `git status` is not an allowed subcommand (see `decide.ts`): it runs clean filters to compare working
 * files with the index even with fsmonitor disabled, so a spec for it is denied.
 *
 * The environment pins `GIT_OPTIONAL_LOCKS=0` (a read must not contend for the index lock) and
 * `GIT_TERMINAL_PROMPT=0` (git must never wait for a credential prompt).
 */
import os from 'node:os';
import type { CommandRunner, CommandSpec, RunContext } from './spec.ts';

/**
 * The null device as git and `decide` spell it. `decide` accepts `/dev/null` and `NUL`; on Windows Node's
 * `os.devNull` is the `\\.\nul` form, which git for Windows does not need, so `NUL` is used there.
 */
export const NULL_DEVICE: string = process.platform === 'win32' ? 'NUL' : os.devNull;

/** The text of one `-c` key=value override pair. */
const override = (kv: string): readonly string[] => ['-c', kv];

/**
 * The `-c` pairs that neutralise the named filter drivers: `clean`, `smudge` and `process` emptied and
 * `required` false, for every name given. Dotted names (`my.driver`) are used as written.
 */
export function neutraliseFilters(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const key of ['clean', 'smudge', 'process']) out.push(...override(`filter.${name}.${key}=`));
    out.push(...override(`filter.${name}.required=false`));
  }
  return out;
}

/**
 * Parses `git config --name-only --get-regexp '^filter\.'` output (or `key=value` lines) into the unique,
 * sorted driver names. The driver name is everything between `filter.` and the last dot, so
 * `filter.my.driver.smudge` names `my.driver`. Keys that are not `filter.<name>.<variable>` are ignored.
 */
export function parseFilterNames(configOutput: string): string[] {
  const names = new Set<string>();
  for (const raw of configOutput.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('filter.')) continue;
    const eq = line.indexOf('=');
    const key = eq === -1 ? line : line.slice(0, eq);
    const lastDot = key.lastIndexOf('.');
    if (lastDot <= 'filter.'.length) continue;
    names.add(key.slice('filter.'.length, lastDot));
  }
  return [...names].sort();
}

export interface GitSpecOptions {
  /** The directory git runs in (`-C`): a worktree root, or the repo directory for object reads. */
  readonly worktree: string;
  /** Driver names to neutralise; pass them for any subcommand that may apply filters (`hash-object`). */
  readonly filterNames?: readonly string[];
  readonly stdin?: CommandSpec['stdin'];
  readonly maxStdoutBytes?: number;
  readonly timeoutMs?: number;
  /** Overlaid after the two pinned variables, e.g. a test's git-config isolation. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Builds a git CommandSpec. The caller chose `sub`; whether it may run is `decide`'s call, not this function's. */
export function gitSpec(sub: readonly string[], opts: GitSpecOptions): CommandSpec {
  const args = [
    '-C', opts.worktree,
    ...override('core.fsmonitor=false'),
    ...override(`core.hooksPath=${NULL_DEVICE}`),
    ...override('core.quotepath=off'),
    ...neutraliseFilters(opts.filterNames ?? []),
    ...sub,
  ];
  const env: Record<string, string> = { ...opts.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  return {
    executable: 'git',
    args,
    builtinId: 'git',
    env,
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    ...(opts.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: opts.maxStdoutBytes }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
}

/**
 * Lists every configured filter driver name. This runs WITHOUT neutralisation on purpose: reading config
 * executes nothing, and the names it returns are what the neutralisation needs. Exit status 1 with empty
 * output means "no such keys"; any other failure is an error, never "no drivers" (that would fail open).
 */
export async function listFilterNames(
  runner: CommandRunner,
  worktree: string,
  ctx?: RunContext,
  env?: Readonly<Record<string, string>>,
): Promise<string[]> {
  const spec = gitSpec(['config', '--name-only', '--get-regexp', '^filter\\.'], {
    worktree,
    ...(env === undefined ? {} : { env }),
  });
  const result = await runner.run(spec, ctx);
  const text = new TextDecoder().decode(result.stdout);
  if (result.exitCode === 1 && text === '') return [];
  if (!result.ok) {
    const why = result.denied?.message ?? result.spawnError?.message ?? new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git config could not list filter drivers: ${why || `exit ${String(result.exitCode)}`}`);
  }
  return parseFilterNames(text);
}
