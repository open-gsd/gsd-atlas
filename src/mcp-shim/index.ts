/**
 * The stdio MCP server's runner (HST-01). The stdout guard is this module's first import, so it is the first code
 * any bin that imports this module evaluates (research Pitfall 8).
 */
import { protocolStdout } from './stdout-guard.ts';

import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';

import type { HostClient } from '../host-client/index.ts';
import { buildMcpServer } from './server.ts';

export { protocolStdout };
export { buildMcpServer, FAILURE_TEXT, SERVER_INSTRUCTIONS } from './server.ts';
export type { McpShimOptions } from './server.ts';

export interface McpShimIo {
  readonly client: HostClient;
  readonly version: string;
  readonly stdin: Readable;
  /** Where protocol frames go: {@link protocolStdout} in the bin, a pipe in tests. */
  readonly stdout: Writable;
  readonly stderr: { write(text: string): unknown };
}

/** The SDK's stdio transport, plus a promise that settles when it closes (stdin reached its end, or a write failed). */
class ObservedTransport extends StdioServerTransport {
  readonly closed: Promise<void>;
  private settle: () => void = () => {};

  constructor(stdin: Readable, stdout: Writable) {
    super(stdin, stdout);
    this.closed = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  override async close(): Promise<void> {
    await super.close();
    this.settle();
  }
}

const oneLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

/** Serve MCP over the given streams until input ends. Resolves with the exit code: 0 at end of input, 2 on a start-up failure. */
export async function runMcpShim(io: McpShimIo): Promise<number> {
  const transport = new ObservedTransport(io.stdin, io.stdout);
  const report = (error: unknown): void => {
    io.stderr.write(`gsd-atlas-mcp: warning host_error: ${oneLine(error)}\n`);
  };
  try {
    const handle = serveStdio(() => buildMcpServer(io.client, { version: io.version, onError: report }), {
      transport,
      onerror: (error) => {
        io.stderr.write(`gsd-atlas-mcp: warning protocol_error: ${oneLine(error)}\n`);
      },
    });
    await transport.closed;
    await handle.close();
    return 0;
  } catch (error) {
    io.stderr.write(`gsd-atlas-mcp: error internal_error: ${oneLine(error)}\n`);
    return 2;
  }
}
