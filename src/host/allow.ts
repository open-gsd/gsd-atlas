/**
 * `allow` (D-15, SEC-02): the one way a person approves a command that is not a first-party built-in.
 *
 * It is a two-step request so that what the human saw is exactly what is approved. The first call (a dry run) returns the
 * canonical preview of one command and the sha256 of its canonical form (`command-runner/hash.ts`). The second call
 * carries that hash as `confirm`; the Host recomputes the hash from the arguments of THIS call and writes only when
 * the two are equal, so a changed argument, executable, directory or module manifest between the calls cannot ride on an
 * earlier "yes".
 *
 * Nothing here runs a command. It records approvals; the runner (`command-runner/decide.ts`) enforces them.
 * Nothing here is reachable from MCP: there is no tool for it and a Host started for MCP refuses the request.
 *
 * Text that came from a repository (a module's `precise.command`) is proposed to the person and nowhere else: it is in the
 * dry-run reply and in the confirmed reply (so the person can see what was approved), both of which only the terminal CLI
 * receives: a Host started for MCP refuses the request before this module sees it. It is never in an error reply, a
 * diagnostic or a log, and the module is named by a boolean (`fromModule`), never by name.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { COMMAND_CODES, commandHash } from '../command-runner/index.ts';
import type { CommandResult, UserPermissions } from '../command-runner/index.ts';
import { diagnostic, isInside, okEnvelope } from '../facts/index.ts';
import type { DegradedCode, Diagnostic, Envelope, Request } from '../facts/index.ts';
import { readManifest, resolveModule } from '../lang/index.ts';
import type { Roots } from '../lang/index.ts';
import { errorEnvelope } from '../query/index.ts';
import { CONFIG_FILE, CONFIG_MAX_BYTES, USER_CONFIG_SCHEMA, fixedProblemOf, readBounded } from './config.ts';
import type { BoundedRead } from './config.ts';
import { firstProblem } from './route.ts';
import type { Selection } from './route.ts';
import type { HostOrigin } from './types.ts';

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
  /** True when the command was proposed by a language module's manifest. A flag, never the module's name or text. */
  readonly fromModule?: true;
}

