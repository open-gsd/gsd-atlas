import type { Envelope, Request } from '../facts/index.ts';

export type { Request, Envelope, Diagnostic } from '../facts/index.ts';
export { PROTOCOL_VERSION } from '../facts/index.ts';

/**
 * The adapter-facing seam: CLI and MCP shim talk to the host only through this interface, so
 * adapters never import src/facts directly. The in-process implementation arrives in plan 01-14.
 */
export interface HostClient {
  handle(request: Request): Promise<Envelope>;
}
