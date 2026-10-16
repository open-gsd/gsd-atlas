import type { DriverName } from '../sqlite/index.ts';
import type { FactStore, StoreDeps, StoreOptions } from './types.ts';

/** The approved `sqlite.busyTimeoutMs` of 02-CONSTANTS.md: how long a writer waits on a locked database. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Options of `openFactStore`: the engine-independent `StoreOptions` plus the SQL driver choice. */
export interface OpenFactStoreOptions extends StoreOptions {
  /** Which SQLite driver to open. Default `node:sqlite`. */
  readonly driver?: DriverName;
}

/** Placeholder until the real store lands in the next commit of this task. */
export async function openFactStore(
  _dir: string,
  _deps: StoreDeps,
  _options: OpenFactStoreOptions = {},
): Promise<FactStore> {
  const empty = { data: [], watermark: { seq: 0, stalePaths: [] } };
  const reader = {
    find: async () => empty,
    refs: async () => empty,
    callers: async () => empty,
    symbol: async () => ({ data: null, watermark: { seq: 0, stalePaths: [] } }),
    fileFacts: async () => ({ data: null, watermark: { seq: 0, stalePaths: [] } }),
  };
  const done = { complete: true, spentMs: 0, processed: 0 };
  return {
    at: () => reader,
    writer: () => ({
      commitFile: async () => ({ status: 'rejected' as const, seq: 0, diagnostics: [] }),
      setOverlay: async () => undefined,
      dropOverlay: async () => undefined,
      markStale: async () => 0,
      release: () => undefined,
    }),
    reconcile: async () => ({ reindex: [], complete: true }),
    collect: async () => done,
    compact: async () => done,
    check: async () => ({ ok: true, problems: [] }),
    maintain: async () => done,
    status: async () => ({ schemaVersion: 0, worktrees: [], sizeBytes: 0, writerLeaseHeld: false }),
    close: async () => undefined,
  };
}
