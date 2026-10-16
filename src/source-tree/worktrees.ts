import type { WorktreeInfo } from './types.ts';

const ZERO_ID = /^0+$/;
const BRANCH_PREFIX = 'refs/heads/';

interface Draft {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/**
 * Parses the output of `git worktree list --porcelain -z`.
 *
 * With `-z` every attribute is one NUL-terminated field (`worktree <path>`, `HEAD <id>`, `branch <ref>`,
 * `detached`, `bare`, `locked [<reason>]`, `prunable [<reason>]`) and an empty field ends a record, so a path
 * with spaces, a line break or a non-ASCII letter is carried verbatim. A record starts at its `worktree ` field
 * and nothing else is assumed about the order after it; unknown fields are ignored so a newer git cannot break
 * the parse. The all-zero id git prints for a branch with no commits yet becomes `head: null`.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const records: Draft[] = [];
  let current: Draft | undefined;
  for (const field of output.split('\0')) {
    if (field === '') continue;
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      records.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (field.startsWith('HEAD ')) {
      const id = field.slice('HEAD '.length);
      current.head = ZERO_ID.test(id) ? null : id;
    } else if (field.startsWith('branch ')) {
      const ref = field.slice('branch '.length);
      current.branch = ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref;
    } else if (field === 'detached') current.detached = true;
    else if (field === 'bare') current.bare = true;
    else if (field === 'locked' || field.startsWith('locked ')) current.locked = true;
    else if (field === 'prunable' || field.startsWith('prunable ')) current.prunable = true;
  }
  return records;
}
