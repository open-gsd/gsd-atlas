import type { Envelope, Request } from '../facts/index.ts';

export type { Request, Envelope, Diagnostic } from '../facts/index.ts';
export { PROTOCOL_VERSION } from '../facts/index.ts';

/**
 * The adapter-facing seam: CLI and MCP shim talk to the host only through this interface, so
 * adapters never import src/facts directly. `createInProcessHostClient` serves requests in the calling
 * process through the Host; the composition root (src/bin) is the only place that builds one.
 */
export interface HostClient {
  handle(request: Request): Promise<Envelope>;
}

export { createInProcessHostClient } from './in-process.ts';
export type { InProcessHostClientOptions } from './in-process.ts';
export { INDEX_STATE_SCHEMA, LANG_LIST_SCHEMA, LANG_TEST_SCHEMA } from '../host/index.ts';
export type { IndexStateData, LangListData } from '../host/index.ts';
// One definition of the tools and of the error schema, shared with Query, so the CLI and the MCP server read the
// same tool list and build the same requests (QRY-04 parity is structural).
export { ERROR_SCHEMA, TOOLS, TOOL_NAMES, buildRequest } from '../query/index.ts';
export type { ToolDefinition, ToolName } from '../query/index.ts';
export type { ModuleEntry, ModuleSource, Roots, ShadowedCopy, TierStatus } from '../lang/index.ts';
