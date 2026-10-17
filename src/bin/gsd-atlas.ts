#!/usr/bin/env node
/**
 * The `gsd-atlas` command: it builds the Host through the shared composition root (`compose.ts`, the one place that
 * knows the working directory, the home directory and the environment) and hands the in-process HostClient to the
 * CLI adapter, together with the real environment `init` and the relative `--repo` and `--cwd` flags need. The Host
 * is closed, and the Grammar Engine's workers with it, when the command ends.
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../cli/index.ts';
import { composeHost, readVersion } from './compose.ts';

const cwd = process.cwd();

/**
 * The MCP server entry registered by `gsd-atlas init`: the `gsd-atlas-mcp` file that sits beside this one, with the
 * extension of this file (`.ts` when run from source, `.js` from the published package), as an absolute path.
 */
const binFile = fileURLToPath(import.meta.url);
const mcpEntry = path.join(path.dirname(binFile), `gsd-atlas-mcp${path.extname(binFile)}`);

const composed = composeHost({ cwd, env: process.env, stderr: process.stderr });
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    client: composed.client,
    version: readVersion,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd,
    init: {
      home: os.homedir(),
      cwd,
      platform: process.platform,
      env: process.env,
      mcp: { command: process.execPath, args: [mcpEntry] },
    },
  });
} catch (error) {
  process.stderr.write(`gsd-atlas: error internal_error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await composed.dispose();
}
