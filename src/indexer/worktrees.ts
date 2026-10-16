/**
 * Which worktrees the Indexer covers (STO-03). Source Tree lists the worktrees of the repository
 * (`git worktree list`); the Indexer covers the ones that are real, and keeps its set in step when a worktree is
 * added or removed: a new one is subscribed, a gone one is unsubscribed and its overlay dropped. The shared
 * facts stay, so a worktree added later links to what the others already parsed.
 */
import type { WorktreeInfo } from '../source-tree/index.ts';
import { gitDirNameOf } from './git-dir.ts';

/**
 * The worktrees that may be watched and indexed, by root, with the name of each one's git directory. A bare
 * repository is not a worktree and a prunable entry has no directory; a worktree whose `.git` does not lead into
 * the common git directory (it names a directory somewhere else, T-02-56) is left out, so nothing a repository
 * file merely names is ever watched or mapped.
 */
export function eligibleWorktrees(listed: readonly WorktreeInfo[], commonDir: string): ReadonlyMap<string, string> {
  const eligible = new Map<string, string>();
  for (const info of listed) {
    if (info.bare || info.prunable) continue;
    const name = gitDirNameOf(info.path, commonDir);
    if (name !== null) eligible.set(info.path, name);
  }
  return eligible;
}

export interface WorktreeSyncInput {
  /** What `SourceTree.worktrees()` lists now. */
  readonly listed: readonly WorktreeInfo[];
  readonly commonDir: string;
  /** The roots the Indexer covers now. */
  readonly covered: Iterable<string>;
  /** False when the Indexer covers only the worktrees it was told to: a worktree that appeared is then left alone. */
  readonly addNew: boolean;
  /** Cover `root` (its git directory name is given): subscribe it and Reconcile it. */
  subscribe(root: string, gitDirName: string): Promise<void>;
  /** Stop watching `root`. */
  unsubscribe(root: string): Promise<void>;
  /** Drop `root`'s overlay from the store. */
  drop(root: string): Promise<void>;
}

export interface WorktreeSyncResult {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Bring the covered set in step with the listed worktrees. Removals first, then additions, each in path order. */
export async function syncWorktrees(input: WorktreeSyncInput): Promise<WorktreeSyncResult> {
  const eligible = eligibleWorktrees(input.listed, input.commonDir);
  const covered = new Set(input.covered);

  const removed = [...covered].filter((root) => !eligible.has(root)).sort(compareCodeUnits);
  for (const root of removed) {
    await input.unsubscribe(root);
    await input.drop(root);
  }

  const added = input.addNew ? [...eligible.keys()].filter((root) => !covered.has(root)).sort(compareCodeUnits) : [];
  for (const root of added) await input.subscribe(root, eligible.get(root) as string);
  return { added, removed };
}
