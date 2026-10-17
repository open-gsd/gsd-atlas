#!/usr/bin/env node
/**
 * The `gsd-atlas-mcp` command: a stateless MCP server on stdio (HST-01). The first import is the MCP shim, whose own
 * first import is the stdout guard, so the guard runs before any other module code (research Pitfall 8). The Host is
 * composed on the first tool call, not at start, so `initialize` and `tools/list` are answered before any tenant,
 * store, watcher or grammar exists; it is closed, with its workers, when input ends or on the first SIGTERM or SIGINT
 * (exit 143 or 130; a second signal exits at once), so a client that terminates the server by signal leaves no dirty
 * sentinel, no held lease and no uncheckpointed WAL behind (IN-07).
 */
import { protocolStdout, runMcpShim } from '../mcp-shim/index.ts';

import process from 'node:process';

import type { HostClient } from '../host-client/index.ts';
import { composeHost, readVersion } from './compose.ts';
import type { Composed } from './compose.ts';
import { installShutdownHandlers } from './shutdown.ts';

const cwd = process.cwd();
let composed: Composed | undefined;

/** Composes the Host on the first call; a failure to compose is retried on the next call and reported to this one. */
const client: HostClient = {
  async handle(request) {
    composed ??= composeHost({ cwd, env: process.env, stderr: process.stderr });
    return composed.client.handle(request);
  },
};

installShutdownHandlers({
  process,
  dispose: () => composed?.dispose() ?? Promise.resolve(),
  exit: (code) => process.exit(code),
});

try {
  process.exitCode = await runMcpShim({
    client,
    version: readVersion(),
    stdin: process.stdin,
    stdout: protocolStdout,
    stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`gsd-atlas-mcp: error internal_error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await composed?.dispose();
}
