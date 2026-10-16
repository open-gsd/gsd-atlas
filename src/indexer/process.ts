/**
 * Batch processing: the heart of the Indexer. A batch is a worktree and a set of repo-relative paths; the
 * result is one `PathResult` per path, and the Fact Store holds the new facts, the attached facts or nothing
 * for the path, as the file on disk now says.
 *
 * The order of work for a batch:
 * 1. Paths whose extension no loaded module claims are set aside (no git, no read).
 * 2. `SourceTree.hashPaths` hashes the rest with ONE batched git run; it hashes what it is asked and does not
 *    consult ignore rules (T-02-14), which is why every caller of `processBatch` has already dropped ignored
 *    watcher paths (a build passes snapshot paths, which git has already filtered).
 * 3. `SourceTree.sourceSet` keeps the files that are source (LNG-05): not generated, vendored, binary, an LFS
 *    pointer or oversize.
 * 4. Each survivor is tried with `Writer.link` first (the store may already hold facts for its hash); only an
 *    unknown hash is read and parsed (STO-03's basis), then committed under the hash git computed.
 * 5. A path that disappeared, stopped being source or stopped being claimed is removed with a null commit.
 *
 * Every unit of work runs through the Governor in the class the caller names. Nothing in a batch can stop the
 * queue: a failing file is a `failed` result with a code, and the next file is processed.
 */
import { UnknownWorktree } from '../fact-store/index.ts';
import type { FactStore, Writer } from '../fact-store/index.ts';
import type { Governor, JobClass } from '../governor/index.ts';
import { SOURCE_TREE_CODES } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { extensionOf } from './modules.ts';
import type { ModuleHost } from './modules.ts';
import { IndexerError } from './types.ts';
import type { IndexerConfig } from './types.ts';

/** How many independent files are handed to the Governor at once; the Governor's own queue bound does the rest. */
const IN_FLIGHT_PATHS = 8;

export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Everything batch processing needs from the Indexer that owns it. */
export interface ProcessContext {
  readonly tenant: string;
  readonly tree: SourceTree;
  readonly store: FactStore;
  readonly governor: Governor;
  readonly host: ModuleHost;
  readonly config: IndexerConfig;
  isStopped(): boolean;
  /** Waits `ms` of the injected clock's time; a stop wakes it early. */
  sleep(ms: number): Promise<void>;
}

/** The Governor class (and, for `fresh`, the request whose single slot the jobs share) a batch runs under. */
export interface JobSpec {
  readonly cls: JobClass;
  readonly requestId?: string;
}

/**
 * `parsed`: facts extracted and committed. `linked`: attached to facts the store already held. `removed`: the path
 * left the overlay. `skipped`: nothing to do (not source and not in the overlay). `failed`: `code` says why; the
 * previous facts, if any, are untouched.
 */
export type PathOutcome = 'parsed' | 'linked' | 'removed' | 'skipped' | 'failed';

export interface PathResult {
  readonly path: string;
  readonly outcome: PathOutcome;
  /** The hash the path is stored under (`parsed`, `linked`). */
  readonly hash?: string;
  /** Why the path failed (`failed`). */
  readonly code?: string;
}

/** Run `fn` as one Governor job, waiting out `busy` answers for as long as the Indexer is running. */
export async function runJob<T>(ctx: ProcessContext, spec: JobSpec, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const outcome = await ctx.governor.run(
      { tenant: ctx.tenant, class: spec.cls, cost: 1, ...(spec.requestId === undefined ? {} : { requestId: spec.requestId }) },
      () => fn(),
    );
    if (outcome.kind === 'ok') return outcome.value;
    if (outcome.kind === 'timeout') throw new Error('an indexer job timed out in the governor');
    if (ctx.isStopped()) throw new IndexerError('stopped', 'the indexer was stopped');
    await ctx.sleep(outcome.retry_after);
  }
}

/** Run the tasks with at most `limit` in flight, starting them in list order. */
async function runLimited(tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const mine = next;
      next += 1;
      const task = tasks[mine];
      if (task === undefined) return;
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const codeOf = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'internal_error';
};

const failed = (path: string, code: string): PathResult => ({ path, outcome: 'failed', code });

/** True when the overlay holds facts for `path`. */
async function isIndexed(store: FactStore, worktree: string, path: string): Promise<boolean> {
  try {
    return (await store.at(worktree).fileFacts(path)).data !== null;
  } catch (error) {
    if (error instanceof UnknownWorktree) return false;
    throw error;
  }
}

/** Remove `path` from the overlay. With `onlyIfIndexed` a path the overlay never held costs no write at all. */
async function removePath(
  ctx: ProcessContext,
  writer: Writer,
  worktree: string,
  path: string,
  onlyIfIndexed: boolean,
): Promise<PathResult> {
  if (onlyIfIndexed && !(await isIndexed(ctx.store, worktree, path))) return { path, outcome: 'skipped' };
  const commit = await writer.commitFile({ worktree, path, hash: '', facts: null });
  return { path, outcome: commit.status === 'committed' ? 'removed' : 'skipped' };
}

