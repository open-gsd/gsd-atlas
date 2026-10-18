/**
 * Reconcile (IDX-03, D-13): the correctness mechanism of the Indexer. The file watcher only makes freshness quick;
 * Reconcile makes it true. It takes a snapshot of the worktree through Source Tree, keeps the source files, asks
 * the Fact Store which paths differ (`store.reconcile`) and indexes exactly those, then records the overlay. An
 * event that was never delivered, an atomic-rename save the watcher reported oddly, a branch switch, a file
 * written while nothing was watching: all of them are repaired by the next Reconcile.
 *
 * A full build is the same operation at the `indexing` priority (see `build.ts`); the paths the store already
 * holds cost nothing, so a Reconcile of an unchanged tree touches no file, parses nothing and moves no watermark.
 *
 * The paths to index are handed to `processBatch` in chunks, which hashes them again before it reads them. That
 * second hash is deliberate (STO-02): a hash taken during the snapshot says nothing about the file a moment later,
 * and facts must never be filed under a hash the bytes they came from do not have.
 *
 * Other jobs may commit while a Reconcile runs (a file event, an `ensureFresh`). The overlay it writes at the end
 * replaces the whole overlay, so for every path such a job touched the overlay takes the hash the store holds NOW
 * (`hooks.touched`), never the older hash of the snapshot.
 */
import { UnknownWorktree } from '../fact-store/index.ts';
import type { Writer } from '../fact-store/index.ts';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { CITATION_COMMENT_TOO_LONG } from '../grammar-engine/index.ts';
import { SOURCE_TREE_CODES } from '../source-tree/index.ts';
import { compareCodeUnits, emitOutputsAmong, processBatch, runJob } from './process.ts';
import type { PathResult, ProcessContext } from './process.ts';
import type { FailedPath, ReconcileOutcome } from './types.ts';

/** The aggregated note a run leaves when it kept emit outputs out of the overlay; counts only, never a path. */
export const EMIT_OUTPUT_NOT_INDEXED = 'emit_output_not_indexed';

/** `indexing` for start-up, watcher problems, HEAD changes and builds; `maintenance` for the idle timer. */
export type ReconcilePriority = 'indexing' | 'maintenance';

export interface ReconcileTarget {
  /** The worktree root, also the Fact Store's worktree id. */
  readonly worktree: string;
  /** The branch or commit the overlay tracks. */
  readonly ref: string;
}

/**
 * How many paths are handed to batch processing at a time. Not a timeout, a queue bound or a gate threshold, so it
 * has no row in 02-CONSTANTS.md: it only bounds how much one Governor submission holds.
 */
const RECONCILE_CHUNK = 256;

/**
 * Tells the Indexer what a run did path by path, so it can keep its failure list and send notices: the results of
 * the paths it indexed (oversize ones included, as failures) and the paths that left the overlay.
 */
export type ReconcileObserver = (results: readonly PathResult[], departed: readonly string[]) => void;

export interface ReconcileHooks {
  readonly observe?: ReconcileObserver;
  /**
   * Paths that other jobs committed since the run began. The set may grow while the run is in progress; it is read
   * once, right before the overlay is written.
   */
  readonly touched?: ReadonlySet<string>;
}

/** What a run found and did: the {@link ReconcileOutcome} plus what a build reports. */
export interface ReconcileReport extends ReconcileOutcome {
  /** Files in the source set: the ones the overlay now maps. */
  readonly files: number;
  /** Snapshot diagnostics plus one diagnostic per file the source set dropped (and one count of unclaimed extensions). */
  readonly skipped: readonly Diagnostic[];
  readonly failed: readonly FailedPath[];
}

/**
 * The hash a path should keep in the overlay after a run. A path that failed keeps the hash of the facts it
 * already has (so they keep serving until the next Reconcile retries it); with none, the hash git computed on
 * disk, which makes the path pending.
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

/** Let the overlay say what the store holds now for the paths other jobs committed during the run. */
async function applyTouched(ctx: ProcessContext, worktree: string, overlay: Map<string, string>, touched: ReadonlySet<string>): Promise<void> {
  const reader = ctx.store.at(worktree);
  for (const rel of [...touched].sort(compareCodeUnits)) {
    try {
      const facts = (await reader.fileFacts(rel)).data;
      if (facts === null) overlay.delete(rel);
      else overlay.set(rel, facts.contentHash);
    } catch (error) {
      if (!(error instanceof UnknownWorktree)) throw error;
    }
  }
}

/**
 * Compare `target.worktree` with the store and index what differs, then record the overlay. Rejects only with
 * `IndexerError('stopped')` or when the Writer itself is unusable; everything about a single file is a result.
 */
