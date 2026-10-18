/**
 * `allow` (D-15, SEC-02): the one way a person approves a command that is not a first-party built-in.
 *
 * It is a two-step request so that what the human saw is exactly what is approved. The first call (a dry run) returns the
 * canonical preview of one command and the sha256 of its canonical form (`command-runner/hash.ts`). The second call
 * carries that hash as `confirm`; the Host recomputes the hash from the arguments of THIS call and writes only when
 * the two are equal, so a changed argument, executable or directory between the calls cannot ride on an earlier "yes".
 *
 * Nothing here runs a command. It records approvals; the runner (`command-runner/decide.ts`) enforces them.
 * Nothing here is reachable from MCP: there is no tool for it and a Host started for MCP refuses the request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { commandHash } from '../command-runner/index.ts';
import { isInside, okEnvelope } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { errorEnvelope } from '../query/index.ts';
import { CONFIG_FILE, readBounded } from './config.ts';
import { firstProblem } from './route.ts';
import type { Selection } from './route.ts';

/** Envelope schema of an `allow` reply. */
export const ALLOW_SCHEMA = 'gsd-atlas.allow/1';

/** The request kind, and the one Governor key its requests run under. */
export const ALLOW_KIND = 'allow';

/** What a dry run returns: the one command that would be approved, and the hash that binds the second call to it. */
export interface AllowPreview {
  /** The main worktree, as the runner knows the repository. */
  readonly repo: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** The working directory, POSIX-style and relative to `repo` (`.` for the root). */
  readonly cwd: string;
  readonly sha256: string;
}

/** What a confirmed call returns. */
export interface AllowWritten {
  readonly written: boolean;
  readonly sha256: string;
  /** True when an identical entry was already there, so nothing was written. */
  readonly already_allowed?: true;
}

/** The user-level entry the writer appends: one repository, one executable, one exact command. */
export interface AllowEntry {
  readonly repo: string;
  readonly executable: string;
  readonly sha256: string;
}

export type AddResult =
  | { readonly ok: true; readonly status: 'added' | 'already_allowed' }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type AllowResult =
  | { readonly ok: true; readonly preview: AllowPreview; readonly written: boolean; readonly alreadyAllowed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The arguments of an `allow` request, after the Host checked their shape. */
export interface AllowInput extends Selection {
  readonly argv?: readonly string[] | undefined;
  readonly workdir?: string | undefined;
}

/** What the Host supplies: it alone knows how a repository is resolved and where the user's directory is. */
export interface AllowDeps {
  /** The Host's resolver: a repository from `repo`, else `cwd`, else the Host's working directory. Null: not a repository. */
  readonly resolveRepo: (selection: Selection) => Promise<{ readonly repoDir: string } | null>;
  /** The user-level configuration folder, `<userDir>/config.json` inside it. */
  readonly userDir: string;
}

const fail = (code: string, message: string): AllowResult => ({ ok: false, code, message });

const NOT_A_REPO = 'repo must be an existing directory inside a git repository.';
const BAD_ARGV = 'argv must be a non-empty list of strings: an executable, then its arguments, none containing a NUL character.';
const BAD_WORKDIR = 'workdir must be an existing directory inside the repository, given relative to it.';
const MISMATCH = 'The confirmation does not match this command, so nothing was written. Run the preview again.';

const argsSchema = z.strictObject({
  repo: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  argv: z.array(z.string()).optional(),
  workdir: z.string().optional(),
  confirm: z.string().optional(),
});

/** The command to approve, from `argv`: the first element is the executable, the rest are its arguments. */
function splitArgv(argv: readonly string[] | undefined): { readonly executable: string; readonly args: readonly string[] } | null {
  if (argv === undefined || argv.length === 0) return null;
  const [executable, ...args] = argv as [string, ...string[]];
  if (executable === '' || argv.some((element) => element.includes('\0'))) return null;
  return { executable, args };
}

/**
 * `workdir` as a POSIX path relative to the repository (`.` when absent or empty), or null when it escapes the
 * repository, is absolute, or is not an existing directory whose real path is still inside the repository.
 */
function normaliseWorkdir(raw: string | undefined, repoDir: string): string | null {
  const given = raw === undefined || raw === '' ? '.' : raw;
  if (given.includes('\0')) return null;
  const posix = path.sep === '\\' ? given.replaceAll('\\', '/') : given;
  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) return null;
  const relative = path.posix.normalize(posix);
  if (relative === '..' || relative.startsWith('../')) return null;
  try {
    const real = fs.realpathSync.native(path.join(repoDir, relative));
    if (!fs.statSync(real).isDirectory()) return null;
    if (!isInside(fs.realpathSync.native(repoDir), real)) return null;
  } catch {
    return null;
  }
  return relative === '' ? '.' : relative;
}

