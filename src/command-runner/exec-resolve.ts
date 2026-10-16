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

/**
 * Resolves a spec's executable to a path to hand to `spawn`, or explains why it cannot be run.
 * Absolute paths are checked as given; bare names are searched on PATH. Relative paths with a
 * separator are refused: they would depend on the host's working directory.
 */
export function resolveExecutable(name: string, opts: ResolveOptions = {}): ResolvedExecutable {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.pathExists ?? ((p: string) => defaultRunnable(p, platform));
  const p = platform === 'win32' ? path.win32 : path.posix;

  if (name === '') return fail(name, 'The executable name is empty.');

  if (p.isAbsolute(name)) {
    return exists(name) ? { ok: true, path: name } : fail(name, `${name} does not exist or is not executable.`);
  }
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    return fail(name, `${name} is a relative path; use a bare command name or an absolute path.`);
  }

  const pathVar = env['PATH'];
  if (pathVar === undefined || pathVar === '') return fail(name, `${name} was not found: PATH is not set.`);
  for (const dir of pathVar.split(p.delimiter)) {
    if (dir === '') continue;
    const candidate = p.join(dir, name);
    if (exists(candidate)) return { ok: true, path: candidate };
  }
  return fail(name, `${name} was not found on PATH.`);
}
