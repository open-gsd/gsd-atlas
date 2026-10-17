/**
 * The production EventSource on @parcel/watcher (research Pattern 6: FSEvents on macOS, inotify on Linux,
 * ReadDirectoryChangesW on Windows, prebuilt as optional platform packages so no install script has to run).
 *
 * What the watcher does is treated as an accelerator, never as truth (IDX-03): the kind of event is dropped (a
 * modification arrives as a create, an atomic-rename save as a delete plus a create, so every event only means
 * "hash this path"), paths that leave the root or sit under `.git` or `node_modules` are dropped, and a watcher
 * error becomes a `problem` event that makes the Indexer Reconcile. If the watcher cannot be loaded or cannot
 * start (no prebuilt binary, no inotify watches left), `watchMode()` says `reconcile-only` and the Indexer keeps
 * its answers fresh through Reconcile alone.
 *
 * Two subscriptions exist: one per worktree root, and one on the common git directory. The git directory path is
 * given by the caller from Source Tree's identity; it is never read from a file of the repository (T-02-56).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EventSource, GitHandler, GitSourceEvent, SourceHandler, WatchMode } from './event-source.ts';

/** One event of the watcher. Only the path is used. */
export interface WatcherEvent {
  readonly path: string;
  readonly type: string;
}

export interface WatcherSubscription {
  unsubscribe(): Promise<void>;
}

export interface WatcherOptions {
  readonly ignore?: string[];
}

/** The part of @parcel/watcher the source uses, so a test can script it. */
export interface WatcherApi {
  subscribe(
    dir: string,
    fn: (error: Error | null, events: readonly WatcherEvent[]) => unknown,
    options?: WatcherOptions,
  ): Promise<WatcherSubscription>;
  writeSnapshot(dir: string, snapshot: string, options?: WatcherOptions): Promise<string>;
  getEventsSince(dir: string, snapshot: string, options?: WatcherOptions): Promise<readonly WatcherEvent[]>;
}

export interface ParcelEventSourceOptions {
  /** Loads the watcher. Default: the installed `@parcel/watcher`. */
  readonly watcher?: () => Promise<WatcherApi>;
  /**
   * Where start-up snapshots are kept (one file per worktree root). Absent: the start-up hint is off, which is
   * safe because Reconcile is authoritative.
   */
  readonly snapshotDir?: string;
}

/** Ignored by the watcher in a worktree: git's own files and installed packages. */
const FILE_IGNORE = ['.git', 'node_modules', '**/node_modules'];

/** Ignored by the watcher in the git directory: everything that is not HEAD or the worktree list. */
const GIT_IGNORE = ['objects', 'logs', '**/logs', 'hooks', 'info', '**/*.lock'];

async function loadInstalledWatcher(): Promise<WatcherApi> {
  const imported: unknown = await import('@parcel/watcher');
  const api = (imported as { readonly default?: unknown }).default ?? imported;
  return api as WatcherApi;
}