/** Everything both steps compute the same way, from the arguments of the call in hand. */
async function prepare(input: AllowInput, deps: AllowDeps): Promise<AllowResult> {
  const command = splitArgv(input.argv);
  if (command === null) return fail('invalid_args', BAD_ARGV);
  const resolved = await deps.resolveRepo({ repo: input.repo, cwd: input.cwd });
  if (resolved === null) return fail('not_a_repo', NOT_A_REPO);
  const cwd = normaliseWorkdir(input.workdir, resolved.repoDir);
  if (cwd === null) return fail('invalid_workdir', BAD_WORKDIR);
  const sha256 = commandHash({ ...command, cwd }, resolved.repoDir);
  if (sha256 === null) return fail('invalid_workdir', BAD_WORKDIR);
  return { ok: true, preview: { repo: resolved.repoDir, ...command, cwd, sha256 }, written: false, alreadyAllowed: false };
}

/** Step one: the canonical preview of the command and its hash. Writes nothing. */
export function previewAllow(input: AllowInput, deps: AllowDeps): Promise<AllowResult> {
  return prepare(input, deps);
}

/**
 * Step two: recompute the preview from THIS call's arguments, require its hash to equal `confirm`, and only then
 * append the entry. The hash binds the call to the preview the person was shown.
 */
export async function applyAllow(input: AllowInput, deps: AllowDeps, confirm: string): Promise<AllowResult> {
  const prepared = await prepare(input, deps);
  if (!prepared.ok) return prepared;
  const { preview } = prepared;
  if (confirm !== preview.sha256) return fail('confirm_mismatch', MISMATCH);
  const added = addAllowEntry(deps.userDir, { repo: preview.repo, executable: preview.executable, sha256: preview.sha256 });
  if (!added.ok) return fail(added.code, added.reason);
  return { ok: true, preview, written: added.status === 'added', alreadyAllowed: added.status === 'already_allowed' };
}

/**
 * Append one entry to `<userDir>/config.json`, creating the file when it is absent. An existing file is read through the
 * same bounded reader as the loader and every other key is kept.
 */
export function addAllowEntry(userDir: string, entry: AllowEntry): AddResult {
  const file = path.join(userDir, CONFIG_FILE);
  const read = readBounded(file);
  if (read.kind === 'refused') return { ok: false, code: 'config_invalid', reason: read.why };
  let base: Record<string, unknown> = {};
  if (read.kind === 'ok') {
    try {
      const parsed: unknown = JSON.parse(read.text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      base = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'config_invalid', reason: 'it is not valid JSON' };
    }
  }
  const permissions = (base['permissions'] ?? {}) as { allow?: unknown[] };
  const existing = Array.isArray(permissions.allow) ? permissions.allow : [];
  const next = { ...base, permissions: { ...permissions, allow: [...existing, entry] } };
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, status: 'added' };
}

/** The envelope of an `allow` result: the preview for a dry run, `{written, sha256}` for a confirmed call. */
function envelopeOf(result: AllowResult, confirmed: boolean): Envelope {
  if (!result.ok) return errorEnvelope(result.code, result.message);
  if (!confirmed) return okEnvelope<AllowPreview>(ALLOW_SCHEMA, result.preview);
  const data: AllowWritten = {
    written: result.written,
    sha256: result.preview.sha256,
    ...(result.alreadyAllowed ? { already_allowed: true as const } : {}),
  };
  return okEnvelope<AllowWritten>(ALLOW_SCHEMA, data);
}

/** Answer one `allow` request: a dry run without `confirm`, the write with it. */
export async function handleAllow(request: Request, deps: AllowDeps): Promise<Envelope> {
  const given = request.args === undefined || request.args === null ? {} : request.args;
  if (typeof given !== 'object' || Array.isArray(given)) return errorEnvelope('invalid_args', 'args must be an object');
  const parsed = argsSchema.safeParse(given);
  if (!parsed.success) return errorEnvelope('invalid_args', firstProblem(parsed.error));
  const { confirm, ...input } = parsed.data;
  const result = confirm === undefined ? await previewAllow(input, deps) : await applyAllow(input, deps, confirm);
  return envelopeOf(result, confirm !== undefined);
}