/** Index one file whose hash git computed: attach known facts, or read, parse and commit. */
async function indexPath(ctx: ProcessContext, writer: Writer, worktree: string, path: string, hash: string): Promise<PathResult> {
  const attached = await writer.link(worktree, path, hash);
  if (attached.status !== 'rejected') return { path, outcome: 'linked', hash };

  const read = await ctx.tree.readText(worktree, path, { maxBytes: ctx.config.maxFileBytes });
  if (read.kind === 'too_large') return failed(path, SOURCE_TREE_CODES.sourceTooLarge);
  if (read.kind !== 'ok') return removePath(ctx, writer, worktree, path, false);

  const extracted = await ctx.host.extract(path, read.text, hash);
  if (extracted.kind === 'unclaimed') return removePath(ctx, writer, worktree, path, true);
  if (extracted.kind === 'failed') return failed(path, extracted.code);

  const commit = await writer.commitFile({ worktree, path, hash, facts: extracted.facts });
  if (commit.status === 'rejected') return failed(path, commit.diagnostics[0]?.code ?? 'commit_rejected');
  return { path, outcome: 'parsed', hash };
}

interface Prepared {
  /** Path to the blob id git computed, for files that are source. Sorted by path. */
  readonly survivors: ReadonlyMap<string, string>;
  /** Requested paths that are gone, or no longer source, and so must leave the overlay. */
  readonly gone: readonly string[];
  /** Requested paths no loaded module claims; they leave the overlay only if it holds them. */
  readonly unclaimed: readonly string[];
  /** Source files over the byte cap: not parsed, previous facts kept. */
  readonly oversize: readonly string[];
}

async function prepare(ctx: ProcessContext, worktree: string, sorted: readonly string[]): Promise<Prepared> {
  const extensions = ctx.host.extensions();
  const claimed = new Set(extensions);
  const candidates = sorted.filter((p) => claimed.has(extensionOf(p)));
  const unclaimed = sorted.filter((p) => !claimed.has(extensionOf(p)));

  const hashed = candidates.length === 0 ? undefined : await ctx.tree.hashPaths(worktree, candidates);
  const files = hashed?.files ?? new Map<string, string>();
  const set =
    files.size === 0 ? undefined : await ctx.tree.sourceSet(worktree, files, { extensions, maxBytes: ctx.config.maxFileBytes });
  const survivors = set?.files ?? new Map<string, string>();

  const tooLarge = new Set(
    (set?.skipped ?? []).filter((d) => d.code === SOURCE_TREE_CODES.sourceTooLarge && d.subject !== undefined).map((d) => d.subject as string),
  );
  const oversize = candidates.filter((p) => tooLarge.has(p));
  const gone = candidates.filter((p) => !survivors.has(p) && !tooLarge.has(p));
  return { survivors, gone, unclaimed, oversize };
}

export interface BatchOptions {
  readonly job: JobSpec;
}

/**
 * Process `paths` of `worktree` (the worktree root; also the Fact Store's worktree id). Returns one result per
 * distinct path, sorted by path in code-unit order. Rejects only with `IndexerError('stopped')` or when the
 * Writer itself is unusable; everything about a single file is a result.
 */
export async function processBatch(
  ctx: ProcessContext,
  writer: Writer,
  worktree: string,
  paths: readonly string[],
  options: BatchOptions,
): Promise<PathResult[]> {
  const sorted = [...new Set(paths)].sort(compareCodeUnits);
  if (sorted.length === 0) return [];
  const results = new Map<string, PathResult>();

  let prepared: Prepared;
  try {
    prepared = await runJob(ctx, options.job, () => prepare(ctx, worktree, sorted));
  } catch (error) {
    if (error instanceof IndexerError) throw error;
    const code = codeOf(error);
    return sorted.map((path) => failed(path, code));
  }

  for (const path of prepared.oversize) results.set(path, failed(path, SOURCE_TREE_CODES.sourceTooLarge));

  // Units of work: files that share a hash form one unit, so the first is parsed and the rest are linked to its
  // facts after it commits. Units start in order of their first path, so the order never depends on arrival order.
  const units: Array<{ readonly first: string; readonly run: () => Promise<void> }> = [];
  const guarded = async (path: string, work: () => Promise<PathResult>): Promise<void> => {
    try {
      results.set(path, await runJob(ctx, options.job, work));
    } catch (error) {
      if (error instanceof IndexerError) throw error;
      results.set(path, failed(path, codeOf(error)));
    }
  };

  const byHash = new Map<string, string[]>();
  for (const [path, hash] of prepared.survivors) {
    const same = byHash.get(hash);
    if (same === undefined) byHash.set(hash, [path]);
    else same.push(path);
  }
  for (const [hash, same] of byHash) {
    units.push({
      first: same[0] as string,
      run: async () => {
        for (const path of same) await guarded(path, () => indexPath(ctx, writer, worktree, path, hash));
      },
    });
  }
  for (const path of prepared.gone) units.push({ first: path, run: () => guarded(path, () => removePath(ctx, writer, worktree, path, false)) });
  for (const path of prepared.unclaimed) units.push({ first: path, run: () => guarded(path, () => removePath(ctx, writer, worktree, path, true)) });
  units.sort((a, b) => compareCodeUnits(a.first, b.first));

  await runLimited(
    units.map((unit) => unit.run),
    IN_FLIGHT_PATHS,
  );
  return sorted.map((path) => results.get(path) ?? failed(path, 'internal_error'));
}
