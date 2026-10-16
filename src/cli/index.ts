/**
 * The command-line adapter. It parses argv, sends one Request through the HostClient and prints
 * the Envelope; it imports nothing but the host-client seam (adapter rule). The composition root
 * (src/bin/gsd-atlas.ts) decides which HostClient it talks to.
 *
 * Output contract: stdout carries exactly one JSON envelope per request (nothing else), stderr
 * carries the human reasons, one line per error or warning diagnostic.
 * Exit codes: 0 ok; 1 usage error or a target that is neither a module folder nor a known module id;
 * 2 any other failure.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Envelope, HostClient } from '../host-client/index.ts';
import { INIT_SCHEMA, runInit } from './init.ts';
import type { InitEnvironment } from './init.ts';
import { AGENT_IDS } from './init-targets.ts';
import type { AgentId } from './init-targets.ts';

export { INIT_SCHEMA };

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILURE = 2;

export interface CliIo {
  readonly client: HostClient;
  /** Read lazily, so `--help` and usage errors never touch package.json. */
  readonly version: () => string;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  /** Home, working directory, platform, environment and MCP launch command for `init`; the bin supplies it. */
  readonly init?: InitEnvironment;
}

const USAGE = [
  'Usage: gsd-atlas [--version | -v] [--help | -h]',
  '       gsd-atlas init [--agent claude|cursor|codex] [--dry-run]',
  '       gsd-atlas lang list [root flags]',
  '       gsd-atlas lang test <module-folder>|<module-id> [root flags]',
  'Root flags (where modules are searched; each one replaces its default):',
  '       --repo-root <dir>  --user-dir <dir>  --builtin-dir <dir>  --npm-root <dir> (repeatable)',
  '',
].join('\n');

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

async function send(io: CliIo, kind: string, args: Record<string, unknown>): Promise<number> {
  let envelope: Envelope;
  try {
    envelope = await io.client.handle({ protocol: PROTOCOL_VERSION, kind, args });
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

interface InitFlags extends RootFlags {
  readonly agent?: string[] | undefined;
  readonly 'dry-run'?: boolean | undefined;
}

/** `gsd-atlas init`: validate the flags, run it and print its envelope. It never contacts the host. */
async function init(io: CliIo, flags: InitFlags, hasArguments: boolean): Promise<number> {
  if (hasArguments) {
    return usageError(io, 'init takes no arguments, only --agent and --dry-run');
  }
  if (rootsFrom(flags) !== undefined) {
    return usageError(io, 'the module root flags do not apply to init');
  }
  const wanted = new Set<AgentId>();
  for (const name of flags.agent ?? []) {
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
  const result = await runInit({ dryRun: flags['dry-run'] === true, agents: wanted.size === 0 ? 'all' : [...wanted] }, io.init);
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
        'repo-root': { type: 'string' },
        'user-dir': { type: 'string' },
        'builtin-dir': { type: 'string' },
        'npm-root': { type: 'string', multiple: true },
        agent: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
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
  if (group === 'init') {
    return init(io, values, positionals.length > 1);
  }
  if (values.agent !== undefined || values['dry-run'] === true) {
    return usageError(io, '--agent and --dry-run apply only to the init command');
  }
  if (group !== 'lang' || (action !== 'test' && action !== 'list')) {
    return usageError(io, 'unknown command');
  }
  const roots = rootsFrom(values);
  if (action === 'list') {
    if (target !== undefined) {
      return usageError(io, 'lang list takes no arguments, only root flags');
    }
    return send(io, 'lang_list', roots === undefined ? {} : { roots });
  }
  if (target === undefined) {
    return usageError(io, 'lang test needs a module folder or module id');
  }
  if (extra.length > 0) {
    return usageError(io, 'lang test takes exactly one module folder or module id');
  }
  return send(io, 'lang_test', roots === undefined ? { target } : { target, roots });
}
