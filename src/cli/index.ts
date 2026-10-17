/**
 * The command-line adapter. It parses argv, sends one Request through the HostClient and prints
 * the Envelope; it imports nothing but the host-client seam (adapter rule). The composition root
 * (src/bin/gsd-atlas.ts) decides which HostClient it talks to.
 *
 * Output contract: stdout carries exactly one JSON envelope per request (nothing else, and the envelope is printed
 * as the Host returned it), stderr carries the human reasons, one line per error or warning diagnostic.
 * Exit codes (src/cli/exit.ts): 0 ok; 1 usage error, invalid arguments, or a target that is neither a module folder
 * nor a known module id; 2 any other failure; 3 the writer lease is held by another process or the host is busy.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, EXIT_LEASE_HELD, EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.ts';
import { INIT_SCHEMA, runInit } from './init.ts';
import type { InitEnvironment } from './init.ts';
import { AGENT_IDS } from './init-targets.ts';
import type { AgentId } from './init-targets.ts';
import { COMMANDS, FLAGS, inputFromFlags, requestFor, resolveCommand, unusedFlag } from './tool-commands.ts';
import type { FlagValues } from './tool-commands.ts';

export { INIT_SCHEMA };

export { EXIT_FAILURE, EXIT_LEASE_HELD, EXIT_OK, EXIT_USAGE, exitCodeFor };

export interface CliIo {
  readonly client: HostClient;
  /** Read lazily, so `--help` and usage errors never touch package.json. */
  readonly version: () => string;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  /** Home, working directory, platform, environment and MCP launch command for `init`; the bin supplies it. */
  readonly init?: InitEnvironment;
  /** The working directory relative `--repo` and `--cwd` values are resolved against. Default: this process's. */
  readonly cwd?: string;
}

const USAGE = [
  'Usage: gsd-atlas [--version | -v] [--help | -h]',
  ...COMMANDS.map((command) => `       ${command.usage}`),
  'Selection flags (every repository command): --repo <dir>  --cwd <dir>',
  'Paging flags (find, refs, context, impact): --budget <tokens>  --more <cursor>  --fresh <path> (repeatable)  --limit <n>',
  'Root flags (where modules are searched; each one replaces its default):',
  '       --repo-root <dir>  --user-dir <dir>  --builtin-dir <dir>  --npm-root <dir> (repeatable)',
  'Output: one JSON envelope on stdout; reasons on stderr. Exit codes: 0 ok, 1 usage error, 2 failure, 3 writer lease held or host busy.',
  '',
].join('\n');

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Control characters, C1 controls and the Unicode line and paragraph separators. */
const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** A message on one line: a stray newline must not turn one reason into several (stderr is line-oriented). */
function oneLine(text: string): string {
  let clean = '';
  for (const char of text) clean += isControl(char.codePointAt(0) as number) ? ' ' : char;
  return clean;
}

/** A usage error: the reason (one line, it can quote what the user typed), then the usage text. */
function usageError(io: CliIo, message: string): number {
  io.stderr.write(`gsd-atlas: ${oneLine(message)}\n${USAGE}`);
  return EXIT_USAGE;
}

interface RootFlags {
  readonly 'repo-root'?: string | undefined;
  readonly 'user-dir'?: string | undefined;
  readonly 'builtin-dir'?: string | undefined;
  readonly 'npm-root'?: string[] | undefined;
}

/**
 * The root flags the user gave, as absolute paths: a relative flag means relative to this process's
 * working directory, so it is resolved here, before the host sees it. Undefined when no flag was given.
 */
function rootsFrom(flags: RootFlags): Record<string, unknown> | undefined {
  const roots: Record<string, unknown> = {};
  if (flags['repo-root'] !== undefined) {
    roots['repoRoot'] = path.resolve(flags['repo-root']);
  }
  if (flags['user-dir'] !== undefined) {
    roots['userDir'] = path.resolve(flags['user-dir']);
  }
  if (flags['builtin-dir'] !== undefined) {
    roots['builtinDir'] = path.resolve(flags['builtin-dir']);
  }
  if (flags['npm-root'] !== undefined) {
    roots['npmRoots'] = flags['npm-root'].map((root) => path.resolve(root));
  }
  return Object.keys(roots).length === 0 ? undefined : roots;
}

