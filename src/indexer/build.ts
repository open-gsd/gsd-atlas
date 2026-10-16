/**
 * A full build of one worktree: snapshot, source set, then index exactly the paths the store does not already
 * hold, then record the overlay. The Fact Store's `reconcile` says which paths those are (changed, new, pending,
 * stale, or gone), so a rebuild of an unchanged tree touches nothing and moves no watermark.
 *
 * The paths to index are handed to `processBatch`, which hashes them again before it reads them. That second
 * hash is deliberate (STO-02): a hash taken during the snapshot says nothing about the file a moment later, and
 * facts must never be filed under a hash the bytes they came from do not have. The cost is one more batched
 * `hash-object` over the paths that need work.
 */
import type { Diagnostic } from '../facts/index.ts';
import { SOURCE_TREE_CODES } from '../source-tree/index.ts';
import { UnknownWorktree } from '../fact-store/index.ts';
import type { Writer } from '../fact-store/index.ts';
import { compareCodeUnits, processBatch, runJob } from './process.ts';
import type { PathResult, ProcessContext } from './process.ts';
import type { BuildResult, FailedPath } from './types.ts';

export interface BuildTarget {
  /** The worktree root, also the Fact Store's worktree id. */
  readonly worktree: string;
  /** The branch or commit the overlay tracks. */
  readonly ref: string;
}

/**
 * The hash a path should keep in the overlay after a build. A path that failed keeps the hash of the facts it
 * already has (so they keep serving until Reconcile retries it); with none, the hash git computed on disk, which
 * makes the path pending.
 */
async function overlayHash(ctx: ProcessContext, worktree: string, result: PathResult, onDisk: string): Promise<string> {
  if (result.outcome !== 'failed') return result.hash ?? onDisk;
  try {
    return (await ctx.store.at(worktree).fileFacts(result.path)).data?.contentHash ?? onDisk;
  } catch (error) {
    if (error instanceof UnknownWorktree) return onDisk;
    throw error;
  }
}

export async function runBuild(ctx: ProcessContext, writer: Writer, target: BuildTarget): Promise<BuildResult> {
  const { worktree, ref } = target;
  const job = { cls: 'indexing' } as const;
  const extensions = ctx.host.extensions();

  const snapshot = await runJob(ctx, job, () => ctx.tree.snapshot(worktree));
  const source = await runJob(ctx, job, () =>
    ctx.tree.sourceSet(worktree, snapshot.files, { extensions, maxBytes: ctx.config.maxFileBytes }),
  );
  const truth = source.files;
  // A source file over the byte cap is a failure of the build (named in `failed`), not a silent skip, and it keeps
  // any facts it already has, exactly as a file the engine refuses does.
  const oversize = source.skipped
    .filter((d) => d.code === SOURCE_TREE_CODES.sourceTooLarge && d.subject !== undefined)
    .map((d) => d.subject as string);
  const isOversize = new Set(oversize);

  const { reindex } = await ctx.store.reconcile({ worktree, pathToHash: truth });
  const toIndex = reindex.filter((path) => truth.has(path));
  const departed = reindex.filter((path) => !truth.has(path) && !isOversize.has(path));

  const results = await processBatch(ctx, writer, worktree, toIndex, { job });

  const overlay = new Map(truth);
  for (const result of results) {
    if (result.outcome === 'removed' || result.outcome === 'skipped') {
      overlay.delete(result.path);
    } else {
      overlay.set(result.path, await overlayHash(ctx, worktree, result, truth.get(result.path) as string));
    }
  }
  for (const path of oversize) {
    const result: PathResult = { path, outcome: 'failed', code: SOURCE_TREE_CODES.sourceTooLarge };
    overlay.set(path, await overlayHash(ctx, worktree, result, snapshot.files.get(path) as string));
  }
  const finalOverlay = new Map([...overlay].sort(([a], [b]) => compareCodeUnits(a, b)));
  await writer.setOverlay(worktree, ref, finalOverlay);

  const failures: FailedPath[] = [
    ...results.filter((r) => r.outcome === 'failed').map((r) => ({ worktree, path: r.path, code: r.code ?? 'internal_error' })),
    ...oversize.map((path) => ({ worktree, path, code: SOURCE_TREE_CODES.sourceTooLarge })),
  ];
  const skipped: Diagnostic[] = [
    ...snapshot.diagnostics,
    ...source.skipped.filter((d) => d.code !== SOURCE_TREE_CODES.sourceTooLarge),
  ];
  return {
    files: truth.size,
    parsed: results.filter((r) => r.outcome === 'parsed').length,
    linked: results.filter((r) => r.outcome === 'linked').length + (truth.size - toIndex.length),
    removed: departed.length + results.filter((r) => r.outcome === 'removed').length,
    skipped,
    failed: failures,
  };
}
