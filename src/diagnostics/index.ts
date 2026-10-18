/**
 * User-controlled diagnostics (SKL-03; docs/DIAGNOSTICS.md; the draft user-controlled-diagnostics ADR): the shipped
 * catalog of data types, per-type versioned consent, collectors, and a deterministic local report. It starts no
 * process, opens no database and touches no network: the Host assembles the data sources and calls it, and an adapter
 * only sends requests to the Host. Submission of a report is not part of this module.
 */
export { CATALOG_FILE, CATALOG_VERSION, CatalogSchema, defaultCatalogDir, loadCatalog, parseCatalog, valueFits } from './catalog.ts';
export type { Catalog, CatalogField, CatalogType, FieldKind, ParsedCatalog } from './catalog.ts';
export { collectType } from './collect.ts';
export type { DiagnosticsSources, TypeValues } from './collect.ts';
export { CONSENT_FILE, CONSENT_MAX_BYTES, CONSENT_STATES, emptyConsent, loadConsent, reapprovalNeeded, saveConsent } from './consent.ts';
export type { Consent, ConsentEntry, ConsentState, LoadedConsent, SaveResult } from './consent.ts';
export type { DiagnosticsFs } from './io.ts';
export { renderReport } from './preview.ts';
export type { RenderInput, Report } from './preview.ts';
