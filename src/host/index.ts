/**
 * The Host seam (tenant-composition ADR decision 5): the composition root for a process. It routes a request to
 * the tenant of its repository, schedules it through the Governor and returns an Envelope. Adapters reach it only
 * through the HostClient.
 */
export { ALLOW_KIND, ALLOW_SCHEMA, addAllowEntry, applyAllow, needsApprovalFrom, permissionsFor, previewAllow } from './allow.ts';
export type { AddResult, AllowDeps, AllowEntry, AllowInput, AllowPreview, AllowResult, AllowWritten } from './allow.ts';
export { loadUserConfig } from './config.ts';
export { DIAGNOSTICS_KIND, DIAGNOSTICS_SCHEMA } from './diagnostics.ts';
export { defaultStateDir, platformFactsOf } from './diagnostics.ts';
export type { DisableData, HistoryData, PreviewData, StatusData, TypeStatus, TypeView, TypesData } from './diagnostics.ts';
export type { LoadedUserConfig } from './config.ts';
export { INDEX_STATE_SCHEMA, createHost } from './host.ts';
export type { IndexStateData } from './host.ts';
export { HISTORY_KIND, HISTORY_MAX_FILES, HISTORY_SCHEMA, HISTORY_TOOLS } from './history.ts';
export type { HistoryArgs } from './history.ts';
export { LANG_LIST_SCHEMA, LANG_TEST_SCHEMA } from './lang.ts';
export { BUILTIN_TIERS, createTier, createTierMemory } from './tiers.ts';
export type { TierDeps, TierFactory } from './tiers.ts';
// The closed lists a rating may name (plan 03-17), for the CLI to check a flag with the Host's own lists.
export { RATE_SCHEMA, RATING_FEATURES, RATING_SCOPES, RATING_VALUES } from '../tenant/index.ts';
export type { LangListData } from './lang.ts';
export type { Host, HostOptions, HostOrigin, UserConfig } from './types.ts';
