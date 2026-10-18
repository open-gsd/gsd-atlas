import { diagnostic } from '../facts/index.ts';
import { matchShape } from './builtins.ts';
import { isNeutralisableFilterName } from './filter-name.ts';
import { commandHash } from './hash.ts';
import type { BuiltinShape, CommandSpec, Decision, RunContext, UserPermissions } from './spec.ts';
import { COMMAND_CODES } from './spec.ts';

/**
 * The permission rule (command-runner ADR decision 3), in one reviewable place.
 *
 * A spec runs only if
 *   1. it exactly matches a first-party built-in in {@link BUILTINS}, or an exact shape in the injected `shapes` table
 *      that it claims by `builtinId` (the compiler worker, plan 03-19), or
 *   2. the injected user-level permission list allows that executable for `ctx.repo` (and, when the entry carries a
 *      `sha256`, only the one exact command that hash was computed for, D-15).
 *
 * This file reads no file and takes no input from repository data (SEC-01): it imports no `fs`, and the hash is a
 * pure function of the spec and the host-supplied repo identity.
 *
 * There is deliberately no parameter through which repo-committed config, a module manifest,
 * `precise.command` or an npm package can grant permission (A44): the only inputs are the spec
 * (whose shape the caller chose), the context (the host's repo identity) and `user`, which the
 * composition root reads from user-level config only.
 */

interface Builtin {
  readonly id: string;
  match(spec: CommandSpec): boolean;
}

/**
 * The generic read subcommands are the keys of {@link GIT_ALLOWED_OPTIONS}; `config` and `worktree` are accepted
 * by {@link matchGit} only in one exact shape each. The command-runner ADR amendment dated 2026-10-16 added two
 * read shapes to the original list: `ls-tree` (with the options in its set, like the others) and the single
 * worktree shape `worktree list --porcelain -z`. `worktree` is deliberately NOT a generic subcommand: `add`,
 * `remove`, `prune`, `lock` and `move` write to the repository, so no other worktree subcommand is reachable.
 */

/** Values of the allowed `-c` keys. Every one only turns repo-controlled execution OFF (Pitfall 3). */
const NULL_DEVICES: ReadonlySet<string> = new Set(['', '/dev/null', 'NUL']);
// A Map, not an object literal: a key such as `constructor` must not resolve to an inherited member.
const GIT_C_VALUES: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['core.fsmonitor', (v: string) => v === 'false'],
  ['core.hooksPath', (v: string) => NULL_DEVICES.has(v)],
  ['core.quotepath', (v: string) => v === 'off' || v === 'false' || v === 'on' || v === 'true'],
]);
const GIT_FILTER_KEY = /^filter\.[^=\s]+\.(clean|smudge|process|required)$/;

/**
 * The exact option tokens each generic read subcommand may carry (WR-11). The gate allows argument shapes, it
 * does not deny a list: git accepts bundled short options (`-wt`) and abbreviated long options (`--textc`), so
 * a denylist of exact tokens cannot be complete, while an allowlist of exact tokens can. Every token of a spec
 * that starts with `-` must be a member of the set of the subcommand being run; anything else (a bundled or
 * abbreviated spelling, `--help`, an option of another subcommand, `--`, an `=` form whose whole text is not
 * listed) is denied. Tokens that do not start with `-` are positional (revisions, paths, attribute names) and
 * pass: Source Tree validates them before it builds a spec.
 *
 * The sets are the union of what Source Tree (`src/source-tree/real.ts`) and `gitSpec` send, plus
 * `cat-file --batch-check` (size-capped object reads, WR-08) and `check-attr -a` (the read-only attribute
 * listing the builder tests exercise). They are written out by value: the gate does not import the builder.
 * A Map of Sets, so a subcommand named `constructor` cannot resolve to an inherited member.
 *
 * Each token is an exact member. The short forms stay denied on purpose: `ls-files -c` and `-o` are the short
 * spellings of `--cached` and `--others`, and a `-c` after the subcommand must never read like the global
 * `-c key=value` config override. No pathspec option is allowed anywhere (`--`, `--pathspec-from-file`,
 * `--pathspec-file-nul`, and the global `--literal-pathspecs` family are all outside every set): the ignore check
 * sends git no name at all, it runs one fixed `ls-files -z --cached --others --exclude-standard` and filters the
 * listing in process (plan 02-46). `git ls-files` has no `--pathspec-from-file` in any case.
 *
 * Adding an option here is a reviewed change; the command-runner ADR amendment records the sets.
 */
