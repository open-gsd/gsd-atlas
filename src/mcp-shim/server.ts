import { McpServer } from '@modelcontextprotocol/server';

import type { HostClient } from '../host-client/index.ts';

export interface McpShimOptions {
  readonly version: string;
  readonly instructions?: string;
  readonly onError?: (error: unknown) => void;
}

/** Skeleton for the RED commit: a server with no tools registered. */
export function buildMcpServer(_client: HostClient, options: McpShimOptions): McpServer {
  return new McpServer({ name: 'gsd-atlas', version: options.version }, { capabilities: { tools: {} } });
}