/** What a confirmed call returns: the hash, and the command that was approved (the dry run's own fields). */
export interface AllowWritten {
  readonly written: boolean;
  readonly sha256: string;
  readonly executable: string;
  readonly args: readonly string[];
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
  | { readonly ok: false; readonly code: AddFailure; readonly reason: string };

/** Why an entry could not be recorded. `config_invalid` carries the reason; the others are fixed sentences. */
export type AddFailure = 'config_invalid' | 'config_too_large' | 'config_changed' | 'write_failed';

export type AllowResult =
  | { readonly ok: true; readonly preview: AllowPreview; readonly written: boolean; readonly alreadyAllowed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The arguments of an `allow` request, after the Host checked their shape. */
export interface AllowInput extends Selection {
  readonly argv?: readonly string[] | undefined;
  readonly workdir?: string | undefined;
  /** A language module whose manifest proposes the command (`gsd-atlas allow --module <name>`). */
  readonly module?: string | undefined;
}

/** What the Host supplies: it alone knows how a repository is resolved, where the user's directory is and the module roots. */
export interface AllowDeps {
  /** The Host's resolver: a repository from `repo`, else `cwd`, else the Host's working directory. Null: not a repository. */
  readonly resolveRepo: (selection: Selection) => Promise<{ readonly repoDir: string } | null>;
  /** The user-level configuration folder, `<userDir>/config.json` inside it. */
  readonly userDir: string;
  /** The Host's module roots; `repoRoot` is replaced by the repository being approved for. */
  readonly roots: Roots;
}

/** The file-system calls the writer makes, so a test can make one of them fail. */
export type AllowFs = Pick<
  typeof fs,
  'mkdirSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync' | 'realpathSync'
>;

const fail = (code: string, message: string): AllowResult => ({ ok: false, code, message });

const NOT_A_REPO = 'repo must be an existing directory inside a git repository.';
const BAD_ARGV = 'argv must be a non-empty list of strings: an executable, then its arguments, none containing a NUL character.';
const BAD_SOURCE = 'give either argv (a command) or module (a language module that proposes one), not both and not neither.';
const BAD_WORKDIR = 'workdir must be an existing directory inside the repository, given relative to it.';
const NO_MODULE = 'No language module with that name is visible from this repository.';
const NO_COMMAND = 'That language module declares no precise command to approve.';
const MISMATCH = 'The confirmation does not match this command, so nothing was written. Run the preview again.';
const TOO_LARGE = 'The user configuration file would be larger than 64 KiB, so nothing was written. Remove entries you no longer need and try again.';
const CHANGED = 'The user configuration file changed while the approval was being written, so nothing was written. Run the command again.';
const NOT_WRITTEN = 'The user configuration file could not be written and was not changed.';

/** The one sentence a refused file gets, wherever it is reported. */
const invalidConfig = (reason: string): string => `the user configuration file is invalid and was not changed: ${reason}`;

const argsSchema = z.strictObject({
  repo: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  argv: z.array(z.string()).optional(),
  workdir: z.string().optional(),
  module: z.string().optional(),
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
  // `normalize` keeps a trailing slash; `sub/dir/` and `sub/dir` are one directory and must be one hash.
  const normalised = path.posix.normalize(posix);
  const relative = normalised.length > 1 && normalised.endsWith('/') ? normalised.slice(0, -1) : normalised;
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

type Command = { readonly executable: string; readonly args: readonly string[] };

/** The argv a module's manifest declares as `precise.command`, read through the registry and the confined manifest reader. */
function moduleCommand(name: string, repoDir: string, roots: Roots): Command | { readonly code: string; readonly message: string } {
  const found = resolveModule({ ...roots, repoRoot: repoDir }, name);
  if (found.entry === undefined) return { code: 'module_not_found', message: NO_MODULE };
  const read = readManifest(found.entry.dir);
  if (!read.ok) return { code: 'module_not_found', message: NO_MODULE };
  const precise = read.manifest.precise;
  if (precise === undefined || !('command' in precise)) return { code: 'no_precise_command', message: NO_COMMAND };
  return splitArgv(precise.command) ?? { code: 'no_precise_command', message: NO_COMMAND };
}

/** Everything both steps compute the same way, from the arguments of the call in hand. */
async function prepare(input: AllowInput, deps: AllowDeps): Promise<AllowResult> {
  const hasArgv = input.argv !== undefined;
  const hasModule = input.module !== undefined;
  if (hasArgv === hasModule) return fail('invalid_args', BAD_SOURCE);
  const typed = hasArgv ? splitArgv(input.argv) : null;
  if (hasArgv && typed === null) return fail('invalid_args', BAD_ARGV);

  const resolved = await deps.resolveRepo({ repo: input.repo, cwd: input.cwd });
  if (resolved === null) return fail('not_a_repo', NOT_A_REPO);

  let command: Command;
  if (typed !== null) {
    command = typed;
  } else {
    const proposed = moduleCommand(input.module as string, resolved.repoDir, deps.roots);
    if ('code' in proposed) return fail(proposed.code, proposed.message);
    command = proposed;
  }
  const cwd = normaliseWorkdir(input.workdir, resolved.repoDir);
  if (cwd === null) return fail('invalid_workdir', BAD_WORKDIR);
  const sha256 = commandHash({ ...command, cwd }, resolved.repoDir);
  if (sha256 === null) return fail('invalid_workdir', BAD_WORKDIR);
  const preview: AllowPreview = { repo: resolved.repoDir, ...command, cwd, sha256, ...(hasModule ? { fromModule: true as const } : {}) };
  return { ok: true, preview, written: false, alreadyAllowed: false };
}

/** What is wrong with the user's configuration file, or the text it holds. */
type Inspected =
  | { readonly ok: true; readonly read: BoundedRead; readonly json: Record<string, unknown> }
  | { readonly ok: false; readonly code: 'config_invalid'; readonly reason: string };

/**
 * Read `file` with the loader's own bounded reader and check it against the loader's own strict schema. A file the
 * loader would ignore is a file the writer refuses to touch: appending to it would either bury the user's mistake or
 * turn half a configuration into a permission.
 */
function inspect(file: string): Inspected {
  const read = readBounded(file);
  if (read.kind === 'refused') return { ok: false, code: 'config_invalid', reason: read.why };
  if (read.kind === 'missing') return { ok: true, read, json: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, code: 'config_invalid', reason: 'it is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'config_invalid', reason: 'it is not a JSON object' };
  }
  const checked = USER_CONFIG_SCHEMA.safeParse(parsed);
  if (!checked.success) return { ok: false, code: 'config_invalid', reason: fixedProblemOf(checked.error) };
  return { ok: true, read, json: parsed as Record<string, unknown> };
}

/** The file the entry goes to: the real file behind a link (a dotfile manager's), else the path itself. */
function targetOf(link: string, io: AllowFs): string {
  try {
    return io.realpathSync(link);
  } catch {
    return link;
  }
}

const sameRead = (a: BoundedRead, b: BoundedRead): boolean =>
  a.kind === b.kind && (a.kind !== 'ok' || (b.kind === 'ok' && a.text === b.text));

/**
 * Append one entry to `<userDir>/config.json`, creating the file when it is absent. The rules, each with a test:
 *   - the file is read through the loader's bounded reader and must pass the loader's strict schema, else it is not touched;
 *   - every other key is kept; an entry with the same repository and hash is a no-op (`already_allowed`);
 *   - the whole result is serialized, size-checked (the loader ignores a file over 64 KiB) and validated BEFORE any write;
 *   - it is written to a temporary file in the same directory, mode 0600, flushed, and renamed over the original, so a
 *     crash or a failure leaves the old file whole; the temporary file is removed on every failure;
 *   - if the file changed between the read and the rename, the other writer wins and nothing of ours replaces it;
 *   - a link to the file (dotfile managers) is followed, so the link stays a link.
 * Failure reasons are fixed sentences: they never quote the file, an error message or a path.
 */
export function addAllowEntry(userDir: string, entry: AllowEntry, io: AllowFs = fs): AddResult {
  const file = targetOf(path.join(userDir, CONFIG_FILE), io);
  const before = inspect(file);
  if (!before.ok) return before;

  const permissions = (before.json['permissions'] ?? {}) as { allow?: unknown[] };
  const existing = Array.isArray(permissions.allow) ? permissions.allow : [];
  const duplicate = existing.some((each) => {
    const old = each as Partial<AllowEntry>;
    return old.repo === entry.repo && old.sha256 === entry.sha256 && old.executable === entry.executable;
  });
  if (duplicate) return { ok: true, status: 'already_allowed' };

  const next = { ...before.json, permissions: { ...permissions, allow: [...existing, entry] } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > CONFIG_MAX_BYTES) return { ok: false, code: 'config_too_large', reason: TOO_LARGE };
  const checked = USER_CONFIG_SCHEMA.safeParse(next);
  if (!checked.success) return { ok: false, code: 'config_invalid', reason: fixedProblemOf(checked.error) };

  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${CONFIG_FILE}.${String(process.pid)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = io.openSync(temporary, 'wx', 0o600);
    try {
      io.writeFileSync(fd, text);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    if (!sameRead(before.read, readBounded(file))) return { ok: false, code: 'config_changed', reason: CHANGED };
    io.renameSync(temporary, file);
    renamed = true;
  } catch {
    return { ok: false, code: 'write_failed', reason: NOT_WRITTEN };
  } finally {
    if (!renamed) {
      try {
        io.unlinkSync(temporary);
      } catch {
        // Nothing to remove: it was never created, or it is already gone.
      }
    }
  }
  return { ok: true, status: 'added' };
}

/** The message of a failed write: the invalid-file sentence carries its reason, the others are fixed. */
function messageOf(failure: Extract<AddResult, { ok: false }>): string {
  return failure.code === 'config_invalid' ? invalidConfig(failure.reason) : failure.reason;
}

/**
 * Step one: the canonical preview of the command and its hash. Writes nothing. A user configuration file that could not
 * take the entry is reported now, so the person is not asked to approve something that cannot be recorded.
 */
export async function previewAllow(input: AllowInput, deps: AllowDeps): Promise<AllowResult> {
  const prepared = await prepare(input, deps);
  if (!prepared.ok) return prepared;
  const file = inspect(targetOf(path.join(deps.userDir, CONFIG_FILE), fs));
  if (!file.ok) return fail(file.code, invalidConfig(file.reason));
  return prepared;
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
  if (!added.ok) return fail(added.code, messageOf(added));
  return { ok: true, preview, written: added.status === 'added', alreadyAllowed: added.status === 'already_allowed' };
}

/** The envelope of an `allow` result: the preview for a dry run, `{written, sha256, executable, args}` for a confirmed call. */
function envelopeOf(result: AllowResult, confirmed: boolean): Envelope {
  if (!result.ok) return errorEnvelope(result.code, result.message);
  if (!confirmed) return okEnvelope<AllowPreview>(ALLOW_SCHEMA, result.preview);
  const data: AllowWritten = {
    written: result.written,
    sha256: result.preview.sha256,
    executable: result.preview.executable,
    args: result.preview.args,
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

/**
 * The user permission list a Host of this origin may use (D-15, SEC-02). A person at a terminal (`cli`) gets the list. An
 * agent's server (`mcp`) gets NONE unless the person started it with `--allow-build`: an approval recorded for the CLI
 * must not become something an agent can trigger just because its server is running. `undefined` is no list at all, so
 * only the first-party built-ins can run.
 */
export function permissionsFor(origin: HostOrigin, allowBuild: boolean, permissions: UserPermissions | undefined): UserPermissions | undefined {
  return origin === 'mcp' && !allowBuild ? undefined : permissions;
}

/**
 * The fixed diagnostic a command that is not approved gets. It names the two ways forward and nothing else: no argument,
 * path, module name or manifest text, because it travels in answers an agent reads.
 */
const NEEDS_APPROVAL_TEXT =
  'A command this repository declares was not run because it is not approved. A person approves one exact command with "gsd-atlas allow" in a terminal; the MCP server runs approved commands only when it was started with --allow-build.';

/**
 * Map a denied command to the degraded answer the caller reports: `needs_approval` plus the fixed diagnostic, for exactly
 * the runner's `command_denied` and for nothing else (a timeout or a spawn failure is not a missing approval).
 */
export function needsApprovalFrom(
  result: Pick<CommandResult, 'denied'>,
): { readonly degraded: Extract<DegradedCode, 'needs_approval'>; readonly diagnostic: Diagnostic } | null {
  if (result.denied?.code !== COMMAND_CODES.denied) return null;
  return { degraded: 'needs_approval', diagnostic: diagnostic('needs_approval', 'warning', NEEDS_APPROVAL_TEXT) };
}
