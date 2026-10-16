#!/usr/bin/env node
/**
 * Composition root of the `gsd-atlas` command: the one place that builds the Grammar Engine and
 * the in-process HostClient and hands them to the CLI adapter.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { runCli } from '../cli/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createInProcessHostClient } from '../host-client/index.ts';

function readVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
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

const engine = createGrammarEngine();
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    client: createInProcessHostClient({ engine }),
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
