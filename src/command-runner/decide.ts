import { diagnostic } from '../facts/index.ts';
import type { CommandSpec, Decision, RunContext, UserPermissions } from './spec.ts';
import { COMMAND_CODES } from './spec.ts';

/**
 * The permission rule (command-runner ADR decision 3), in one reviewable place.
 *
 * A spec runs only if
 *   1. it exactly matches a first-party built-in in {@link BUILTINS}, or
 *   2. the injected user-level permission list allows that executable for `ctx.repo`.
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

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'ls-files',
  'hash-object',
  'cat-file',
  'rev-parse',
  'rev-list',
  'check-attr',
]);

/** Values of the allowed `-c` keys. Every one only turns repo-controlled execution OFF (Pitfall 3). */
const NULL_DEVICES: ReadonlySet<string> = new Set(['', '/dev/null', 'NUL']);
// A Map, not an object literal: a key such as `constructor` must not resolve to an inherited member.
const GIT_C_VALUES: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['core.fsmonitor', (v: string) => v === 'false'],
  ['core.hooksPath', (v: string) => NULL_DEVICES.has(v)],
  ['core.quotepath', (v: string) => v === 'off' || v === 'false' || v === 'on' || v === 'true'],
]);
const GIT_FILTER_KEY = /^filter\.[^=\s]+\.(clean|smudge|process|required)$/;

/** Options that execute repo-configured drivers or write to the repository. */
const GIT_DENIED_OPTIONS: ReadonlySet<string> = new Set(['--help', '--textconv', '--filters', '-w']);

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

function matchGit(spec: CommandSpec): boolean {
  if (spec.executable !== 'git') return false;
  const args = spec.args;
  if (args.length === 1 && args[0] === '--version') return true;

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') {
      const dir = args[i + 1];
      if (dir === undefined || dir === '') return false;
      i += 2;
    } else if (a === '-c') {
      if (!gitConfigOverrideAllowed(args[i + 1])) return false;
      i += 2;
    } else {
      break;
    }
  }

  const sub = args[i];
  if (sub === undefined) return false;
  const rest = args.slice(i + 1);
  if (sub === 'config') {
    return rest.length === 3 && rest[0] === '--name-only' && rest[1] === '--get-regexp' && rest[2] !== '';
  }
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return false;
  return !rest.some((r) => GIT_DENIED_OPTIONS.has(r));
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
    const prefix = entry.argsPrefix;
    if (prefix === undefined) return true;
    return prefix.length <= spec.args.length && prefix.every((p, k) => spec.args[k] === p);
  });
}

export function decide(spec: CommandSpec, ctx?: RunContext, user?: UserPermissions): Decision {
  // A declared builtinId narrows the table to that entry; an unknown or mismatched claim never matches.
  const candidates = spec.builtinId === undefined ? BUILTINS : BUILTINS.filter((b) => b.id === spec.builtinId);
  for (const builtin of candidates) {
    if (builtin.match(spec)) return { allowed: true, via: 'builtin', builtinId: builtin.id };
  }
  if (userAllows(spec, ctx?.repo, user)) return { allowed: true, via: 'user' };
  return denial(spec);
}

/** Allows everything. TEST-ONLY: never pass this to a runner that serves a real repo. */
export function allowAll(_spec: CommandSpec, _ctx: RunContext): Decision {
  return { allowed: true, via: 'user' };
}
