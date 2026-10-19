/**
 * User-controlled diagnostics (SKL-03; docs/DIAGNOSTICS.md; docs/adr/15-user-controlled-diagnostics.md): the shipped
 * catalog of data types, per-type versioned consent, collectors, and a deterministic local report. It starts no
 * process, opens no database and touches no network: the Host assembles the data sources and calls it, and an adapter
 * only sends requests to the Host. Submission of a report is not part of this module.
 */
export { CATALOG_FILE, CATALOG_VERSION, CatalogSchema, defaultCatalogDir, loadCatalog, parseCatalog, valueFits } from './catalog.ts';
export type { Catalog, CatalogField, CatalogType, FieldKind, ParsedCatalog } from './catalog.ts';
export { AGENT_CONCURRENCY_EDGES, REPO_COUNT_EDGES, WORKTREE_COUNT_EDGES, bucketBytes, bucketCount, bucketLines, bucketMs } from './bucket.ts';
export { BUDGETS, collectType, ratingSymbol } from './collect.ts';
export type { ActivityFacts, DiagnosticsSources, IndexFacts, ModuleFacts, PlatformFacts, RatingFact, TypeValues } from './collect.ts';
export { CONSENT_FILE, CONSENT_MAX_BYTES, CONSENT_STATES, emptyConsent, loadConsent, reapprovalNeeded, saveConsent } from './consent.ts';
export type { Consent, ConsentEntry, ConsentState, LoadedConsent, SaveResult } from './consent.ts';
export type { DiagnosticsFs } from './io.ts';
export { renderReport } from './preview.ts';
export { REPORTS_MAX, STATE_FOLDER, formatSavedReport, listReports, removeState, reportsDir, saveReport } from './reports.ts';
export type { RemovedState, ReportEntry, SaveReportResult, SavedReport } from './reports.ts';
export type { RenderInput, Report } from './preview.ts';
export { NOTE_CUT_MARKER, NOTE_MAX_CHARS, REMOVED, scrubNote } from './scrub.ts';
export { BUG_DEFAULTS, BUG_TYPES, BUG_TYPE_INFO, BUNDLE_FORMAT, RAW_BANNER, buildBundle, renderPreview } from './bundle.ts';
export type {
  BugInput,
  BugType,
  BugTypeInfo,
  BuiltBundle,
  ConfigFacts,
  FactSummary,
  FailingData,
  HealthData,
  ModuleVersion,
  PreviewInput,
  ProblemInput,
  RecorderData,
  RecorderEvent,
  TypeScriptVersion,
  VersionsData,
} from './bundle.ts';
export { HASH_TOKEN_PATTERN, createHasher } from './hash.ts';
export type { Hasher, RandomSource } from './hash.ts';
export { LEAF_KINDS, MODES, SanitizeError, leaf, sanitize } from './sanitize.ts';
export type { Json, Leaf, LeafKind, Mode, Tree } from './sanitize.ts';
