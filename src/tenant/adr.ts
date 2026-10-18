/**
 * The Tenant's ADR directory (plan 03-28, TSM-04, D-19, D-20): which ADR file, if any, a citation number names.
 *
 * Resolution is a read-time join, so the facts stay shareable across branches while the ADR directory can differ per branch: the
 * stored citation carries only a number, and this module lists the repository's ADR directories through the Source Tree seam
 * (`listDirectory`: confined, regular files only, no links followed, a bounded number of names) and matches the leading number of a
 * file name to the citation by value. ADR file contents are never read, indexed or returned; only the paths of the files are.
 *
 * The listing of a directory is remembered with its modification time. Asked again, the Source Tree is given that time and answers
 * `unchanged` for the price of one stat, so a question about a repository whose ADR directory did not change costs no read.
 */
import path from 'node:path';
import type { AdrLookup } from '../query/index.ts';
import type { DirectoryStatus, SourceTree } from '../source-tree/index.ts';

/** The directories searched when neither a module manifest nor the repository names any: the convention list. */
export const DEFAULT_ADR_DIRS: readonly string[] = ['docs/adr', 'docs/adrs', 'doc/adr', 'adr'];

/** The longest digit run a file name's number may have after leading zeros: 15 digits are always a safe integer. */
const MAX_NUMBER_DIGITS = 15;

/** `0001-first.md`: digits, a dash, a slug of at least one character, `.md`. No other extension, no other shape. */
const ADR_FILE_NAME = /^([0-9]+)-(.+)\.md$/;

/**
 * The ADR number a file name carries by value (`0001-first.md` is 1, `2-second.md` is 2, `00-zero.md` is 0), or null for a name
 * that is not an ADR file: no leading number, no dash and slug, another extension, or a number too large to compare. A zero ADR
 * number is allowed and is distinct from an absent one.
 */
export function parseAdrFileName(name: string): number | null {
  const match = ADR_FILE_NAME.exec(name);
  if (match === null) return null;
  const digits = (match[1] as string).replace(/^0+(?=[0-9])/, '');
  if (digits.length > MAX_NUMBER_DIGITS) return null;
  return Number(digits);
}

/** What listing one ADR directory found. */
export interface AdrDirectoryState {
  readonly dir: string;
  readonly status: DirectoryStatus;
  /** True when the Source Tree cut the listing, so a file may exist that is not in the index. */
  readonly truncated: boolean;
}

/** The ADR files of one worktree, by number, in the order of the directories given. */
export interface AdrIndex {
  /** The ADR number to the repo-relative paths of the files that carry it, sorted by code unit. */
  readonly byNumber: ReadonlyMap<number, readonly string[]>;
  readonly dirs: readonly AdrDirectoryState[];
  /** True when any directory's listing was cut. */
  readonly truncated: boolean;
}

export interface AdrDirectoryDeps {
  readonly tree: Pick<SourceTree, 'listDirectory'>;
  /** The directories to list for `worktree`, repo-relative, in order of precedence for nothing but the order of `dirs`. */
  readonly dirsFor: (worktree: string) => readonly string[] | Promise<readonly string[]>;
  /** The most names one listing returns; absent: the Source Tree's default (`adr.listMaxEntries`). */
  readonly maxEntries?: number;
}

