#!/usr/bin/env node
/**
 * The `gsd-atlas` command: it builds the Host through the shared composition root (`compose.ts`, the one place that
 * knows the working directory, the home directory and the environment) and hands the in-process HostClient to the
 * CLI adapter. The Host is closed, and the Grammar Engine's workers with it, when the command ends.
 */
import process from 'node:process';

import { runCli } from '../cli/index.ts';
import { composeHost, readVersion } from './compose.ts';

const composed = composeHost({ cwd: process.cwd(), env: process.env, stderr: process.stderr });
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    client: composed.client,
    version: readVersion,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`gsd-atlas: error internal_error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await composed.dispose();
}
