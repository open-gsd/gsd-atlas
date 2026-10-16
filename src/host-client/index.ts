import type { Envelope, Request } from '../facts/index.ts';

export type { Request, Envelope, Diagnostic } from '../facts/index.ts';
export { PROTOCOL_VERSION } from '../facts/index.ts';

/**
 * The adapter-facing seam: CLI and MCP shim talk to the host only through this interface, so
 * adapters never import src/facts directly. `createInProcessHostClient` is the Phase 1
 * implementation; the composition root (src/bin) is the only place that builds one.
 */
export interface HostClient {
  handle(request: Request): Promise<Envelope>;
}

export { ERROR_SCHEMA, LANG_LIST_SCHEMA, LANG_TEST_SCHEMA, createInProcessHostClient } from './in-process.ts';
export type { InProcessHostClientOptions, LangListData } from './in-process.ts';
export type { ModuleEntry, ModuleSource, Roots, ShadowedCopy, TierStatus } from '../lang/index.ts';
