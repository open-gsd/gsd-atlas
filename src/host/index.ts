/**
 * The Host seam (tenant-composition ADR decision 5): the composition root for a process. It routes a request to
 * the tenant of its repository, schedules it through the Governor and returns an Envelope. Adapters reach it only
 * through the HostClient.
 */
export { loadUserConfig } from './config.ts';
export type { LoadedUserConfig } from './config.ts';
export { createHost } from './host.ts';
export { HISTORY_KIND, HISTORY_MAX_FILES, HISTORY_SCHEMA, HISTORY_TOOLS } from './history.ts';
export type { HistoryArgs } from './history.ts';
export { LANG_LIST_SCHEMA, LANG_TEST_SCHEMA } from './lang.ts';
export type { LangListData } from './lang.ts';
export type { Host, HostOptions, UserConfig } from './types.ts';
