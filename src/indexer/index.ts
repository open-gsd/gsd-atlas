/**
 * The Indexer seam (tenant-composition ADR decision 2): module hosting, per-batch hashing and filtering, parse and
 * extraction, writer commits and links, full builds and (from the queue plan task) the coalescing queue and
 * `ensureFresh`, all driven by an injected clock. Test code is not exported from here.
 */
export { DEFAULT_INDEXER_CONFIG } from './defaults.ts';
export { createManualEventSource } from './event-source.ts';
export type {
  EventSource,
  FsChange,
  GitHandler,
  GitSourceEvent,
  ManualEventSource,
  SourceEvent,
  SourceHandler,
  WatchMode,
  WatchProblem,
} from './event-source.ts';
export { gitDirNameOf, isInside } from './git-dir.ts';
export { createPathFilter } from './ignore.ts';
export type { PathFilter } from './ignore.ts';
export { createIndexer } from './indexer.ts';
export { createModuleHost } from './modules.ts';
export type { ExtractOutcome, ModuleHost, ModuleHostOptions } from './modules.ts';
export { createParcelEventSource } from './parcel-source.ts';
export type { ParcelEventSourceOptions } from './parcel-source.ts';
export { isRepoRelative, realRoot, staysInside } from './paths.ts';
export { createCoalescingQueue } from './queue.ts';
export type { CoalescingQueue, CoalescingQueueOptions } from './queue.ts';
export { IndexerError } from './types.ts';
export type {
  BuildResult,
  FailedPath,
  FreshResult,
  Indexer,
  IndexerConfig,
  IndexerDeps,
  IndexerErrorCode,
  IndexerNotice,
  IndexerStatus,
  LastReconcile,
  OutputFilter,
  ReconcileOutcome,
  RefreshOutcome,
  StartOptions,
  WatchProblemRecord,
} from './types.ts';
