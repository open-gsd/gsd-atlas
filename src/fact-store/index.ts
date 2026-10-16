/**
 * The Fact Store seam. Interface, types and errors only: no implementation and no fake (fact-store-interface
 * ADR decision 8). `OpenStore` is a type; no value in this module opens a store until Phase 2.
 */
export { SchemaTooNew, StoreClosed, UnknownWorktree, WriterBusy } from './errors.ts';
export type {
  CallerRecord,
  CallersOptions,
  CheckResult,
  CommitFileInput,
  CommitResult,
  FactStore,
  FindMode,
  FindOptions,
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
  StoreStatus,
  SymbolRecord,
  Tier,
  WorktreeId,
  WorktreeStatus,
  Writer,
} from './types.ts';