const GIT_ALLOWED_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['ls-files', new Set(['-z', '-s', '--others', '--exclude-standard', '--cached'])],
  ['ls-tree', new Set(['-r', '-z', '--full-tree', '--name-only'])],
  ['hash-object', new Set(['--stdin-paths'])],
  ['cat-file', new Set(['-e', '--batch', '--batch-check'])],
  ['rev-parse', new Set(['--verify', '--quiet', '--git-common-dir'])],
  ['rev-list', new Set(['--max-parents=0'])],
  ['check-attr', new Set(['-z', '--stdin', '-a'])],
]);

function gitConfigOverrideAllowed(kv: string | undefined): boolean {
  if (kv === undefined) return false;
  const eq = kv.indexOf('=');
  if (eq <= 0) return false;
  const key = kv.slice(0, eq);
  const value = kv.slice(eq + 1);
  const exact = GIT_C_VALUES.get(key);
  if (exact !== undefined) return exact(value);
  const filter = GIT_FILTER_KEY.exec(key);
  if (filter !== null) return filter[1] === 'required' ? value === '' || value === 'false' : value === '';
  return false;
}

/**
 * The three `-c` keys every git spec except `--version` must carry (a pair per key, value checked by
 * {@link GIT_C_VALUES}). They mirror what `gitSpec` prepends BY VALUE, not by import, and a test verifies
 * that `decide` accepts every `gitSpec` output, so a drift between builder and gate is visible. The gate
 * must not trust the builder (WR-01, T-01-44).
 */
const GIT_REQUIRED_C_KEYS: readonly string[] = ['core.fsmonitor', 'core.hooksPath', 'core.quotepath'];

/**
 * The environment every git spec except `--version` must carry, exactly. It mirrors `gitSpec` by value
 * (verified by test): no read blocks on the index lock or a credential prompt, and a missing object never
 * triggers a lazy fetch that would start a transport the repository configures (CR-01, T-01-43).
 */
const GIT_REQUIRED_ENV: ReadonlyMap<string, string> = new Map([
  ['GIT_OPTIONAL_LOCKS', '0'],
  ['GIT_TERMINAL_PROMPT', '0'],
  ['GIT_NO_LAZY_FETCH', '1'],
  ['GIT_ALLOW_PROTOCOL', 'none'],
]);

function gitEnvPinned(env: CommandSpec['env']): boolean {
  if (env === undefined) return false;
  for (const [name, value] of GIT_REQUIRED_ENV) {
    if (!Object.hasOwn(env, name) || env[name] !== value) return false;
  }
  return true;
}

/** Every spelling of the environment config channel, in any case (`GIT_CONFIG_GLOBAL` and friends are not part of it). */
const CHANNEL_NAME = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_|VALUE_)/i;
const CHANNEL_INDEXED = /^GIT_CONFIG_(KEY|VALUE)_(0|[1-9][0-9]*)$/;
const CANONICAL_COUNT = /^(0|[1-9][0-9]*)$/;
const FILTER_ENV_VARIABLES: ReadonlySet<string> = new Set(['clean', 'smudge', 'process', 'required']);

/**
 * The variable (`clean`, `smudge`, `process` or `required`) of a channel key `filter.<name>.<variable>`, or
 * `null` when the key is not of that shape or its name is one the shared rule refuses. The name is everything
 * between the `filter.` prefix and the LAST dot, so it may be empty and may hold dots and `=`.
 */
