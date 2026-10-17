#!/usr/bin/env node
/**
 * The `gsd-atlas` command: it wires the real process into `runCliMain` (`cli-main.ts`): the shared composition root
 * (`compose.ts`, the one place that knows the working directory, the home directory and the environment) builds the
 * Host on the first request, and the in-process HostClient goes to the CLI adapter together with the real environment
 * `init` and the relative `--repo` and `--cwd` flags need. The Host is closed, and the Grammar Engine's workers with
 * it, when the command ends or on the first SIGTERM or SIGINT (`shutdown.ts`).
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../cli/index.ts';
import { runCliMain } from './cli-main.ts';
import { composeHost, readVersion } from './compose.ts';
import { installShutdownHandlers } from './shutdown.ts';

const cwd = process.cwd();

/**
 * The MCP server entry registered by `gsd-atlas init`: the `gsd-atlas-mcp` file that sits beside this one, with the
 * extension of this file (`.ts` when run from source, `.js` from the published package), as an absolute path.
 */
const binFile = fileURLToPath(import.meta.url);
const mcpEntry = path.join(path.dirname(binFile), `gsd-atlas-mcp${path.extname(binFile)}`);

process.exitCode = await runCliMain({
  argv: process.argv.slice(2),
  compose: () => composeHost({ cwd, env: process.env, stderr: process.stderr }),
  runCli,
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
  installShutdown: (dispose) => {
    installShutdownHandlers({ process, dispose, exit: (code) => process.exit(code) });
  },
});