/** `rel` as a POSIX path when `abs` is under `root`, or null when it is `root` itself or outside it. */
function relativeUnder(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const isGitOrPackageDir = (segment: string): boolean => segment === '.git' || segment === 'node_modules';

/** The message of a watcher error that says events were lost, as opposed to a watcher that failed. */
const OVERFLOW = /overflow|dropped|lost|buffer/i;

export function createParcelEventSource(options: ParcelEventSourceOptions = {}): EventSource {
  let mode: WatchMode = 'native';
  let loaded: Promise<WatcherApi> | undefined;

  const load = (): Promise<WatcherApi> => {
    loaded ??= (options.watcher ?? loadInstalledWatcher)().catch((error: unknown) => {
      loaded = undefined;
      mode = 'reconcile-only';
      throw error;
    });
    return loaded;
  };

  const realOrSelf = (dir: string): string => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return dir;
    }
  };

  /** Paths relative to `dir`, measured against both the given and the real spelling of it. */
  const relativeTo = (dir: string): ((abs: string) => string | null) => {
    const real = realOrSelf(dir);
    return (abs) => relativeUnder(dir, abs) ?? relativeUnder(real, abs);
  };

  const problemOf = (error: Error): 'error' | 'overflow' => (OVERFLOW.test(error.message) ? 'overflow' : 'error');

  /** A handler that throws must not break the watcher's callback thread. */
  const guarded = <T>(handler: (event: T) => void, event: T): void => {
    try {
      handler(event);
    } catch {
      // ignored on purpose
    }
  };

  const snapshotFile = (root: string): string | undefined =>
    options.snapshotDir === undefined
      ? undefined
      : path.join(options.snapshotDir, `${createHash('sha256').update(root).digest('hex').slice(0, 24)}.snapshot`);

  return {
    watchMode: () => mode,

    async subscribe(worktreeRoot: string, handler: SourceHandler): Promise<() => Promise<void>> {
      const api = await load();
      const relative = relativeTo(worktreeRoot);
      let open = true;
      let subscription: WatcherSubscription;
      try {
        subscription = await api.subscribe(
          worktreeRoot,
          (error, events) => {
            if (!open) return;
            if (error !== null) {
              guarded(handler, { kind: 'problem', problem: problemOf(error) });
              return;
            }
            const seen = new Set<string>();
            for (const event of events) {
              const rel = relative(event.path);
              if (rel === null || rel.split('/').some(isGitOrPackageDir) || seen.has(rel)) continue;
              seen.add(rel);
              guarded(handler, { kind: 'change', path: rel });
            }
          },
          { ignore: FILE_IGNORE },
        );
      } catch (error) {
        mode = 'reconcile-only';
        throw error;
      }
      return async () => {
        open = false;
        await subscription.unsubscribe();
      };
    },

    async subscribeGit(commonDir: string, handler: GitHandler): Promise<() => Promise<void>> {
      if (!fs.statSync(commonDir, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error('the git directory to watch does not exist');
      }
      const api = await load();
      const relative = relativeTo(commonDir);
      let open = true;

      /**
       * A worktree appeared. The native watcher can miss the new directory (found by plan 02-26 on Linux CI): `git worktree
       * add` makes `worktrees/` and `worktrees/NAME/` back to back, and when a directory is created inotify watches it
       * without scanning what is already inside, so `worktrees/NAME/` is never watched and its HEAD changes never arrive.
       *
       * A subscription on `worktrees/` itself starts from a recursive scan of what exists, so it covers the directory the
       * first subscription missed. It is replaced on every worktrees event. The old one is dropped BEFORE the new one is
       * opened because @parcel/watcher shares one watcher per directory and ignore list: subscribing again while the old
       * subscription is alive would hand back the same watcher and its stale tree instead of scanning. The few milliseconds
       * without it can only lose a linked worktree's HEAD event, and the worktrees event that started the renewal is what
       * makes the Indexer Reconcile that worktree. A duplicate event is harmless, since every event only means "look again".
       * Renewals do not queue up: events that arrive during one cost a single further renewal.
       */
      const worktreesDir = path.join(commonDir, 'worktrees');
      let nested: WatcherSubscription | undefined;
      let renewing: Promise<void> | undefined;
      let renewAgain = false;
      const renewNested = async (): Promise<void> => {
        const previous = nested;
        nested = undefined;
        await previous?.unsubscribe();
        if (!open || !fs.statSync(worktreesDir, { throwIfNoEntry: false })?.isDirectory()) return;
        const next = await api.subscribe(worktreesDir, onEvents, { ignore: GIT_IGNORE });
        if (open) nested = next;
        else await next.unsubscribe();
      };
      const renew = (): void => {
        if (!open) return;
        if (renewing !== undefined) {
          renewAgain = true;
          return;
        }
        renewing = (async () => {
          do {
            renewAgain = false;
            try {
              await renewNested();
            } catch {
              // Say that the watch is in doubt so the Indexer reconciles.
              if (open) guarded(handler, { kind: 'problem', problem: 'error' });
            }
          } while (renewAgain && open);
        })().finally(() => {
          renewing = undefined;
        });
      };

      const onEvents = (error: Error | null, events: readonly WatcherEvent[]): void => {
        if (!open) return;
        if (error !== null) {
          guarded(handler, { kind: 'problem', problem: problemOf(error) });
          return;
        }
        const delivered = new Set<string>();
        for (const event of events) {
          const mapped = gitEventOf(relative(event.path));
          if (mapped === null) continue;
          const key = JSON.stringify(mapped);
          if (delivered.has(key)) continue;
          delivered.add(key);
          guarded(handler, mapped);
        }
        if (delivered.has(JSON.stringify({ kind: 'worktrees' }))) renew();
      };

      let subscription: WatcherSubscription;
      try {
        subscription = await api.subscribe(commonDir, onEvents, { ignore: GIT_IGNORE });
      } catch (error) {
        mode = 'reconcile-only';
        throw error;
      }
      return async () => {
        open = false;
        await renewing;
        await nested?.unsubscribe();
        await subscription.unsubscribe();
      };
    },

    async writeSnapshot(worktreeRoot: string): Promise<void> {
      const file = snapshotFile(worktreeRoot);
      if (file === undefined) return;
      const api = await load();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      await api.writeSnapshot(worktreeRoot, file, { ignore: FILE_IGNORE });
    },

    async eventsSince(worktreeRoot: string): Promise<readonly string[]> {
      const file = snapshotFile(worktreeRoot);
      if (file === undefined || !fs.existsSync(file)) return [];
      const api = await load();
      const relative = relativeTo(worktreeRoot);
      const paths = new Set<string>();
      for (const event of await api.getEventsSince(worktreeRoot, file, { ignore: FILE_IGNORE })) {
        const rel = relative(event.path);
        if (rel !== null && !rel.split('/').some(isGitOrPackageDir)) paths.add(rel);
      }
      return [...paths];
    },
  };
}

/**
 * What a path inside the common git directory means: a HEAD change of the main worktree (`HEAD`) or of a linked
 * one (`worktrees/NAME/HEAD`), a worktree added or removed (`worktrees`, `worktrees/NAME`, `worktrees/NAME/gitdir`),
 * or nothing at all.
 */
function gitEventOf(rel: string | null): GitSourceEvent | null {
  if (rel === null) return null;
  if (rel === 'HEAD') return { kind: 'head', gitDirName: '' };
  const linked = /^worktrees\/([^/]+)\/HEAD$/.exec(rel);
  if (linked?.[1] !== undefined) return { kind: 'head', gitDirName: linked[1] };
  if (rel === 'worktrees' || /^worktrees\/[^/]+(\/gitdir)?$/.test(rel)) return { kind: 'worktrees' };
  return null;
}
