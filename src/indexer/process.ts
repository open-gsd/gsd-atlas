/**
 * Batch processing: the heart of the Indexer. A batch is a worktree and a set of repo-relative paths; the
 * result is one `PathResult` per path, and the Fact Store holds the new facts, the attached facts or nothing
 * for the path, as the file on disk now says.
 *
 * The order of work for a batch:
 * 1. Paths whose extension no loaded module claims are set aside (no git, no read).
 * 2. Paths git would ignore are dropped (`PathFilter`), because `SourceTree.hashPaths` hashes what it is asked
 *    and does not consult ignore rules (T-02-14). A build passes snapshot paths, which git has already filtered.
 * 3. Each remaining path is `lstat`ed, then `SourceTree.hashPaths` hashes them all with ONE batched git run.
 * 4. `SourceTree.sourceSet` keeps the files that are source (LNG-05): not generated, vendored, binary, an LFS
 *    pointer or oversize.
 * 5. Each survivor is tried with `Writer.link` first (the store may already hold facts for its hash); only an
 *    unknown hash is read and parsed (STO-03's basis), then committed under the hash git computed.
 * 6. A path that disappeared, stopped being source or stopped being claimed is removed with a null commit.
 *
 * The hash and parse race (STO-02, T-02-50): the stamp (size, times, inode) taken before hashing must equal the
 * stamp taken just before the link and again right after the read. Any difference means the bytes that were
 * hashed may not be the bytes that were read, so nothing is committed for them: the path is hashed and read
 * again, up to `maxRaceRetries` more times, with a `requeued` notice each time; a file that never settles fails
 * with the code `unstable` and keeps its earlier facts. Two jobs for one path never run at once (`PathLocks`), so
 * an older hash cannot be committed after a newer one.
 *
 * Every unit of work runs through the Governor in the class the caller names. Nothing in a batch can stop the
 * queue: a failing file is a `failed` result with a code, and the next file is processed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { UnknownWorktree } from '../fact-store/index.ts';
import type { FactStore, Writer } from '../fact-store/index.ts';
import type { Governor, JobClass } from '../governor/index.ts';
import { SOURCE_TREE_CODES } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import type { PathFilter } from './ignore.ts';
import { extensionOf } from './modules.ts';
import type { ModuleHost } from './modules.ts';
import { IndexerError } from './types.ts';
import type { IndexerConfig, IndexerNotice, OutputFilter } from './types.ts';

/** How many independent files are handed to the Governor at once; the Governor's own queue bound does the rest. */
const IN_FLIGHT_PATHS = 8;

export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const keyOf = (worktree: string, rel: string): string => `${worktree}\0${rel}`;

/** Serialises work per key: the second `acquire` of a key waits until the first holder releases. */
export interface PathLocks {
  acquire(key: string): Promise<() => void>;
}

export function createPathLocks(): PathLocks {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(key) {
      const previous = tails.get(key) ?? Promise.resolve();
      let release: () => void = () => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(key, tail);
      await previous;
      return () => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      };
    },
  };
}

/** Paths in batches (`batched`) and paths whose job is running (`running`); the Indexer reports the difference as queued. */
export interface ProcessCounters {
  batched: number;
  running: number;
}

