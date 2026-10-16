#!/usr/bin/env node
/**
 * Composition root of the `gsd-atlas` command: the one place that builds the Grammar Engine and
 * the in-process HostClient and hands them to the CLI adapter. It is also the one place that knows
 * the working directory and the home directory, so the default module search roots are built here
 * and passed down as plain absolute paths (D-03).
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../cli/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createInProcessHostClient } from '../host-client/index.ts';
import type { Roots } from '../host-client/index.ts';

/** The package root: two levels up from src/bin (dev) or dist/bin (published). */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readVersion(): string {
  const raw = readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  throw new Error('gsd-atlas: package.json has no version');
}

/**
 * Repo root and npm root are the working directory; the user dir is `GSD_ATLAS_USER_DIR` or
 * `~/.config/gsd-atlas`; the built-in dir is `<package root>/modules` when it exists (none ships in Phase 1).
 */
function defaultRoots(): Roots {
  const cwd = process.cwd();
  const fromEnv = process.env['GSD_ATLAS_USER_DIR'];
  const builtin = path.join(PACKAGE_ROOT, 'modules');
  return {
    repoRoot: cwd,
    userDir: fromEnv !== undefined && fromEnv !== '' ? path.resolve(fromEnv) : path.join(os.homedir(), '.config', 'gsd-atlas'),
    builtinDir: existsSync(builtin) ? builtin : null,
    npmRoots: [cwd],
  };
}

const engine = createGrammarEngine();
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    client: createInProcessHostClient({ roots: defaultRoots(), engine }),
    version: readVersion,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`gsd-atlas: error internal_error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await engine.dispose();
}
