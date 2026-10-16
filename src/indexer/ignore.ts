/**
 * Dropping ignored watcher paths (T-02-14). `SourceTree.hashPaths` hashes what it is asked and does not consult
 * ignore rules, and git's `check-ignore` is not in the CommandRunner allowlist, so the Indexer decides for itself
 * which event paths git would ignore, using the one thing Source Tree does answer: a snapshot lists exactly the
 * tracked and untracked-but-not-ignored files.
 *
 * - A path seen in a snapshot (a build, or an earlier verdict) is known not to be ignored.
 * - A path that no longer exists is kept: hashing reports it missing and the overlay forgets it.
 * - Any other path is new to us. One snapshot per call settles every such path at once: listed means not
 *   ignored, absent means ignored (or a link, a directory or another thing that is never hashed). Verdicts are
 *   remembered, so a noisy ignored directory costs one snapshot, not one per event.
 * - A change to a `.gitignore` file invalidates what was remembered for the worktree. Paths whose status the
 *   new rules change are repaired by Reconcile (plan 02-17), not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceTree } from '../source-tree/index.ts';

/** The most ignored paths remembered per worktree; past it the memory is cleared and rebuilt by later verdicts. */
const IGNORED_MEMORY = 100_000;

export interface PathFilter {
  /** Record paths a snapshot listed: they are not ignored. */
  learn(worktree: string, paths: Iterable<string>): void;
  /** Split `paths` into those that may be hashed and those git would ignore (or that are never hashed). */
  keep(worktree: string, paths: readonly string[]): Promise<{ readonly kept: string[]; readonly dropped: string[] }>;
}

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

async function exists(worktree: string, rel: string): Promise<boolean> {
  try {
    await fs.promises.lstat(path.join(worktree, rel));
    return true;
  } catch {
    return false;
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

      const undecided: string[] = [];
      for (const rel of unknown) {
        if (await exists(worktree, rel)) undecided.push(rel);
        else kept.push(rel);
      }
      if (undecided.length > 0) {
        const { files } = await tree.snapshot(worktree);
        for (const rel of files.keys()) knownHere.add(rel);
        if (ignoredHere.size + undecided.length > IGNORED_MEMORY) ignoredHere.clear();
        for (const rel of undecided) {
          if (files.has(rel)) {
            kept.push(rel);
          } else {
            ignoredHere.add(rel);
            dropped.push(rel);
          }
        }
      }
      return { kept, dropped };
    },
  };
}
