/**
 * The Source Tree fake: derived from the same data description the contract suite realises as a real
 * repository, so it cannot drift from git's behaviour without the shared contract failing. Production-safe:
 * it imports no test runner and no test-kit, and is exported from the index.
 *
 * Blob ids are real git ids (sha1 over `blob <length>\0` plus the bytes), so a snapshot from the fake
 * equals a snapshot of the realised repository. `ignored` entries are exact repo-relative paths, or
 * directory prefixes ending in `/`; like git's own ignore rules they apply to untracked files only.
 */
import { createHash } from 'node:crypto';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES } from './types.ts';
import type { SnapshotResult, SourceTree, SourceTreeIdentity, SourceTreeWorld } from './types.ts';
import { assertReadArguments, isObjectId } from './validate.ts';

const encoder = new TextEncoder();

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function blobId(content: string): string {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** A stable stand-in for the one commit: sha1 over the sorted committed entries. */
function commitId(committed: Readonly<Record<string, string>>): string {
  const h = createHash('sha1').update('fake commit\n');
  for (const rel of Object.keys(committed).sort(compareCodeUnits)) h.update(`${rel}\0${blobId(committed[rel] ?? '')}\n`);
  return h.digest('hex');
}

export function createFakeSourceTree(world: Partial<SourceTreeWorld> = {}): SourceTree {
  const committed = world.committed ?? {};
  const working = world.working ?? {};
  const ignored = world.ignored ?? [];
  const isIgnored = (rel: string): boolean => ignored.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));

  const committedPaths = Object.keys(committed);
  const rootCommit = committedPaths.length === 0 ? null : commitId(committed);
  const committedBlobs = new Set(committedPaths.map((rel) => blobId(committed[rel] ?? '')));
  const storeId = createHash('sha256').update(`${rootCommit ?? ''}\nfake`).digest('hex').slice(0, 16);

  return {
    snapshot(): Promise<SnapshotResult> {
      const diagnostics: Diagnostic[] = [];
      const paths = new Set([...committedPaths, ...Object.keys(working)]);
      const files = new Map<string, string>();
      for (const rel of [...paths].sort(compareCodeUnits)) {
        const tracked = Object.hasOwn(committed, rel);
        const edit = Object.hasOwn(working, rel) ? working[rel] : undefined;
        const content = edit === undefined ? committed[rel] : edit;
        if (content === null || content === undefined) {
          if (tracked) {
            diagnostics.push(diagnostic(SOURCE_TREE_CODES.missingOnDisk, 'info', 'git lists this path but it is not on disk (deleted or sparse)', rel));
          }
          continue;
        }
        if (!tracked && isIgnored(rel)) continue;
        files.set(rel, blobId(content));
      }
      return Promise.resolve({ files, diagnostics });
    },

    hasObject(hash: string): Promise<boolean> {
      return Promise.resolve(isObjectId(hash) && (committedBlobs.has(hash) || hash === rootCommit));
    },

    // async so that invalid arguments reject, exactly as the real tree's read does.
    async read(commit: string, relPath: string): Promise<Uint8Array | null> {
      assertReadArguments(commit, relPath);
      const known = commit === 'HEAD' || (rootCommit !== null && commit === rootCommit);
      if (!known || !Object.hasOwn(committed, relPath)) return null;
      return encoder.encode(committed[relPath] ?? '');
    },

    identity(): Promise<SourceTreeIdentity> {
      return Promise.resolve({ rootCommit, storeId });
    },
  };
}
