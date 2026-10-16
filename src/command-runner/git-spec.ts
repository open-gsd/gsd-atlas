/**
 * The one way to build a git command (FND-06, command-runner ADR decision 4, research Pitfall 3).
 *
 * Git runs repo-controlled code. A repository can name, in its own `.git/config`, a command for
 * `filter.<name>.clean|smudge|process` (applied through `.gitattributes`), for `core.fsmonitor` and for
 * a `core.hooksPath` hook folder. This was verified, not assumed: on git 2.54.0 a `filter.<name>.clean`
 * ran during `hash-object --stdin-paths`, and `core.fsmonitor` ran during `ls-files -o`.
 *
 * So every spec built here switches all of that off, command-line and environment config taking precedence
 * over every config file:
 *   - `-c core.fsmonitor=false`, `-c core.hooksPath=<null device>`, `-c core.quotepath=off` (paths come back verbatim);
 *   - for EVERY configured filter driver, `clean`, `smudge` and `process` emptied and `required=false`,
 *     carried on the `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` environment channel.
 *
 * Why the environment and not `-c`: git splits a `-c` argument at the first `=`, so a driver whose name
 * contains `=` (`filter.a=b.clean`) can never be written as a `-c` key, and it would then run its clean
 * command (verification gap CR-02, threat T-01-46). The environment channel (git 2.31 and newer) carries the
 * key and the value in separate variables and so can express any name, including `=`, `.` and the empty name.
 * Because a git that ignores the channel would silently skip neutralisation, `listFilterNames` proves the
 * channel is live before any hash call.
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
 *
 * Lazy fetch (verification gap CR-01, threat T-01-43): when an object is missing locally and the repository
 * declares a promisor remote (`extensions.partialClone`, `remote.<name>.promisor`), git fetches it by
 * starting the transport the repository configures (`core.sshCommand`, proxy commands, credential
 * helpers), which is repo-controlled code. `hasObject` and `read` ask for objects that may be absent, so
 * both would start it. The environment therefore also pins `GIT_NO_LAZY_FETCH=1` (git 2.44 and newer: no
 * fetch is attempted) and `GIT_ALLOW_PROTOCOL=none` (every transport is refused, which covers older git),
 * so each pin covers the other's gap. Both are set AFTER the caller env, so a test-kit overlay or a Source
 * Tree `envOverlay` cannot switch them off, and `decide` refuses any git spec that lacks them.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import type { CommandRunner, CommandSpec, RunContext } from './spec.ts';

/**
 * The null device as git and `decide` spell it. `decide` accepts `/dev/null` and `NUL`; on Windows Node's
 * `os.devNull` is the `\\.\nul` form, which git for Windows does not need, so `NUL` is used there.
 */
export const NULL_DEVICE: string = process.platform === 'win32' ? 'NUL' : os.devNull;

/** The text of one `-c` key=value override pair (the static hardening overrides only; see the header). */
const override = (kv: string): readonly string[] => ['-c', kv];

/**
 * The environment overlay that neutralises the named filter drivers: for every name, in input order, the
 * variables `clean`, `smudge` and `process` set to the empty string and `required` to `false`, written as
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs after a `GIT_CONFIG_COUNT`. Names are used as written
 * (no trimming, no escaping): git takes the key from its own variable, so `a=b`, `my.driver` and the empty
 * name are all expressible, which a `-c filter.<name>.clean=` argument is not (git splits `-c` at the first
 * `=`). There is no allowlist: every driver is neutralised, whatever it is called.
 */
export function neutraliseFilters(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  const add = (key: string, value: string): void => {
    out[`GIT_CONFIG_KEY_${String(n)}`] = key;
    out[`GIT_CONFIG_VALUE_${String(n)}`] = value;
    n += 1;
  };
  for (const name of names) {
    for (const variable of ['clean', 'smudge', 'process']) add(`filter.${name}.${variable}`, '');
    add(`filter.${name}.required`, 'false');
  }
  return { GIT_CONFIG_COUNT: String(n), ...out };
}

/**
 * Parses `git config --name-only --get-regexp '^filter\\.'` output into the unique driver names, sorted by
 * code unit. Lines are split on `\n` only. The name is everything between the `filter.` prefix and the LAST
 * dot, never cut at `=` and never trimmed, so `filter.a=b.clean` names `a=b`, `filter.my.driver.smudge`
 * names `my.driver` and `filter..clean` names the empty driver. Lines without a variable part and keys
 * outside `filter.` are ignored. (`--name-only` output has no values, so there is nothing to split on `=`.)
 */