function filterEnvKeyVariable(key: string): string | null {
  if (!key.startsWith('filter.')) return null;
  const lastDot = key.lastIndexOf('.');
  if (lastDot < 'filter.'.length) return null; // `filter.clean` has no name segment at all
  const variable = key.slice(lastDot + 1);
  if (!FILTER_ENV_VARIABLES.has(variable)) return null;
  return isNeutralisableFilterName(key.slice('filter.'.length, lastDot)) ? variable : null;
}

/**
 * Validates the environment config channel (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`),
 * which `gitSpec` uses to neutralise filter drivers whose names a `-c` pair cannot express (CR-02, T-01-48).
 * Git applies these variables as config, so an unvalidated entry (`core.sshCommand`, `alias.x`) would be
 * repo-independent code execution. The grammar:
 *   - no channel variable at all, or `GIT_CONFIG_COUNT` a canonical non-negative decimal (no sign, no
 *     leading zero, no whitespace);
 *   - the `KEY_n` index set and the `VALUE_n` index set are each exactly 0 to count-1. The sets are built by
 *     scanning the env and compared with the count BEFORE any loop runs to the count, so a huge declared
 *     count cannot stall the gate;
 *   - every key is `filter.<name>.<clean|smudge|process|required>`; the name is any name the shared rule
 *     in `filter-name.ts` accepts: it may be empty and may contain `=`, `.`, whitespace and non-ASCII
 *     letters; it may not contain NUL, LF or CR, U+FFFD or an unpaired surrogate, nor exceed 1024 UTF-16
 *     code units. `decide` imports that leaf rule but never the builder (`git-spec.ts`), so the gate still
 *     does not trust `gitSpec`; a test proves the two agree (WR-01);
 *   - every value is empty (`required` also allows `false`);
 *   - `GIT_CONFIG_PARAMETERS` and every other spelling (case variants, non-canonical indexes) are denied.
 * The three isolation variables `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` do not
 * match and are not touched.
 */
function gitConfigChannelAllowed(env: CommandSpec['env']): boolean {
  if (env === undefined) return true;
  let count: string | undefined;
  const keys = new Set<number>();
  const values = new Set<number>();
  for (const name of Object.keys(env)) {
    if (!CHANNEL_NAME.test(name)) continue;
    if (name === 'GIT_CONFIG_COUNT') {
      count = env[name];
      continue;
    }
    const m = CHANNEL_INDEXED.exec(name);
    if (m === null) return false; // PARAMETERS, case variants, non-canonical indexes
    (m[1] === 'KEY' ? keys : values).add(Number(m[2]));
  }
  if (count === undefined) return keys.size === 0 && values.size === 0;
  if (!CANONICAL_COUNT.test(count)) return false;
  if (keys.size !== values.size || String(keys.size) !== count) return false;
  for (let i = 0; i < keys.size; i += 1) {
    if (!keys.has(i) || !values.has(i)) return false;
    const key = env[`GIT_CONFIG_KEY_${String(i)}`];
    const value = env[`GIT_CONFIG_VALUE_${String(i)}`];
    if (key === undefined || value === undefined) return false;
    const variable = filterEnvKeyVariable(key);
    if (variable === null) return false;
    if (variable === 'required' ? value !== '' && value !== 'false' : value !== '') return false;
  }
  return true;
}

