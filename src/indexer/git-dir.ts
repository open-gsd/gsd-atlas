/**
 * Which git directory belongs to a worktree, read with `fs` only (no git process), and where it may be.
 *
 * A linked worktree's `.git` is a file holding `gitdir: <path>`. That text comes from the repository, so it is
 * evidence, not an instruction (T-02-56): the directory it names is used only to find the worktree's NAME, and
 * only when its real path is `<common git directory>/worktrees/<name>`. A `.git` file that names anything else
 * (a hostile repository can write any path) gives `null`, and the Indexer neither watches nor maps that worktree.
 * The directory that is actually watched is always the common git directory reported by Source Tree.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The `.git` file of a real worktree is one short line; anything much longer is not read. */
const MAX_DOT_GIT_BYTES = 4096;

const realOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/**
 * True when the real path of `child` is the real path of `parent` or lies under it. A path that does not exist
 * is not inside anything. Compared with a trailing separator, so `/a/bc` is not inside `/a/b`.
 */
export function isInside(parent: string, child: string): boolean {
  const realParent = realOf(parent);
  const realChild = realOf(child);
  if (realParent === undefined || realChild === undefined) return false;
  if (realChild === realParent) return true;
  const prefix = realParent.endsWith(path.sep) ? realParent : realParent + path.sep;
  return realChild.startsWith(prefix);
}

/** The first `gitdir:` value of a `.git` file, or undefined. Reads at most {@link MAX_DOT_GIT_BYTES} bytes. */
function readGitDirLine(dotGit: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dotGit, 'r');
    const buffer = Buffer.alloc(MAX_DOT_GIT_BYTES);
    const read = fs.readSync(fd, buffer, 0, MAX_DOT_GIT_BYTES, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split(/\r?\n/)) {
      if (line.startsWith('gitdir:')) {
        const value = line.slice('gitdir:'.length).trim();
        return value === '' || value.includes('\0') ? undefined : value;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The name git gives `worktreeRoot` inside the common git directory: `''` for the main worktree, the directory
 * name under `<commonDir>/worktrees/` for a linked one, and `null` when the worktree's `.git` does not lead into
 * `commonDir` (missing, unreadable, or naming a directory outside it).
 */
export function gitDirNameOf(worktreeRoot: string, commonDir: string): string | null {
  const realCommon = realOf(commonDir);
  if (realCommon === undefined) return null;
  const dotGit = path.join(worktreeRoot, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return realOf(dotGit) === realCommon ? '' : null;
  if (!stat.isFile()) return null;

  const named = readGitDirLine(dotGit);
  if (named === undefined) return null;
  const target = realOf(path.resolve(worktreeRoot, named));
  if (target === undefined || !isInside(realCommon, target)) return null;
  if (target === realCommon) return '';
  return path.dirname(target) === path.join(realCommon, 'worktrees') ? path.basename(target) : null;
}
