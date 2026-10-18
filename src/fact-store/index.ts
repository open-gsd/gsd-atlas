/**
 * The Fact Store seam: the frozen interface, its types and errors, and the one constructor, `openFactStore`
 * (fact-store-interface ADR decision 8). There is no fake here: tests run the real store on a temp directory
 * through this interface only. The conformance suite (`contract.ts`) is test code and is not exported.
 */
export { SchemaTooNew, StoreClosed, UnknownWorktree, WriterBusy } from './errors.ts';
export { decideStoreLocation, defaultCacheRoot, findExistingStore, isSyncedFolderPath, resolveStoreLocation } from './location.ts';
export type { CacheReason, ResolveStoreLocationInput, StoreLocation, StoreLocationKind } from './location.ts';
export { IDLE_MAINTENANCE } from './maintain.ts';
export { openFactStore } from './open.ts';
export type { OpenFactStoreOptions, StoreOpenOptions } from './open.ts';
export { probeStore } from './probe.ts';
export type { ProbeOptions, StoreProbe } from './probe.ts';
export { MAX_HANDLE_CHARS, formatHandle, parseHandle } from './provenance.ts';
export type { Handle, HandleKind } from './provenance.ts';
export { candidatePaths, resolveSpecifier } from './specifier.ts';
export type {
  CacheState,
  CallerRecord,
  CallersOptions,
  CheckResult,
  CitationRecord,
  CitationsOptions,
  CitationsQuery,
  CommitFileInput,
  CommitResult,
  FactExplanation,
  FactKind,
  FactStore,
  FindMode,
  FindOptions,
  ImporterRecord,
  ImportersOptions,
  MaintenanceOptions,
  MaintenanceResult,
  OpenStore,
  Provenance,
  Reader,
  ReconcileResult,
  ReconcileTruth,
  RefRecord,
  RelationDirection,
  RelationRecord,
  RelationsOptions,
  ResolveBatchOptions,
  ResolveOptions,
  ResolveResult,
  Resolver,
  StoreDeps,
  StoreMaintainOptions,
  StoreOptions,
  StoreStatus,
  SymbolRecord,
  Tier,
  WorktreeId,
  WorktreeStatus,
  Writer,
} from './types.ts';