export interface AdrDirectory {
  /** The ADR file or files `number` names in `worktree`: `resolved` (one), `ambiguous` (several, listed sorted) or `unresolved` (none). */
  lookup(worktree: string, number: number): Promise<AdrLookup>;
  /** The index of the worktree's ADR directories, refreshed by one stat per directory that did not change. */
  known(worktree: string): Promise<AdrIndex>;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How many directory listings are remembered; the oldest go first. Not a timeout, a queue bound or a gate threshold. */
const MEMO_ENTRIES = 256;

/** A directory as the Source Tree should be asked for it: POSIX, no leading `./`, no trailing slash. Path rules stay the tree's. */
function normaliseDir(dir: string): string {
  const unified = dir.replaceAll('\\', '/');
  const normal = path.posix.normalize(unified);
  const bare = normal.startsWith('./') ? normal.slice(2) : normal;
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

interface Remembered {
  readonly mtimeMs: number;
  readonly names: readonly string[];
  readonly truncated: boolean;
}

export function createAdrDirectory(deps: AdrDirectoryDeps): AdrDirectory {
  const memo = new Map<string, Remembered>();
  const built = new Map<string, { readonly signature: string; readonly index: AdrIndex }>();

  const remember = (key: string, value: Remembered): void => {
    memo.delete(key);
    memo.set(key, value);
    for (const oldest of memo.keys()) {
      if (memo.size <= MEMO_ENTRIES) break;
      memo.delete(oldest);
    }
  };

  async function known(worktree: string): Promise<AdrIndex> {
    const wanted: string[] = [];
    for (const raw of await deps.dirsFor(worktree)) {
      // Names stay as given when they cannot be normalised: the Source Tree decides what escapes, not this function.
      const dir = normaliseDir(raw);
      if (!wanted.includes(dir)) wanted.push(dir);
    }

    const states: AdrDirectoryState[] = [];
    const listed: Array<{ readonly dir: string; readonly names: readonly string[] }> = [];
    const stamps: string[] = [];
    for (const dir of wanted) {
      const key = `${worktree}\u0000${dir}`;
      const before = memo.get(key);
      const listing = await deps.tree.listDirectory(worktree, dir, {
        ...(before === undefined ? {} : { ifMtimeMs: before.mtimeMs }),
        ...(deps.maxEntries === undefined ? {} : { maxEntries: deps.maxEntries }),
      });
      if (listing.status !== 'ok') {
        memo.delete(key);
        states.push({ dir, status: listing.status, truncated: false });
        stamps.push(`${dir}:${listing.status}`);
        continue;
      }
      if (listing.unchanged === true && before !== undefined) {
        states.push({ dir, status: 'ok', truncated: before.truncated });
        listed.push({ dir, names: before.names });
        stamps.push(`${dir}:ok:${String(before.mtimeMs)}`);
        continue;
      }
      remember(key, { mtimeMs: listing.mtimeMs, names: listing.names, truncated: listing.truncated });
      states.push({ dir, status: 'ok', truncated: listing.truncated });
      listed.push({ dir, names: listing.names });
      stamps.push(`${dir}:ok:${String(listing.mtimeMs)}`);
    }

    // The index is rebuilt only when a directory's state moved (the listing itself is what costs; the join is cheap but not free).
    const signature = stamps.join('\u0001');
    const previous = built.get(worktree);
    if (previous !== undefined && previous.signature === signature) return previous.index;

    const byNumber = new Map<number, string[]>();
    for (const { dir, names } of listed) {
      for (const name of names) {
        const number = parseAdrFileName(name);
        if (number === null) continue;
        const list = byNumber.get(number) ?? [];
        list.push(dir === '.' ? name : `${dir}/${name}`);
        byNumber.set(number, list);
      }
    }
    for (const list of byNumber.values()) list.sort(compareCodeUnits);
    const index: AdrIndex = { byNumber, dirs: states, truncated: states.some((state) => state.truncated) };
    built.set(worktree, { signature, index });
    return index;
  }

  return {
    known,
    async lookup(worktree, number) {
      const index = await known(worktree);
      const files = index.byNumber.get(number) ?? [];
      if (files.length === 0) {
        // A cut listing may have left the file out: say so rather than let "no file" read as "no such ADR".
        return index.truncated ? { status: 'unresolved', files: [], listTruncated: true } : { status: 'unresolved', files: [] };
      }
      return { status: files.length === 1 ? 'resolved' : 'ambiguous', files };
    },
  };
}