/** Send one request, print the envelope exactly as returned, then one reason line per error or warning. */
async function send(io: CliIo, request: Request): Promise<number> {
  let envelope: Envelope;
  try {
    envelope = await io.client.handle(request);
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${oneLine(reasonOf(error))}\n`);
    return EXIT_FAILURE;
  }
  io.stdout.write(`${JSON.stringify(envelope)}\n`);
  for (const d of envelope.diagnostics) {
    if (d.severity === 'error' || d.severity === 'warning') {
      // A busy answer says when to come back; that number lives on the envelope, so the reason line repeats it.
      const wait = d.code === 'busy' && typeof envelope.retry_after === 'number' ? ` (retry after ${String(envelope.retry_after)} ms)` : '';
      io.stderr.write(`gsd-atlas: ${d.severity} ${d.code}: ${oneLine(d.message)}${wait}\n`);
    }
  }
  return exitCodeFor(envelope);
}

const langRequest = (kind: string, args: Record<string, unknown>): Request => ({ protocol: PROTOCOL_VERSION, kind, args });

/** `gsd-atlas init`: validate the flags, run it and print its envelope. It never contacts the host. */
async function init(io: CliIo, values: FlagValues): Promise<number> {
  const wanted = new Set<AgentId>();
  for (const name of Array.isArray(values.agent) ? values.agent : []) {
    const agent = AGENT_IDS.find((id) => id === name);
    if (agent === undefined) {
      return usageError(io, `unknown agent "${name}" (expected ${AGENT_IDS.join(', ')})`);
    }
    wanted.add(agent);
  }
  if (io.init === undefined) {
    io.stderr.write('gsd-atlas: error init_unavailable: init is not available in this build\n');
    return EXIT_FAILURE;
  }
  const result = await runInit({ dryRun: values['dry-run'] === true, agents: wanted.size === 0 ? 'all' : [...wanted] }, io.init);
  io.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  for (const line of result.stderrLines) {
    io.stderr.write(`${line}\n`);
  }
  return result.exitCode;
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
        ...FLAGS,
      },
    });
  } catch (error) {
    return usageError(io, reasonOf(error));
  }

  const { positionals } = parsed;
  const values = parsed.values as FlagValues;
  if (parsed.values.version === true) {
    io.stdout.write(`gsd-atlas ${io.version()}\n`);
    return EXIT_OK;
  }
  if (parsed.values.help === true) {
    io.stdout.write(USAGE);
    return EXIT_OK;
  }

  if (positionals[0] === undefined) {
    return usageError(io, 'a command is required');
  }
  const found = resolveCommand(positionals);
  if (found === undefined) {
    return usageError(io, 'unknown command');
  }
  const { command, rest } = found;
  const stray = unusedFlag(command, values);
  if (stray !== undefined) {
    return usageError(io, `--${stray} does not apply to ${command.name}`);
  }

  switch (command.kind) {
    case 'init':
      if (rest.length > 0) {
        return usageError(io, 'init takes no arguments, only --agent and --dry-run');
      }
      return init(io, values);
    case 'lang': {
      const roots = rootsFrom(values as RootFlags);
      if (command.name === 'lang list') {
        if (rest.length > 0) {
          return usageError(io, 'lang list takes no arguments, only root flags');
        }
        return send(io, langRequest('lang_list', roots === undefined ? {} : { roots }));
      }
      const [target, ...extra] = rest;
      if (target === undefined) {
        return usageError(io, 'lang test needs a module folder or module id');
      }
      if (extra.length > 0) {
        return usageError(io, 'lang test takes exactly one module folder or module id');
      }
      return send(io, langRequest('lang_test', roots === undefined ? { target } : { target, roots }));
    }
    default: {
      const input = inputFromFlags(command, values, rest, { cwd: io.cwd ?? path.resolve('.') });
      if (!input.ok) {
        return usageError(io, input.message);
      }
      return send(io, requestFor(command, input.input));
    }
  }
}
