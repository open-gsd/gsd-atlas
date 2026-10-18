/**
 * Internal wiring shared by the store, writer and reader. Not exported from index.ts.
 */
import { DEFAULT_PROJECT_CONTEXT } from '../facts/index.ts';
import type {
  DegradedCode,
  OverlaySnapshot,
  ProjectContext,
  ProjectContextProvider,
  ResolutionContext,
} from '../facts/index.ts';
import type { Db } from '../sqlite/index.ts';
import { StoreClosed } from './errors.ts';
import type { StoreDeps } from './types.ts';

/** Mutable state of one open store. */
export interface StoreState {
  closed: boolean;
  /** True while a writer from `store.writer()` has not been released. */
  writerTaken: boolean;
}

/** How the upkeep tasks (plan 02-18) behave, fixed when the store is opened. */
export interface LifecycleSettings {
  /** How long a retired file version is kept when git lacks its blob (D-16). */
  readonly graceMs: number;
  /** How many retired files `collect` deletes in one transaction. */
  readonly chunkSize: number;
  /** The longest single pause one incremental-vacuum slice may cause. */
  readonly sliceMs: number;
  /** Whether `names_fts` takes `DELETE ... WHERE rowid` (FTS5 `contentless_delete`); otherwise rows go by the `delete` command. */
  readonly contentlessDelete: boolean;
}

/**
 * What a read asks for: the project context of the overlay snapshot it is about to read. A store with no
 * provider answers synchronously (so its reads reach the resolver, and register their timeout, without yielding,
 * exactly as in Phase 2); a provider's answer is a promise.
 */
export type ProjectContextSource = (scope: {
  readonly worktree: string;
  readonly overlay: OverlaySnapshot;
}) => ProjectContext | Promise<ProjectContext>;

/** How many (worktree, snapshot id) contexts a store remembers; the most recently used win. */
const PROJECT_CONTEXT_MEMO_ENTRIES = 16;

function isProjectContext(value: unknown): value is ProjectContext {
  const context = (value as Partial<ProjectContext> | null | undefined)?.context;
  return (
    typeof context === 'object' &&
    context !== null &&
    typeof context.id === 'string' &&
    Array.isArray(context.configHashes) &&
    context.configHashes.every((hash) => typeof hash === 'string')
  );
}

/**
 * The source of project contexts for one open store.
 *
 * With a `provider`, its answer for a (worktree, snapshot id) is memoised (the promise, so concurrent reads share
 * one call) in a small bounded map; a provider that fails, throws on the call or answers something that is not a
 * project context is not remembered, and the read that asked sees a rejection. Without a provider the context is
 * the deprecated synchronous `resolutionContext` option, read on every call because it may change between calls
 * (it throws if the option does), or the grammar default. Callers handle the rejection and the throw: a read
 * degrades to the grammar answer, it never throws.
 */
export function createProjectContextSource(
  provider: ProjectContextProvider | undefined,
  legacy: (() => ResolutionContext) | undefined,
): ProjectContextSource {
  if (provider === undefined) {
    return () => (legacy === undefined ? DEFAULT_PROJECT_CONTEXT : { context: legacy() });
  }
  const memo = new Map<string, Promise<ProjectContext>>();
  return (scope) => {
    const key = `${scope.worktree}\u0000${scope.overlay.id}`;
    const known = memo.get(key);
    if (known !== undefined) {
      memo.delete(key); // refresh its place: the map keeps the least recently used entry first
      memo.set(key, known);
      return known;
    }
    let started: Promise<ProjectContext>;
    try {
      started = Promise.resolve(provider(scope)).then((value) => {
        if (!isProjectContext(value)) throw new TypeError('a project context provider must answer { context: { id, configHashes } }');
        return value;
      });
    } catch (error) {
      started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    memo.set(key, started);
    for (const oldest of memo.keys()) {
      if (memo.size <= PROJECT_CONTEXT_MEMO_ENTRIES) break;
      memo.delete(oldest);
    }
    started.catch(() => {
      if (memo.get(key) === started) memo.delete(key);
    });
    return started;
  };
}

/** Everything the writer, reader and store share. Built once by `openFactStore`. */
export interface StoreParts {
  /** The single writable connection; only the writer and maintenance use it. */
  readonly writeDb: Db;
  /** A read-only connection for readers: lock-free in WAL mode. */
  readonly readDb: Db;
  readonly deps: StoreDeps;
  /** The repo name used in symbol identities. */
  readonly repo: string;
  readonly canCache: () => boolean;
  /**
   * The project context of one overlay snapshot (resolution context plus what a resolver needs). Asynchronous;
   * memoised per (worktree, snapshot id) when a provider was given. Rejects when the provider fails.
   */
  readonly projectContext: ProjectContextSource;
  /** True when this session keeps `names_fts` in step with `names` and fuzzy find reads it (else the LIKE scan). */
  readonly fuzzyTrigram: boolean;
  readonly settings: LifecycleSettings;
  /** The overlay snapshot id last computed for each worktree, valid for the seq it was computed at. */
  readonly snapshotIds: Map<string, { readonly seq: number; readonly id: string }>;
  readonly state: StoreState;
  /** Degraded codes that hold for the whole process right now; plan 02-12 reports `follower` and `rebuilding` here. */
  readonly degradedNow: () => readonly DegradedCode[];
}

export function assertOpen(parts: StoreParts): void {
  if (parts.state.closed) throw new StoreClosed();
}

/**
 * Run `fn` inside one read transaction on the read connection, so every statement in it sees the same
 * committed state (a snapshot in WAL mode). `fn` must be synchronous: the connection is shared.
 */
export function readTransaction<T>(parts: StoreParts, fn: (db: Db) => T): T {
  const db = parts.readDb;
  db.exec('BEGIN');
  try {
    return fn(db);
  } finally {
    db.exec('COMMIT');
  }
}

/** The extractor string carried in provenance, for example `grammar:typescript@0.23.2`. */
export function extractorOf(module: string, grammarVersion: string): string {
  return `grammar:${module}@${grammarVersion}`;
}
