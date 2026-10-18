import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The exact-argv approval hash (D-15). A user-level allow entry may carry the sha256 of ONE command, so an approval
 * cannot be replayed after the command, its arguments or its directory changed.
 *
 * Pure computation over the spec and the repository identity the Host supplies: this module reads no file and takes
 * nothing from repository data (SEC-01). It must stay that way; a test keeps `decide.ts` and this file free of `fs`.
 */

/** The part of a spec that is hashed: what runs, with which arguments, from where. */
export interface HashableCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/**
 * The canonical text of a command: the JSON text of an object with the keys `executable`, `args` and `cwd`, in that
 * order. `args` is the exact string array, so `['a b']` and `['a','b']` differ (nothing is ever joined into a shell
 * string). `cwd` is the POSIX-style path relative to `repo` (`.` for the root; an absent `cwd` is the root).
 *
 * Returns `null` when no valid form exists: `repo` is not absolute, or `cwd` is outside the repository. Such a
 * command has no hash and is never allowed through a hashed entry.
 *
 * `pathModule` is the platform path module; tests inject `path.win32` to check the backslash form on any host.
 */
export function canonicalCommand(
  spec: HashableCommand,
  repo: string,
  pathModule: path.PlatformPath = path,
): string | null {
  if (!pathModule.isAbsolute(repo)) return null;
  const root = pathModule.resolve(repo);
  const dir = pathModule.resolve(root, spec.cwd ?? '.');
  const relative = pathModule.relative(root, dir);
  // A different Windows drive gives an absolute `relative`; `..` or `..<sep>...` escapes the repository.
  // A directory merely named `..cache` is inside it.
  if (relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) return null;
  const cwd = relative === '' ? '.' : relative.split(pathModule.sep).join('/');
  return JSON.stringify({ executable: spec.executable, args: spec.args, cwd });
}

/** The lower-case hex sha256 of {@link canonicalCommand}, or `null` when the command has no canonical form. */
export function commandHash(
  spec: HashableCommand,
  repo: string,
  pathModule: path.PlatformPath = path,
): string | null {
  const text = canonicalCommand(spec, repo, pathModule);
  return text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
}
