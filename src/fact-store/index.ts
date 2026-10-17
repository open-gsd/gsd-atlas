/**
 * The Fact Store seam: the frozen interface, its types and errors, and the one constructor, `openFactStore`
 * (fact-store-interface ADR decision 8). There is no fake here: tests run the real store on a temp directory
 * through this interface only. The conformance suite (`contract.ts`) is test code and is not exported.
 */
export { SchemaTooNew, StoreClosed, UnknownWorktree, WriterBusy } from './errors.ts';
export { defaultCacheRoot, isSyncedFolderPath, resolveStoreLocation } from './location.ts';
export type { CacheReason, ResolveStoreLocationInput, StoreLocation, StoreLocationKind } from './location.ts';
export { openFactStore } from './open.ts';
export type { OpenFactStoreOptions, StoreOpenOptions } from './open.ts';
export { candidatePaths, resolveSpecifier } from './specifier.ts';
export type {
  CallerRecord,
  CallersOptions,
  CheckResult,
  CommitFileInput,
  CommitResult,
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
  ResolveOptions,
  Resolver,
  StoreDeps,
  StoreOptions,
  StoreStatus,
  SymbolRecord,
  Tier,
  WorktreeId,
  WorktreeStatus,
  Writer,
} from './types.ts';
