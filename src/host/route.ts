/**
 * Request routing: which kinds the Host serves, how their arguments are read, and how `repo` and `cwd` become a
 * repository and a worktree. Arguments come from an agent, so nothing here echoes them back: a refused value is
 * reported by a fixed sentence or a capped, control-free quote of the first problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isInside } from '../facts/index.ts';
import type { JobClass } from '../governor/index.ts';
import type { SourceTree, SourceTreeIdentity } from '../source-tree/index.ts';
import { MAINTAIN_TASKS } from '../tenant/index.ts';
import type { MaintainTask } from '../tenant/index.ts';

/** The request kinds that name a repository. */
export const REPO_KINDS = [
  'code_find',
  'code_refs',
  'code_context',
  'code_impact',
  'atlas_status',
  'build',
  'maintain',
  'status',
] as const;

export type RepoKind = (typeof REPO_KINDS)[number];

export const isRepoKind = (kind: string): kind is RepoKind => (REPO_KINDS as readonly string[]).includes(kind);

/**
 * The Governor class each kind runs in (HST-03): reads in `interactive`, a build in `indexing`, maintenance in
 * `maintenance`.
 */
export function classFor(kind: RepoKind): JobClass {
  if (kind === 'build') return 'indexing';
  if (kind === 'maintain') return 'maintenance';
  return 'interactive';
}

/** True for the kinds whose work is scheduled in pieces by the Indexer itself, so the Host only asks for admission. */
export const isAdmissionOnly = (kind: RepoKind): boolean => kind === 'build' || kind === 'maintain';

const MESSAGE_MAX_CHARS = 200;

/** Control characters, C1 controls and the Unicode line and paragraph separators. */
const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** A caller-supplied fragment made safe to quote: no control characters, capped. */
export function short(text: string): string {
  let clean = '';
  for (const char of text) clean += isControl(char.codePointAt(0) as number) ? ' ' : char;
  return clean.length <= MESSAGE_MAX_CHARS ? clean : `${clean.slice(0, MESSAGE_MAX_CHARS - 1)}...`;
}

/** The first problem of a refused argument object, in one short sentence. */
export function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.map(String).join('.');
  return short(`${where}: ${issue?.message ?? 'invalid'}`);
}

const text = z.string().min(1);
const selection = { repo: text.optional(), cwd: text.optional() };

const buildSchema = z.strictObject({ ...selection });
const maintainSchema = z.strictObject({
  ...selection,
  task: z.enum(MAINTAIN_TASKS).optional(),
  full: z.boolean().optional(),
});
const statusSchema = z.strictObject({ ...selection, since: z.string().optional() });
/** The code tools check the rest of their arguments themselves (Query's strict schemas); the Host reads only these two. */
const selectionOnly = z.looseObject({ ...selection });

/** 7 days: the default window of the `status` panels. */
const DEFAULT_SINCE = '7d';
const SINCE = /^([1-9][0-9]{0,3})([mhd])$/;
const SINCE_UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration such as `30m`, `12h` or `7d` in milliseconds, or null. */
export function parseSince(value: string): number | null {
  const match = SINCE.exec(value);
  if (match === null) return null;
  return Number(match[1]) * (SINCE_UNIT_MS[match[2] as string] as number);
}

export interface Selection {
  readonly repo?: string | undefined;
  readonly cwd?: string | undefined;
}

/** What a repo-scoped request asks for, after its arguments were checked. */
export type RepoArgs =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly selection: Selection;
      readonly task: MaintainTask;
      readonly full: boolean;
      readonly sinceMs: number;
    };

/** Read the arguments of a repo-scoped kind. `undefined` and `null` mean no arguments; anything but an object is refused. */
export function parseRepoArgs(kind: RepoKind, args: unknown): RepoArgs {
  const given = args === undefined || args === null ? {} : args;
  if (typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, message: 'args must be an object' };
  }
  const schema =
    kind === 'build' ? buildSchema : kind === 'maintain' ? maintainSchema : kind === 'status' ? statusSchema : selectionOnly;
  const parsed = schema.safeParse(given);
  if (!parsed.success) return { ok: false, message: firstProblem(parsed.error) };
  const data = parsed.data as { repo?: string; cwd?: string; task?: MaintainTask; full?: boolean; since?: string };
  const sinceMs = parseSince(data.since ?? DEFAULT_SINCE);
  if (sinceMs === null) return { ok: false, message: 'since: use a count and a unit, such as 30m, 12h or 7d' };
  return {
    ok: true,
    selection: { repo: data.repo, cwd: data.cwd },
    task: data.task ?? 'all',
    full: data.full === true,
    sinceMs,
  };
}

/** The repository and worktree a request resolved to. */
export interface Resolved {
  /** A Source Tree whose `repoDir` is the repository's main worktree. */
  readonly tree: SourceTree;
  readonly identity: SourceTreeIdentity;
  /** The main worktree: the directory the tenant works from. */
  readonly repoDir: string;
  /** The listed worktree that contains the requested directory (the longest match). */
  readonly worktree: string;
}

/**
 * Turn `repo` (else `cwd`, else the Host's working directory) into a repository and a worktree: an existing
 * directory, resolved with realpath, inside a git repository whose `git worktree list` has an entry that contains
 * it. A relative path is taken from `hostCwd`, never from this process's working directory. Null means not a repo.
 */
export async function resolveRepository(
  chosen: Selection,
  hostCwd: string,
  makeTree: (repoDir: string) => SourceTree,
): Promise<Resolved | null> {
  const wanted = chosen.repo ?? chosen.cwd ?? hostCwd;
  let dir: string;
  try {
    dir = fs.realpathSync.native(path.resolve(hostCwd, wanted));
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const probe = makeTree(dir);
    // Both git runs finish before the answer goes out. `Promise.all` would answer as soon as the first one failed and
    // leave the other running in `dir`, which on Windows keeps that directory from being removed (found by plan 02-26).
    const [identityRun, worktreesRun] = await Promise.allSettled([probe.identity(), probe.worktrees()]);
    if (identityRun.status === 'rejected' || worktreesRun.status === 'rejected') return null;
    const identity = identityRun.value;
    const worktrees = worktreesRun.value;
    const usable = worktrees.filter((entry) => !entry.bare);
    const containing = usable
      .filter((entry) => isInside(entry.path, dir))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const main = usable[0];
    if (containing === undefined || main === undefined) return null;
    return { tree: makeTree(main.path), identity, repoDir: main.path, worktree: containing.path };
  } catch {
    return null;
  }
}
