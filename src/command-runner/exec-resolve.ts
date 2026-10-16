import fs from 'node:fs';
import path from 'node:path';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { COMMAND_CODES } from './spec.ts';

export interface ResolveOptions {
  /** Defaults to `process.platform`. Injectable so Linux and macOS CI exercise the win32 rules. */
  readonly platform?: NodeJS.Platform;
  /** The environment whose PATH is searched (the child's, after scrubbing). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** True when `p` is a file this platform may run. Defaults to {@link defaultRunnable}. */
  readonly pathExists?: (p: string) => boolean;
}

export type ResolvedExecutable =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

/** Real file-system check: a regular file, and on posix an executable one. */
export function defaultRunnable(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fail(name: string, message: string, code: string = COMMAND_CODES.spawnFailed): ResolvedExecutable {
  return { ok: false, diagnostic: diagnostic(code, 'error', message, name) };
}

const shimRejected = (name: string): ResolvedExecutable =>
  fail(
    name,
    `${name} is a Windows script shim (.cmd, .bat, npm or npx) and is never started: cmd.exe would interpret its arguments. Run Node scripts as process.execPath <script>, or name a real .exe.`,
    COMMAND_CODES.shimRejected,
  );

const WIN_RUNNABLE = ['.exe', '.com'];
const WIN_SHIMS = ['.cmd', '.bat'];
/** Node's package-manager launchers: .cmd shims on Windows, so they are refused by name even when an .exe exists. */
const NODE_LAUNCHERS = new Set(['npm', 'npx']);
/** A letter-led extension that is neither runnable nor a shim (.ps1, .js, .vbs, ...); digit-led ones (python3.11) are part of the name. */
const FOREIGN_EXTENSION = /^\.[a-z][a-z0-9]*$/;

function findPathVar(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env['PATH'];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key === undefined ? undefined : env[key];
}

/**
 * Resolves a spec's executable to a path to hand to `spawn`, or explains why it cannot be run.
 * Absolute paths are checked as given; bare names are searched on PATH. Relative paths with a
 * separator are refused: they would depend on the host's working directory.
 *
 * Windows rules (D-11, T-01-22): only `.exe` and `.com` are ever resolved; `.cmd`/`.bat` and the
 * npm/npx launchers are rejected with `shim_rejected`, because Node refuses to spawn them without a
 * shell and a shell would reintroduce cmd.exe metacharacter injection.
 */
export function resolveExecutable(name: string, opts: ResolveOptions = {}): ResolvedExecutable {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.pathExists ?? ((p: string) => defaultRunnable(p, platform));

  if (name === '') return fail(name, 'The executable name is empty.');
  return platform === 'win32' ? resolveWindows(name, env, exists) : resolvePosix(name, env, exists);
}

function resolvePosix(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (p: string) => boolean,
): ResolvedExecutable {
  const p = path.posix;
  if (p.isAbsolute(name)) {
    return exists(name) ? { ok: true, path: name } : fail(name, `${name} does not exist or is not executable.`);
  }
  if (name.includes('/')) {
    return fail(name, `${name} is a relative path; use a bare command name or an absolute path.`);
  }
  const pathVar = findPathVar(env, 'linux');
  if (pathVar === undefined || pathVar === '') return fail(name, `${name} was not found: PATH is not set.`);
  for (const dir of pathVar.split(p.delimiter)) {
    if (dir === '') continue;
    const candidate = p.join(dir, name);
    if (exists(candidate)) return { ok: true, path: candidate };
  }
  return fail(name, `${name} was not found on PATH.`);
}

function resolveWindows(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (p: string) => boolean,
): ResolvedExecutable {
  const p = path.win32;
  const base = p.basename(name).toLowerCase();
  const ext = p.extname(base);
  const stem = WIN_RUNNABLE.includes(ext) ? base.slice(0, -ext.length) : base;

  if (WIN_SHIMS.includes(ext) || NODE_LAUNCHERS.has(stem)) return shimRejected(name);
  if (FOREIGN_EXTENSION.test(ext) && !WIN_RUNNABLE.includes(ext)) {
    return fail(name, `${name} cannot be started: only .exe and .com files are run on Windows.`);
  }

  /** The files a name can mean in one directory: itself when it ends .exe/.com, else with each runnable extension. */
  const candidatesIn = (dir: string | undefined): string[] => {
    const join = (file: string): string => (dir === undefined ? file : p.join(dir, file));
    return WIN_RUNNABLE.includes(ext) ? [join(name)] : WIN_RUNNABLE.map((e) => join(name + e));
  };
  const shimIn = (dir: string | undefined): boolean =>
    WIN_SHIMS.some((e) => exists(dir === undefined ? name + e : p.join(dir, name + e)));

  if (p.isAbsolute(name)) {
    const hit = candidatesIn(undefined).find(exists);
    if (hit !== undefined) return { ok: true, path: hit };
    return shimIn(undefined) ? shimRejected(name) : fail(name, `${name} does not exist.`);
  }
  if (name.includes('/') || name.includes('\\')) {
    return fail(name, `${name} is a relative path; use a bare command name or an absolute path.`);
  }

  const pathVar = findPathVar(env, 'win32');
  if (pathVar === undefined || pathVar === '') return fail(name, `${name} was not found: PATH is not set.`);
  const dirs = pathVar.split(p.delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    const hit = candidatesIn(dir).find(exists);
    if (hit !== undefined) return { ok: true, path: hit };
  }
  // Nothing runnable: if only a shim exists, say so, because that is the actionable fact.
  return dirs.some(shimIn) ? shimRejected(name) : fail(name, `${name} was not found on PATH.`);
}
