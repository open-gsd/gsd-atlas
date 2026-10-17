/**
 * Dropping ignored watcher paths (T-02-14). `SourceTree.hashPaths` hashes what it is asked and does not consult
 * ignore rules, and git's `check-ignore` is not in the CommandRunner allowlist, so the Indexer decides for itself
 * which event paths git would ignore, using the one thing Source Tree answers for this: `unignoredPaths`, which is
 * ONE pathspec-free `ls-files` listing (tracked, plus untracked and not ignored) filtered by exact name in process.
 * No name a watcher supplied reaches git, and nothing is hashed to get the verdict (plan 02-46).
 *
 * - A path seen listed (a build, or an earlier verdict) is known not to be ignored.
 * - A path that no longer exists is kept: hashing reports it missing and the overlay forgets it.
 * - A path that exists but is not a regular file (a symbolic link, a directory, a gitlink directory) is dropped and
 *   remembered with no git run: it is never hashed as a file.
 * - Any other path is new to us. One listing per call settles every such path at once: listed means not ignored,
 *   absent means ignored. Verdicts are remembered, so a noisy ignored directory costs one listing, not one per
 *   event. A failed listing leaves the memory exactly as it was.
 * - A change to a `.gitignore` file invalidates what was remembered for the worktree. Paths whose status the
 *   new rules change are repaired by Reconcile (plan 02-17), not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceTree } from '../source-tree/index.ts';
import { isRepoRelative } from './paths.ts';

/** The most ignored paths remembered per worktree; past it the memory is cleared and rebuilt by later verdicts. */
const IGNORED_MEMORY = 100_000;

export interface PathFilter {
  /** Record paths a snapshot listed: they are not ignored. */
  learn(worktree: string, paths: Iterable<string>): void;
  /** Split `paths` into those that may be hashed and those git would ignore (or that are never hashed). */
  keep(worktree: string, paths: readonly string[]): Promise<{ readonly kept: string[]; readonly dropped: string[] }>;
}

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

/** What `lstat` finds at `rel`: nothing, a regular file, or anything else (a link, a directory, a device). */
type Kind = 'missing' | 'file' | 'other';

async function kindOf(worktree: string, rel: string): Promise<Kind> {
  try {
    return (await fs.promises.lstat(path.join(worktree, rel))).isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
}

export function createPathFilter(tree: SourceTree): PathFilter {
  const known = new Map<string, Set<string>>();
  const ignored = new Map<string, Set<string>>();
  const setOf = (table: Map<string, Set<string>>, worktree: string): Set<string> => {
    let set = table.get(worktree);
    if (set === undefined) {
      set = new Set();
      table.set(worktree, set);
    }
    return set;
  };

  return {
    learn(worktree, paths) {
      const set = setOf(known, worktree);
      for (const rel of paths) set.add(rel);
    },

    async keep(worktree, paths) {
      if (paths.some((rel) => baseName(rel) === '.gitignore')) {
        known.delete(worktree);
        ignored.delete(worktree);
      }
      const knownHere = setOf(known, worktree);
      const ignoredHere = setOf(ignored, worktree);
      const kept: string[] = [];
      const dropped: string[] = [];
      const unknown: string[] = [];
      for (const rel of paths) {
        if (knownHere.has(rel)) kept.push(rel);
        else if (ignoredHere.has(rel)) dropped.push(rel);
        else unknown.push(rel);
      }

      // Nothing is remembered until the listing has answered, so a failed listing changes no verdict.
      const undecided: string[] = [];
      const never: string[] = [];
      for (const rel of unknown) {
        // A name that is not repo-relative is never asked of the tree (it would reject the whole call).
        const kind = isRepoRelative(rel) ? await kindOf(worktree, rel) : 'other';
        if (kind === 'missing') kept.push(rel);
        else if (kind === 'file') undecided.push(rel);
        else never.push(rel);
      }
      const listed = undecided.length === 0 ? new Set<string>() : await tree.unignoredPaths(worktree, undecided);

      if (ignoredHere.size + undecided.length + never.length > IGNORED_MEMORY) ignoredHere.clear();
      for (const rel of undecided) {
        if (listed.has(rel)) {
          knownHere.add(rel);
          kept.push(rel);
        } else {
          ignoredHere.add(rel);
          dropped.push(rel);
        }
      }
      for (const rel of never) {
        ignoredHere.add(rel);
        dropped.push(rel);
      }
      return { kept, dropped };
    },
  };
}
