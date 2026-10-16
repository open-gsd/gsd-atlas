import type { WorktreeInfo } from './types.ts';

/** Parses the output of `git worktree list --porcelain -z` into worktrees. Not implemented yet. */
export function parseWorktreeList(_output: string): WorktreeInfo[] {
  return [];
}
