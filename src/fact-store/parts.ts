/**
 * Internal wiring shared by the store, writer and reader. Not exported from index.ts.
 */
import type { DegradedCode, ResolutionContext } from '../facts/index.ts';
import type { Db } from '../sqlite/index.ts';
import { StoreClosed } from './errors.ts';
import type { StoreDeps } from './types.ts';

/** Mutable state of one open store. */
export interface StoreState {
  closed: boolean;
  /** True while a writer from `store.writer()` has not been released. */
  writerTaken: boolean;
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
  readonly resolutionContext: () => ResolutionContext;
  readonly state: StoreState;
  /** Degraded codes that hold for the whole process right now; plan 02-12 reports `follower` and `rebuilding` here. */
  readonly degradedNow: () => readonly DegradedCode[];
}

export function assertOpen(parts: StoreParts): void {
  if (parts.state.closed) throw new StoreClosed();
}

/** The extractor string carried in provenance, for example `grammar:typescript@0.23.2`. */
export function extractorOf(module: string, grammarVersion: string): string {
  return `grammar:${module}@${grammarVersion}`;
}