function matchGit(spec: CommandSpec): boolean {
  if (spec.executable !== 'git') return false;
  const args = spec.args;
  if (args.length === 1 && args[0] === '--version') return true;
  if (!gitEnvPinned(spec.env)) return false;
  if (!gitConfigChannelAllowed(spec.env)) return false;

  let i = 0;
  const seenKeys = new Set<string>();
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') {
      const dir = args[i + 1];
      if (dir === undefined || dir === '') return false;
      i += 2;
    } else if (a === '-c') {
      const kv = args[i + 1];
      if (!gitConfigOverrideAllowed(kv)) return false;
      seenKeys.add((kv as string).slice(0, (kv as string).indexOf('=')));
      i += 2;
    } else {
      break;
    }
  }
  if (!GIT_REQUIRED_C_KEYS.every((key) => seenKeys.has(key))) return false;

  const sub = args[i];
  if (sub === undefined) return false;
  const rest = args.slice(i + 1);
  if (sub === 'config') {
    return rest.length === 3 && rest[0] === '--name-only' && rest[1] === '--get-regexp' && rest[2] !== '';
  }
  if (sub === 'worktree') {
    // The one worktree read shape (amendment 2026-10-16): exactly `list --porcelain -z`, in this order.
    return rest.length === 3 && rest[0] === 'list' && rest[1] === '--porcelain' && rest[2] === '-z';
  }
  const allowedOptions = GIT_ALLOWED_OPTIONS.get(sub);
  if (allowedOptions === undefined) return false; // a subcommand with no entry is denied
  return rest.every((token) => !token.startsWith('-') || allowedOptions.has(token));
}

/** The first-party built-in table. Adding an entry is a reviewed change (ADR consequences). */
const BUILTINS: readonly Builtin[] = [{ id: 'git', match: matchGit }];

const clip = (s: string): string => (s.length > 80 ? s.slice(0, 77) + '...' : s);

function denial(spec: CommandSpec): Decision {
  const shown = [spec.executable, ...spec.args.slice(0, 2)].map(clip).join(' ');
  return {
    allowed: false,
    diagnostic: diagnostic(
      COMMAND_CODES.denied,
      'error',
      `${shown} was not started: it is not a first-party built-in; to allow it for this repo add it under permissions.commands in ~/.config/gsd-atlas/config.json`,
      spec.executable,
    ),
  };
}

function userAllows(spec: CommandSpec, repo: string | undefined, user: UserPermissions | undefined): boolean {
  if (user === undefined || repo === undefined) return false;
  return user.allow.some((entry) => {
    if (entry.repo !== repo || entry.executable !== spec.executable) return false;
    // D-15: an entry with a hash binds to one exact command. The hash is recomputed here from the spec and the
    // host-supplied repo identity, so a changed argument, executable or directory no longer matches. Narrowing only.
    if (entry.sha256 !== undefined && commandHash(spec, repo) !== entry.sha256) return false;
    const prefix = entry.argsPrefix;
    if (prefix === undefined) return true;
    return prefix.length <= spec.args.length && prefix.every((p, k) => spec.args[k] === p);
  });
}

const NO_SHAPES: readonly BuiltinShape[] = [];

/**
 * `shapes` is the table of exact non-git built-in shapes (plan 03-19), built by the composition root and passed in;
 * it is consulted only after the git built-in and only for a spec that claims a shape's id. Absent means none, which
 * is the behavior before the table existed. The id `git` is reserved: a shape claiming it is ignored.
 */
export function decide(spec: CommandSpec, ctx?: RunContext, user?: UserPermissions, shapes: readonly BuiltinShape[] = NO_SHAPES): Decision {
  // A declared builtinId narrows the table to that entry; an unknown or mismatched claim never matches.
  const candidates = spec.builtinId === undefined ? BUILTINS : BUILTINS.filter((b) => b.id === spec.builtinId);
  for (const builtin of candidates) {
    if (builtin.match(spec)) return { allowed: true, via: 'builtin', builtinId: builtin.id };
  }
  if (spec.builtinId !== undefined) {
    for (const shape of shapes) {
      if (shape.id === spec.builtinId && !BUILTINS.some((b) => b.id === shape.id) && matchShape(shape, spec)) {
        return { allowed: true, via: 'builtin', builtinId: shape.id };
      }
    }
  }
  if (userAllows(spec, ctx?.repo, user)) return { allowed: true, via: 'user' };
  return denial(spec);
}

/** Allows everything. TEST-ONLY: never pass this to a runner that serves a real repo. */
export function allowAll(_spec: CommandSpec, _ctx: RunContext): Decision {
  return { allowed: true, via: 'user' };
}