/** Everything batch processing needs from the Indexer that owns it. */
export interface ProcessContext {
  readonly tenant: string;
  readonly tree: SourceTree;
  readonly store: FactStore;
  readonly governor: Governor;
  readonly host: ModuleHost;
  /** Drops ignored paths before `hashPaths`, which would hash them (T-02-14). */
  readonly filter: PathFilter;
  /** Keeps the emit outputs of included sources out of the index (TSM-03, OQ3); absent: nothing is kept out. */
  readonly outputFilter?: OutputFilter;
  readonly locks: PathLocks;
  readonly counters: ProcessCounters;
  readonly config: IndexerConfig;
  notice(notice: IndexerNotice): void;
  /** The injected clock's time, for durations. */
  now(): number;
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

/** What one attempt at a path found; `raced` means the file changed under it and nothing was committed. */
type Attempt = PathResult | { readonly path: string; readonly outcome: 'raced' };

/**
 * True when the output filter says `rel` is the emit output of an included source. A filter that throws, or none at
 * all, says no: when the project cannot be described nothing is dropped from the index (fail open).
 */
function isEmitOutput(ctx: ProcessContext, worktree: string, rel: string): boolean {
  if (ctx.outputFilter === undefined) return false;
  try {
    return ctx.outputFilter.isOutput(worktree, rel);
  } catch {
    return false;
  }
}

/**
 * The paths of `paths` that are the emit output of an included source, asked once for a whole build or Reconcile run.
 * Fails open like {@link isEmitOutput}.
 */
export async function emitOutputsAmong(ctx: ProcessContext, worktree: string, paths: Iterable<string>): Promise<ReadonlySet<string>> {
  if (ctx.outputFilter === undefined) return new Set();
  try {
    return await ctx.outputFilter.exclude(worktree, paths);
  } catch {
    return new Set();
  }
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

const failed = (rel: string, code: string): PathResult => ({ path: rel, outcome: 'failed', code });
const raced = (rel: string): Attempt => ({ path: rel, outcome: 'raced' });

/** What `lstat` said about a file: enough to tell that its bytes may have changed. */
interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

async function stampOf(worktree: string, rel: string): Promise<Stamp | undefined> {
  try {
    const stat = await fs.promises.lstat(path.join(worktree, rel));
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
  } catch {
    return undefined;
  }
}

const sameStamp = (a: Stamp | undefined, b: Stamp | undefined): boolean =>
  a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

/** True when the overlay holds facts for `path`. */
async function isIndexed(store: FactStore, worktree: string, rel: string): Promise<boolean> {
  try {
    return (await store.at(worktree).fileFacts(rel)).data !== null;
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
  rel: string,
  onlyIfIndexed: boolean,
): Promise<PathResult> {
  if (onlyIfIndexed && !(await isIndexed(ctx.store, worktree, rel))) return { path: rel, outcome: 'skipped' };
  const commit = await writer.commitFile({ worktree, path: rel, hash: '', facts: null });
  return { path: rel, outcome: commit.status === 'committed' ? 'removed' : 'skipped' };
}

/** Index one file whose hash git computed: attach known facts, or read, parse and commit. */
async function indexPath(
  ctx: ProcessContext,
  writer: Writer,
  worktree: string,
  rel: string,
  hash: string,
  stamp: Stamp | undefined,
  force: boolean,
): Promise<Attempt> {
  // Inside the path lock: if the file changed since it was hashed, that hash may already be out of date.
  if (!sameStamp(stamp, await stampOf(worktree, rel))) return raced(rel);

  // A forced pass (refresh) skips the shortcut: the facts the store holds under this hash are exactly the ones
  // that are stale, and attaching them again would leave them so.
  if (!force) {
    const attached = await writer.link(worktree, rel, hash);
    if (attached.status !== 'rejected') return { path: rel, outcome: 'linked', hash };
  }

  const read = await ctx.tree.readText(worktree, rel, { maxBytes: ctx.config.maxFileBytes });
  if (read.kind === 'too_large') return failed(rel, SOURCE_TREE_CODES.sourceTooLarge);
  if (read.kind !== 'ok') return removePath(ctx, writer, worktree, rel, false);
  // STO-02: the stamp after the read must equal the stamp before the hash, or the text may not be what was hashed.
  if (!sameStamp(stamp, await stampOf(worktree, rel))) return raced(rel);

  const extracted = await ctx.host.extract(rel, read.text, hash);
  if (extracted.kind === 'unclaimed') return removePath(ctx, writer, worktree, rel, true);
  if (extracted.kind === 'failed') return failed(rel, extracted.code);

  const commit = await writer.commitFile({ worktree, path: rel, hash, facts: extracted.facts });
  if (commit.status === 'rejected') return failed(rel, commit.diagnostics[0]?.code ?? 'commit_rejected');
  return { path: rel, outcome: 'parsed', hash };
}

interface Prepared {
  /** Path to the blob id git computed, for files that are source. Sorted by path. */
  readonly survivors: ReadonlyMap<string, string>;
  /** What each survivor's file looked like just before it was hashed. */
  readonly stamps: ReadonlyMap<string, Stamp | undefined>;
  /** Requested paths that are gone, or no longer source, and so must leave the overlay. */
  readonly gone: readonly string[];
  /** Requested paths no loaded module claims, or git ignores; they leave the overlay only if it holds them. */
  readonly unclaimed: readonly string[];
  /** Source files over the byte cap: not parsed, previous facts kept. */
  readonly oversize: readonly string[];
}

async function prepare(ctx: ProcessContext, worktree: string, sorted: readonly string[]): Promise<Prepared> {
  const extensions = ctx.host.extensions();
  const claimed = new Set(extensions);
  // Unclaimed extensions are set aside first: they cost no git run and no ignore verdict. Then the emit outputs of an
  // included source (TSM-03, OQ3), which get no facts; they are handled like an unclaimed path, so one the overlay
  // still holds leaves it and one it never held costs nothing. Then git's ignore rules are applied, because hashPaths
  // would hash an ignored file that exists (T-02-14).
  const claimedPaths = sorted.filter((p) => claimed.has(extensionOf(p)));
  const outputs = new Set(claimedPaths.filter((p) => isEmitOutput(ctx, worktree, p)));
  const wanted = claimedPaths.filter((p) => !outputs.has(p));
  const { kept, dropped } = await ctx.filter.keep(worktree, wanted);
  const candidates = [...kept].sort(compareCodeUnits);
  const unclaimed = [...sorted.filter((p) => !claimed.has(extensionOf(p))), ...outputs, ...dropped].sort(compareCodeUnits);

  // The stamps come first: whatever happens to a file after this moment is what the race checks look for.
  const stamps = new Map<string, Stamp | undefined>(
    await Promise.all(candidates.map(async (rel): Promise<[string, Stamp | undefined]> => [rel, await stampOf(worktree, rel)])),
  );
  // The attribute query needs only the paths, not their hashes, so it starts now and runs beside the clean-filter
  // enumeration inside `hashPaths`: `config` and `check-attr` together, then `hash-object` (an edit is two spawn
  // stages instead of three, plan 02-46). The enumeration is still done on every `hashPaths` call and never cached
  // (T-01-50), and still precedes the hash. Errors surface in the old order: a `hashPaths` failure is reported at
  // once and the attribute query is abandoned (its rejection is handled below, so it can never be unhandled); an
  // attribute failure is reported only when something was hashed, as the `sourceSet` call it replaces would have.
  const attributes = candidates.length === 0 ? undefined : ctx.tree.pathAttributes(worktree, candidates);
  attributes?.catch(() => undefined);
  const hashed = candidates.length === 0 ? undefined : await ctx.tree.hashPaths(worktree, candidates);
  const files = hashed?.files ?? new Map<string, string>();
  const set =
    files.size === 0
      ? undefined
      : await ctx.tree.sourceSet(worktree, files, {
          extensions,
          maxBytes: ctx.config.maxFileBytes,
          ...(attributes === undefined ? {} : { attributes: await attributes }),
        });
  const survivors = set?.files ?? new Map<string, string>();

  const tooLarge = new Set(
    (set?.skipped ?? []).filter((d) => d.code === SOURCE_TREE_CODES.sourceTooLarge && d.subject !== undefined).map((d) => d.subject as string),
  );
  const oversize = candidates.filter((p) => tooLarge.has(p));
  const gone = candidates.filter((p) => !survivors.has(p) && !tooLarge.has(p));
  return { survivors, stamps, gone, unclaimed, oversize };
}

export interface BatchOptions {
  readonly job: JobSpec;
  /**
   * Read, parse and commit every path even when the store already holds facts under its hash (a grammar upgrade
   * marked them stale). Without it a known hash is attached with `Writer.link`, which keeps the stale facts.
   */
  readonly force?: boolean;
  /** Told as each path reaches its final result (not for an attempt that raced and will be retried). */
  readonly onResult?: (result: PathResult) => void;
}

/** One attempt over `sorted`: every path ends as a result, or `raced` when its file changed under it. */
async function attemptBatch(
  ctx: ProcessContext,
  writer: Writer,
  worktree: string,
  sorted: readonly string[],
  options: BatchOptions,
): Promise<Attempt[]> {
  const results = new Map<string, Attempt>();
  const settle = (rel: string, attempt: Attempt): void => {
    results.set(rel, attempt);
    if (attempt.outcome !== 'raced') options.onResult?.(attempt);
  };

  let prepared: Prepared;
  try {
    prepared = await runJob(ctx, options.job, () => prepare(ctx, worktree, sorted));
  } catch (error) {
    if (error instanceof IndexerError) throw error;
    const code = codeOf(error);
    return sorted.map((rel) => {
      const result = failed(rel, code);
      options.onResult?.(result);
      return result;
    });
  }

  for (const rel of prepared.oversize) settle(rel, failed(rel, SOURCE_TREE_CODES.sourceTooLarge));

  // Units of work: files that share a hash form one unit, so the first is parsed and the rest are linked to its
  // facts after it commits. Units start in order of their first path, so the order never depends on arrival order.
  const units: Array<{ readonly first: string; readonly run: () => Promise<void> }> = [];
  const guarded = async (rel: string, work: () => Promise<Attempt>): Promise<void> => {
    try {
      const attempt = await runJob(ctx, options.job, async () => {
        ctx.counters.running += 1;
        const release = await ctx.locks.acquire(keyOf(worktree, rel));
        try {
          return await work();
        } finally {
          release();
          ctx.counters.running -= 1;
        }
      });
      settle(rel, attempt);
    } catch (error) {
      if (error instanceof IndexerError) throw error;
      settle(rel, failed(rel, codeOf(error)));
    }
  };

  const byHash = new Map<string, string[]>();
  for (const [rel, hash] of prepared.survivors) {
    const same = byHash.get(hash);
    if (same === undefined) byHash.set(hash, [rel]);
    else same.push(rel);
  }
  for (const [hash, same] of byHash) {
    units.push({
      first: same[0] as string,
      run: async () => {
        // Forced: only the first path of a hash is extracted again; its commit refreshes the facts all of them share.
        for (const [at, rel] of same.entries()) {
          const force = options.force === true && at === 0;
          await guarded(rel, () => indexPath(ctx, writer, worktree, rel, hash, prepared.stamps.get(rel), force));
        }
      },
    });
  }
  for (const rel of prepared.gone) units.push({ first: rel, run: () => guarded(rel, () => removePath(ctx, writer, worktree, rel, false)) });
  for (const rel of prepared.unclaimed) units.push({ first: rel, run: () => guarded(rel, () => removePath(ctx, writer, worktree, rel, true)) });
  units.sort((a, b) => compareCodeUnits(a.first, b.first));

  await runLimited(
    units.map((unit) => unit.run),
    IN_FLIGHT_PATHS,
  );
  return sorted.map((rel) => results.get(rel) ?? failed(rel, 'internal_error'));
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
  ctx.counters.batched += sorted.length;
  try {
    const final = new Map<string, PathResult>();
    let remaining: readonly string[] = sorted;
    for (let retry = 0; remaining.length > 0; retry += 1) {
      const lost: string[] = [];
      for (const attempt of await attemptBatch(ctx, writer, worktree, remaining, options)) {
        if (attempt.outcome === 'raced') lost.push(attempt.path);
        else final.set(attempt.path, attempt);
      }
      if (retry >= ctx.config.maxRaceRetries) {
        for (const rel of lost) {
          const result = failed(rel, 'unstable');
          final.set(rel, result);
          options.onResult?.(result);
        }
        break;
      }
      for (const rel of lost) ctx.notice({ kind: 'requeued', worktree, path: rel });
      remaining = lost;
    }
    return sorted.map((rel) => final.get(rel) ?? failed(rel, 'internal_error'));
  } finally {
    ctx.counters.batched -= sorted.length;
  }
}
