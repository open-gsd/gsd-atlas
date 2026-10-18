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

import { INDEX_STATE_SCHEMA, PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Envelope, HostClient, IndexStateData, Request } from '../host-client/index.ts';
import { runAllow } from './allow.ts';
import { runDiagnostics } from './diagnostics.ts';
import { EXIT_FAILURE, EXIT_LEASE_HELD, EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.ts';
import { INIT_SCHEMA, runInit } from './init.ts';
import type { IndexState, InitEnvironment } from './init.ts';
import { AGENT_IDS } from './init-targets.ts';
import type { AgentId } from './init-targets.ts';
import { oneLine, printEnvelope, ratedLine } from './text.ts';
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
  /** True when standard input and the stream the person reads are a terminal. Only `allow` needs one; absent means none. */
  readonly isTTY?: boolean;
  /** Asks one question on the terminal and resolves to the line typed. Only `allow` asks. */
  readonly prompt?: (question: string) => Promise<string>;
}

const USAGE = [
  'Usage: gsd-atlas [--version | -v] [--help | -h]',
  ...COMMANDS.map((command) => `       ${command.usage}`),
  'Selection flags (every repository command): --repo <dir>  --cwd <dir>',
  'Paging flags (find, refs, context, impact): --budget <tokens>  --more <cursor>  --fresh <path> (repeatable)  --limit <n>',
  'History flags (history): --at <revision> (required)  --path <file> (one file of that commit)  --limit <n>  --budget <tokens>. History reads git objects only: it never writes to the index and never contacts a remote.',
  'Root flags (where modules are searched; each one replaces its default):',
  '       --repo-root <dir>  --user-dir <dir>  --builtin-dir <dir>  --npm-root <dir> (repeatable)',
  'Output: one JSON envelope on stdout; reasons on stderr. Exit codes: 0 ok, 1 usage error, 2 failure, 3 writer lease held or host busy.',
  '',
].join('\n');

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Send one request, print the envelope exactly as returned, then one reason line per error or warning. `confirm` makes
 * the one line a reply that succeeded adds on stderr (a rating says what it recorded).
 */
async function send(io: CliIo, request: Request, confirm?: (data: unknown) => string | null): Promise<number> {
  let envelope: Envelope;
  try {
    envelope = await io.client.handle(request);
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${oneLine(reasonOf(error))}\n`);
    return EXIT_FAILURE;
  }
  printEnvelope(io, envelope);
  const code = exitCodeFor(envelope);
  if (code === EXIT_OK && confirm !== undefined) {
    const line = confirm(envelope.data);
    if (line !== null) io.stderr.write(line);
  }
  return code;
}

const langRequest = (kind: string, args: Record<string, unknown>): Request => ({ protocol: PROTOCOL_VERSION, kind, args });

/**
 * Ask the Host whether the repository around `cwd` has an index (the internal `index_state` request, not an MCP tool).
 * Anything but a well-formed ok reply is `unknown`, and init then falls back to its file-system probe.
 */
async function askIndexState(client: HostClient, cwd: string): Promise<IndexState> {
  const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'index_state', args: { cwd } });
  const data = reply.data as Partial<IndexStateData> | null;
  if (!reply.ok || reply.schema !== INDEX_STATE_SCHEMA || typeof data !== 'object' || data === null || typeof data.indexed !== 'boolean') {
    return { kind: 'unknown' };
  }
  if (data.indexed) {
    return { kind: 'indexed' };
  }
  return typeof data.repo === 'string' && data.repo !== '' ? { kind: 'not_indexed', repo: data.repo } : { kind: 'unknown' };
}

/**
 * `gsd-atlas init`: validate the flags, run it and print its envelope. It edits files and launches no program; the one
 * thing it asks the host is whether the working directory's repository has an index, for the `gsd-atlas build` hint.
 */
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
  const environment: InitEnvironment = { ...io.init, indexState: io.init.indexState ?? ((cwd) => askIndexState(io.client, cwd)) };
  const result = await runInit({ dryRun: values['dry-run'] === true, agents: wanted.size === 0 ? 'all' : [...wanted] }, environment);
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
    case 'allow': {
      // Everything after the first `--` is the command to approve, flags and all, so it is cut from argv here: parseArgs
      // reports those tokens as positionals but not where the `--` was.
      const dash = argv.indexOf('--');
      const toApprove = dash === -1 ? [] : argv.slice(dash + 1);
      if (positionals.length - toApprove.length > 1) {
        return usageError(io, 'allow takes its command after a double dash: gsd-atlas allow -- <executable> <args...>');
      }
      const moduleName = typeof values.module === 'string' ? values.module : undefined;
      if (moduleName === '') {
        return usageError(io, '--module needs the name of a language module');
      }
      if (moduleName !== undefined && toApprove.length > 0) {
        return usageError(io, 'allow takes either --module <name> or a command after a double dash, not both');
      }
      if (moduleName === undefined && toApprove.length === 0) {
        return usageError(io, 'allow needs the command to approve after a double dash: gsd-atlas allow -- <executable> <args...>');
      }
      const base = io.cwd ?? path.resolve('.');
      return runAllow(io, {
        repo: typeof values.repo === 'string' ? path.resolve(base, values.repo) : undefined,
        cwd: typeof values.cwd === 'string' ? path.resolve(base, values.cwd) : undefined,
        workdir: typeof values.workdir === 'string' ? values.workdir : undefined,
        module: moduleName,
        argv: moduleName === undefined ? toApprove : undefined,
      });
    }
    case 'diagnostics': {
      const [sub, ...others] = rest;
      const base = io.cwd ?? path.resolve('.');
      return runDiagnostics(
        io,
        {
          sub,
          rest: others,
          repo: typeof values.repo === 'string' ? path.resolve(base, values.repo) : undefined,
          cwd: typeof values.cwd === 'string' ? path.resolve(base, values.cwd) : undefined,
          note: typeof values.note === 'string' ? values.note : undefined,
          rating: typeof values.rating === 'string' ? values.rating : undefined,
          feature: typeof values.feature === 'string' ? values.feature : undefined,
          save: values.save === true,
        },
        (message) => usageError(io, message),
      );
    }
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
      return send(io, requestFor(command, input.input), command.request === 'rate' ? ratedLine : undefined);
    }
  }
}
