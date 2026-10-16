/**
 * The command-line adapter. It parses argv, sends one Request through the HostClient and prints
 * the Envelope; it imports nothing but the host-client seam (adapter rule). The composition root
 * (src/bin/gsd-atlas.ts) decides which HostClient it talks to.
 *
 * Output contract: stdout carries exactly one JSON envelope per request (nothing else), stderr
 * carries the human reasons, one line per error or warning diagnostic.
 * Exit codes: 0 ok; 1 usage error or a target that is not an existing module folder; 2 any other failure.
 */
import { parseArgs } from 'node:util';

import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Envelope, HostClient } from '../host-client/index.ts';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILURE = 2;

export interface CliIo {
  readonly client: HostClient;
  /** Read lazily, so `--help` and usage errors never touch package.json. */
  readonly version: () => string;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

const USAGE = ['Usage: gsd-atlas [--version | -v] [--help | -h]', '       gsd-atlas lang test <module-folder>', ''].join('\n');

function usageError(io: CliIo, message: string): number {
  io.stderr.write(`gsd-atlas: ${message}\n${USAGE}`);
  return EXIT_USAGE;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeFor(envelope: Envelope): number {
  if (envelope.diagnostics.some((d) => d.code === 'module_not_found')) {
    return EXIT_USAGE;
  }
  return envelope.ok ? EXIT_OK : EXIT_FAILURE;
}

async function langTest(io: CliIo, target: string): Promise<number> {
  let envelope: Envelope;
  try {
    envelope = await io.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_test', args: { target } });
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${reasonOf(error)}\n`);
    return EXIT_FAILURE;
  }
  io.stdout.write(`${JSON.stringify(envelope)}\n`);
  for (const d of envelope.diagnostics) {
    if (d.severity === 'error' || d.severity === 'warning') {
      io.stderr.write(`gsd-atlas: ${d.severity} ${d.code}: ${d.message}\n`);
    }
  }
  return exitCodeFor(envelope);
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return usageError(io, reasonOf(error));
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    io.stdout.write(`gsd-atlas ${io.version()}\n`);
    return EXIT_OK;
  }
  if (values.help === true) {
    io.stdout.write(USAGE);
    return EXIT_OK;
  }

  const [group, action, target, ...extra] = positionals;
  if (group === undefined) {
    return usageError(io, 'a command is required');
  }
  if (group !== 'lang' || action !== 'test') {
    return usageError(io, 'unknown command');
  }
  if (target === undefined) {
    return usageError(io, 'lang test needs a module folder');
  }
  if (extra.length > 0) {
    return usageError(io, 'lang test takes exactly one module folder');
  }
  return langTest(io, target);
}