export function parseFilterNames(configOutput: string): string[] {
  const names = new Set<string>();
  for (const line of configOutput.split('\n')) {
    if (!line.startsWith('filter.')) continue;
    const lastDot = line.lastIndexOf('.');
    if (lastDot < 'filter.'.length) continue;
    names.add(line.slice('filter.'.length, lastDot));
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
  /** Overlaid BEFORE the pinned variables, so it can add (a test's git-config isolation) but never override them. */
  readonly env?: Readonly<Record<string, string>>;
}

/** The environment every spec pins, applied after the caller env and the neutralisation overlay. */
const PINNED_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: 'none',
};
const PINNED_UPPER: ReadonlySet<string> = new Set(Object.keys(PINNED_ENV).map((k) => k.toUpperCase()));
const RESERVED_CONFIG_ENV = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_|VALUE_)/i;

/**
 * The caller env, vetted. Any `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` or
 * `GIT_CONFIG_PARAMETERS` (any case) throws: those belong to the neutralisation overlay, and a caller
 * overlay must not add to or remove from it. A case variant of a pinned key is dropped, so a Windows
 * case-insensitive duplicate cannot override a pin. `GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM` pass through.
 */
function callerEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (RESERVED_CONFIG_ENV.test(key)) throw new Error(`gitSpec: env ${key} is reserved for filter neutralisation (GIT_CONFIG_COUNT channel)`);
    if (PINNED_UPPER.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Builds a git CommandSpec. The caller chose `sub`; whether it may run is `decide`'s call, not this function's.
 * Every filter driver in `filterNames` is neutralised through the environment config channel (git 2.31 and
 * newer), because a `-c filter.<name>.clean=` pair cannot carry an `=` in the name. `git status` stays denied
 * by `decide`: it runs clean filters to compare working files with the index.
 */
export function gitSpec(sub: readonly string[], opts: GitSpecOptions): CommandSpec {
  const args = [
    '-C', opts.worktree,
    ...override('core.fsmonitor=false'),
    ...override(`core.hooksPath=${NULL_DEVICE}`),
    ...override('core.quotepath=off'),
    ...sub,
  ];
  const env: Record<string, string> = {
    ...callerEnv(opts.env),
    ...neutraliseFilters(opts.filterNames ?? []),
    ...PINNED_ENV,
  };
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

export type GitConfigErrorCode = 'git_env_config_unsupported' | 'filter_enumeration_failed';

/** Thrown by {@link listFilterNames} whenever driver neutralisation cannot be guaranteed. */
export class GitConfigError extends Error {
  readonly code: GitConfigErrorCode;
  constructor(code: GitConfigErrorCode, message: string) {
    super(message);
    this.name = 'GitConfigError';
    this.code = code;
  }
}

/**
 * Lists every configured filter driver name, and fails closed.
 *
 * Reading config executes nothing, so the names come from an un-neutralised read. The read does carry one
 * neutralisation pair, for a per-call random PROBE driver (`atlas-probe-` plus 64 random bits): git lists
 * that key only when it honours the `GIT_CONFIG_COUNT` environment channel (git 2.31 and newer). So a
 * missing probe proves the channel is dead and every later neutralisation would be silently skipped.
 * Outcomes:
 *   - `git_env_config_unsupported`: exit 0 but the probe's key is not in the output (git older than 2.31, or
 *     the environment was lost);
 *   - `filter_enumeration_failed`: any non-zero exit (exit 1 included: a conforming git always lists the
 *     probe, so "no matching keys" can no longer happen), spawn error, timeout, truncation or denial.
 * It never resolves to an empty list on failure. A repository cannot pre-define the probe's name (64 random
 * bits per call), so a hostile driver with that name is not a supported attack.
 */
export async function listFilterNames(
  runner: CommandRunner,
  worktree: string,
  ctx?: RunContext,
  env?: Readonly<Record<string, string>>,
): Promise<string[]> {
  const probe = `atlas-probe-${randomBytes(8).toString('hex')}`;
  const spec = gitSpec(['config', '--name-only', '--get-regexp', '^filter\\.'], {
    worktree,
    filterNames: [probe],
    ...(env === undefined ? {} : { env }),
  });
  const result = await runner.run(spec, ctx);
  if (!result.ok) {
    const why = result.denied?.message ?? result.spawnError?.message ?? new TextDecoder().decode(result.stderr).trim();
    const how = result.timedOut ? 'timed out' : result.truncated ? 'output exceeded its cap' : `exit ${String(result.exitCode)}`;
    throw new GitConfigError('filter_enumeration_failed', `git config could not list filter drivers: ${why || how}`);
  }
  const names = parseFilterNames(new TextDecoder().decode(result.stdout));
  if (!names.includes(probe)) {
    throw new GitConfigError(
      'git_env_config_unsupported',
      'git ignored the GIT_CONFIG_COUNT environment config channel (it needs git 2.31 or newer), so repository filter drivers could not be neutralised',
    );
  }
  return names.filter((name) => name !== probe);
}
