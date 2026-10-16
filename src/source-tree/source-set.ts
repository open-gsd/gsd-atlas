/**
 * The source-set rules (LNG-05), independent of how git and the file system are reached: the real tree and
 * the fake both hand this module two functions (`checkAttr` and `peek`) and share every decision, so the
 * codes and the order cannot drift between them.
 *
 * Order of the rules, cheapest first: a loaded module must claim the extension; the name must be safe to
 * inspect; git must not mark the file `linguist-generated` or `linguist-vendored` (one batched query for all
 * survivors); then each survivor is opened once, in batches of 64, and its size and first 8 KB decide the
 * byte cap, the binary rule (a NUL byte) and the Git LFS pointer rule. Each dropped file gets exactly one
 * diagnostic, except unclaimed extensions, which are one aggregated info count (a repository is mostly
 * files no module wants, so a line per file would drown the real skips).
 */
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES, SourceTreeError } from './types.ts';
import type { SourceSetOptions, SourceSetResult } from './types.ts';
import { unhashableReason } from './validate.ts';

/** How much of a file is inspected for a NUL byte and the LFS pointer line. */
export const SOURCE_PEEK_BYTES = 8192;
/** How many files are opened at once. */
const PEEK_BATCH = 64;
/** The first line of every Git LFS pointer file (the LFS spec, v1). */
const LFS_SPEC_LINE = 'version https://git-lfs.github.com/spec/v1';

/** The linguist attributes git reports for one path; `unset`, `unspecified` and `false` all mean off. */
export interface PathAttributes {
  readonly generated: boolean;
  readonly vendored: boolean;
}

/** What opening a file for inspection found. A link or anything that is not a regular file is never read. */
export type PeekResult =
  | { readonly kind: 'ok'; readonly size: number; readonly head: Uint8Array }
  | { readonly kind: 'missing' | 'symlink' | 'dir' | 'special' };

export interface SourceSetInputs {
  readonly files: ReadonlyMap<string, string>;
  readonly options: SourceSetOptions;
  /** ONE batched attribute query for all given paths; a path missing from the answer has no attributes. */
  checkAttr(paths: readonly string[]): Promise<ReadonlyMap<string, PathAttributes>>;
  /** Size and the first {@link SOURCE_PEEK_BYTES} bytes of one file, or why it cannot be inspected. */
  peek(rel: string): Promise<PeekResult>;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lower-case extension of the last path segment, with its dot, or '' when it has none (`.gitignore` has none). */
export function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** True when the bytes begin with the LFS spec line (followed by a line end or the end of the data). */
function isLfsPointer(head: Uint8Array): boolean {
  const line = Buffer.from(LFS_SPEC_LINE);
  if (head.length < line.length || !Buffer.from(head.buffer, head.byteOffset, line.length).equals(line)) return false;
  const next = head[line.length];
  return next === undefined || next === 0x0a || next === 0x0d;
}

/** Why a file that exists is dropped by size or content, or null when it stays. */
export function contentSkip(size: number, head: Uint8Array, maxBytes: number): { code: string; message: string } | null {
  if (size > maxBytes) {
    return { code: SOURCE_TREE_CODES.sourceTooLarge, message: `the file is ${String(size)} bytes, over the ${String(maxBytes)} byte cap` };
  }
  if (head.subarray(0, SOURCE_PEEK_BYTES).includes(0)) {
    return { code: SOURCE_TREE_CODES.binarySkipped, message: 'a NUL byte in the first 8 KB marks this file as binary' };
  }
  if (isLfsPointer(head)) {
    return { code: SOURCE_TREE_CODES.lfsPointerSkipped, message: 'this is a Git LFS pointer, not the file it stands for' };
  }
  return null;
}

export async function filterSourceSet(input: SourceSetInputs): Promise<SourceSetResult> {
  const { files, options } = input;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new SourceTreeError('invalid_argument', 'maxBytes must be a non-negative integer');
  }
  if (files.size === 0 || options.extensions.length === 0) return { files: new Map(), skipped: [] };

  const claimed = new Set(options.extensions.map((e) => e.toLowerCase()));
  const dropped = new Map<string, Diagnostic>();
  const drop = (rel: string, code: string, severity: Diagnostic['severity'], message: string): void => {
    dropped.set(rel, diagnostic(code, severity, message, rel));
  };

  // 1. Extension, then name safety. Unclaimed extensions are counted, not listed.
  const sorted = [...files.keys()].sort(compareCodeUnits);
  let unclaimed = 0;
  const named: string[] = [];
  for (const rel of sorted) {
    if (!claimed.has(extensionOf(rel))) {
      unclaimed += 1;
      continue;
    }
    const reason = unhashableReason(rel);
    if (reason !== null) drop(rel, SOURCE_TREE_CODES.unhashablePath, 'warning', reason);
    else named.push(rel);
  }

  // 2. Generated and vendored files, from one batched attribute query.
  const candidates: string[] = [];
  if (named.length > 0) {
    const attributes = await input.checkAttr(named);
    for (const rel of named) {
      const attr = attributes.get(rel);
      if (attr?.generated === true) drop(rel, SOURCE_TREE_CODES.generatedSkipped, 'info', 'git marks this file linguist-generated');
      else if (attr?.vendored === true) drop(rel, SOURCE_TREE_CODES.vendoredSkipped, 'info', 'git marks this file linguist-vendored');
      else candidates.push(rel);
    }
  }

  // 3. Size, binary and LFS pointer, from one bounded look at each remaining file.
  const survivors = new Set<string>();
  for (let at = 0; at < candidates.length; at += PEEK_BATCH) {
    const slice = candidates.slice(at, at + PEEK_BATCH);
    const peeks = await Promise.all(slice.map((rel) => input.peek(rel)));
    slice.forEach((rel, i) => {
      const seen = peeks[i];
      switch (seen?.kind) {
        case 'ok': {
          const skip = contentSkip(seen.size, seen.head, options.maxBytes);
          if (skip === null) survivors.add(rel);
          else drop(rel, skip.code, 'info', skip.message);
          break;
        }
        case 'symlink':
          drop(rel, SOURCE_TREE_CODES.symlinkSkipped, 'info', 'a symbolic link is never followed');
          break;
        case 'dir':
          drop(rel, SOURCE_TREE_CODES.gitlinkSkipped, 'info', 'a directory is not a source file');
          break;
        case 'special':
          drop(rel, SOURCE_TREE_CODES.unhashablePath, 'warning', 'not a regular file');
          break;
        default:
          drop(rel, SOURCE_TREE_CODES.missingOnDisk, 'info', 'the file is not on disk any more (deleted after it was listed)');
      }
    });
  }

  const kept = new Map<string, string>();
  for (const rel of sorted) {
    if (survivors.has(rel)) kept.set(rel, files.get(rel) as string);
  }
  const skipped: Diagnostic[] = [];
  if (unclaimed > 0) {
    skipped.push(
      diagnostic(
        SOURCE_TREE_CODES.extensionNotClaimed,
        'info',
        `${String(unclaimed)} ${unclaimed === 1 ? 'file has' : 'files have'} an extension no loaded module claims`,
      ),
    );
  }
  for (const rel of [...dropped.keys()].sort(compareCodeUnits)) skipped.push(dropped.get(rel) as Diagnostic);
  return { files: kept, skipped };
}