export async function reconcileWorktree(
  ctx: ProcessContext,
  writer: Writer,
  target: ReconcileTarget,
  priority: ReconcilePriority,
  hooks: ReconcileHooks = {},
): Promise<ReconcileReport> {
  const { worktree, ref } = target;
  const startedAt = ctx.now();
  const job = { cls: priority } as const;
  const extensions = ctx.host.extensions();

  const snapshot = await runJob(ctx, job, () => ctx.tree.snapshot(worktree));
  // A snapshot lists only files git does not ignore, so these paths need no ignore verdict later.
  ctx.filter.learn(worktree, snapshot.files.keys());
  const source = await runJob(ctx, job, () =>
    ctx.tree.sourceSet(worktree, snapshot.files, { extensions, maxBytes: ctx.config.maxFileBytes }),
  );
  // The emit outputs of included sources get no facts (TSM-03, OQ3): they are left out of the truth, so the overlay this
  // run writes does not map them, whether or not it held them before. One question for the whole run.
  const excluded = await runJob(ctx, job, () => emitOutputsAmong(ctx, worktree, source.files.keys()));
  const truth: ReadonlyMap<string, string> =
    excluded.size === 0 ? source.files : new Map([...source.files].filter(([filePath]) => !excluded.has(filePath)));
  // A source file over the byte cap is a failure of the run (named in `failed`), not a silent skip, and it keeps
  // any facts it already has, exactly as a file the engine refuses does.
  const oversize = source.skipped
    .filter((d) => d.code === SOURCE_TREE_CODES.sourceTooLarge && d.subject !== undefined)
    .map((d) => d.subject as string);
  const isOversize = new Set(oversize);

  const { reindex } = await ctx.store.reconcile({ worktree, pathToHash: truth });
  const toIndex = reindex.filter((path) => truth.has(path)).sort(compareCodeUnits);
  const departed = reindex.filter((path) => !truth.has(path) && !isOversize.has(path));

  const results: PathResult[] = [];
  for (let from = 0; from < toIndex.length; from += RECONCILE_CHUNK) {
    results.push(...(await processBatch(ctx, writer, worktree, toIndex.slice(from, from + RECONCILE_CHUNK), { job })));
  }

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
  if (hooks.touched !== undefined && hooks.touched.size > 0) await applyTouched(ctx, worktree, overlay, hooks.touched);
  const finalOverlay = new Map([...overlay].sort(([a], [b]) => compareCodeUnits(a, b)));
  await writer.setOverlay(worktree, ref, finalOverlay);
  hooks.observe?.(
    [...results, ...oversize.map((path): PathResult => ({ path, outcome: 'failed', code: SOURCE_TREE_CODES.sourceTooLarge }))],
    departed,
  );

  const failures: FailedPath[] = [
    ...results.filter((r) => r.outcome === 'failed').map((r) => ({ worktree, path: r.path, code: r.code ?? 'internal_error' })),
    ...oversize.map((path) => ({ worktree, path, code: SOURCE_TREE_CODES.sourceTooLarge })),
  ];
  // Comments over the comment size bound are skipped whole, so the citations in them are missing: one counted note,
  // fixed text, no path and no repository text, says so (the extractor's per-file diagnostic is not kept).
  const commentFiles = results.filter((r) => r.commentsTooLong === true).length;
  const skipped: Diagnostic[] = [
    ...snapshot.diagnostics,
    ...source.skipped.filter((d) => d.code !== SOURCE_TREE_CODES.sourceTooLarge),
    ...(excluded.size === 0
      ? []
      : [
          diagnostic(
            EMIT_OUTPUT_NOT_INDEXED,
            'info',
            `${String(excluded.size)} ${excluded.size === 1 ? 'file is' : 'files are'} the emit output of an included source and ${excluded.size === 1 ? 'is' : 'are'} not indexed`,
          ),
        ]),
    ...(commentFiles === 0
      ? []
      : [
          diagnostic(
            CITATION_COMMENT_TOO_LONG,
            'info',
            `${String(commentFiles)} ${commentFiles === 1 ? 'file has' : 'files have'} comments that mention an ADR but are over the comment size bound; their citations are not indexed`,
          ),
        ]),
  ];
  return {
    changed: reindex.length,
    parsed: results.filter((r) => r.outcome === 'parsed').length,
    linked: results.filter((r) => r.outcome === 'linked').length + (truth.size - toIndex.length),
    removed: departed.length + results.filter((r) => r.outcome === 'removed').length,
    durationMs: Math.max(0, ctx.now() - startedAt),
    files: truth.size,
    skipped,
    failed: failures,
  };
}
