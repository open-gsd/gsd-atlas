/**
 * The composition root shared by the bins (HST-02, D-03): the one place that knows the working directory, the
 * home directory and the environment, and so the one place that builds the real runner, the pooled Grammar
 * Engine, the Governor, the system clock, the module roots and the user configuration, and hands them to the
 * Host. Everything it builds comes from the arguments, never from a repository.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRealRunner } from '../command-runner/index.ts';
import type { CommandRunner, UserPermissions } from '../command-runner/index.ts';
import { defaultCacheRoot } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import { createPooledGrammarEngine } from '../grammar-engine/index.ts';
import { createInProcessHostClient } from '../host-client/index.ts';
import type { HostClient, Roots } from '../host-client/index.ts';
import { createHost, loadUserConfig, permissionsFor } from '../host/index.ts';
import type { Host, HostOrigin } from '../host/index.ts';
import { createParcelEventSource } from '../indexer/index.ts';

/** The package root: two levels up from src/bin (dev) or dist/bin (published). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The version in the package's own package.json. */
export function readVersion(): string {
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

export interface ComposeOptions {
  /** The working directory: the repository a request without `repo` or `cwd` is about, and the npm module root. */
  readonly cwd: string;
  /** The user's environment: `GSD_ATLAS_USER_DIR`, `GSD_ATLAS_STORE_DIR`, `XDG_CACHE_HOME`, and what child processes inherit. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where configuration warnings go. */
  readonly stderr: { write(text: string): unknown };
  /** The home directory. Default: the operating system's. */
  readonly home?: string;
  /** Who started this composition: `gsd-atlas` is `cli`, `gsd-atlas-mcp` is `mcp` (D-15). Default `cli`. */
  readonly origin?: HostOrigin;
  /** `gsd-atlas-mcp --allow-build`: the user's permission list applies to an `mcp` origin too. Default false. */
  readonly allowBuild?: boolean;
}

export interface Composed {
  readonly host: Host;
  readonly client: HostClient;
  /** The runner the Host uses, with the permissions this origin may use. Set by `composeHost`; a test reads it. */
  readonly runner?: CommandRunner;
  /** Close the Host (every tenant) and the pooled engine. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * Repo root and npm root are the working directory; the user dir is `GSD_ATLAS_USER_DIR` or
 * `<home>/.config/gsd-atlas`; the built-in dir is `<package root>/modules` when it exists.
 */
function defaultRoots(options: ComposeOptions, home: string): Roots {
  const fromEnv = options.env['GSD_ATLAS_USER_DIR'];
  const builtin = path.join(PACKAGE_ROOT, 'modules');
  return {
    repoRoot: options.cwd,
    userDir: fromEnv !== undefined && fromEnv !== '' ? path.resolve(fromEnv) : path.join(home, '.config', 'gsd-atlas'),
    builtinDir: existsSync(builtin) ? builtin : null,
    npmRoots: [options.cwd],
  };
}

export function composeHost(options: ComposeOptions): Composed {
  const home = options.home ?? os.homedir();
  const roots = defaultRoots(options, home);

  const loaded = loadUserConfig(roots.userDir, options.env);
  for (const warning of loaded.diagnostics) options.stderr.write(`gsd-atlas: warning ${warning.code}: ${warning.message}\n`);
  const { config } = loaded;
  const origin = options.origin ?? 'cli';
  const allowBuild = options.allowBuild === true;

  // The pooled engine with the approved defaults: its pool size, recycle interval and parse deadline are the
  // constants of 02-CONSTANTS.md, carried by the pool itself.
  const engine = createPooledGrammarEngine();
  const runner = makeRunner({ env: options.env, permissions: config.permissions, origin, allowBuild });
  const host = createHost({
    roots,
    engine,
    runner,
    governor: createGovernor({ clock: systemClock }),
    clock: systemClock,
    cwd: options.cwd,
    userDir: roots.userDir,
    config,
    origin,
    allowBuild,
    version: readVersion(),
    cacheRoot: defaultCacheRoot(options.env, home),
    eventSource: () => createParcelEventSource(),
  });
  const client = createInProcessHostClient({ roots, engine, host });

  let disposing: Promise<void> | undefined;
  return {
    host,
    client,
    runner,
    dispose(): Promise<void> {
      disposing ??= (async () => {
        await host.close();
        await engine.dispose();
      })();
      return disposing;
    },
  };
}

/** What decides the runner a Host gets: the environment its children inherit, the user's list, and who started the Host. */
export interface RunnerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The permission list the user's configuration holds. */
  readonly permissions?: UserPermissions | undefined;
  /** Who started the Host. Default `cli`. */
  readonly origin?: HostOrigin | undefined;
  /** `--allow-build`: an MCP server may use the user's list. Default false. */
  readonly allowBuild?: boolean | undefined;
}

/**
 * The real runner of a composition (D-15, SEC-02). A person at a terminal (`cli`) gets the user's permission list. An
 * agent's server (`mcp`) is built WITHOUT it unless the person started it with `--allow-build`, so a command the user
 * approved for the CLI is denied by the runner itself when the request came through MCP; the first-party git rule is
 * unaffected. The list is read once per composition: a later approval is seen by the next composition, not this one.
 */
export function makeRunner(options: RunnerOptions): CommandRunner {
  const user = permissionsFor(options.origin ?? 'cli', options.allowBuild === true, options.permissions);
  return createRealRunner({ env: options.env, ...(user === undefined ? {} : { user }) });
}

/** The usage line of `gsd-atlas-mcp`. */
export const MCP_USAGE = [
  'Usage: gsd-atlas-mcp [--allow-build]',
  '  A stateless MCP server on standard input and output.',
  '  --allow-build   let this server run the commands you approved with "gsd-atlas allow". Without it, an approved command is',
  '                  never run for an MCP request. Start it yourself; an agent must not choose this flag.',
  '',
].join('\n');

/** What `gsd-atlas-mcp` makes of its arguments. */
export type McpFlags =
  | { readonly ok: true; readonly allowBuild: boolean; readonly help: boolean }
  | { readonly ok: false; readonly message: string; readonly exitCode: number };

/** The only flags are `--allow-build` and `--help`; anything else, a value or a stray word is refused with the usage line. */
export function parseMcpFlags(argv: readonly string[]): McpFlags {
  let allowBuild = false;
  for (const argument of argv) {
    if (argument === '--allow-build') allowBuild = true;
    else if (argument === '--help' || argument === '-h') return { ok: true, allowBuild: false, help: true };
    else return { ok: false, message: `gsd-atlas-mcp: unknown argument\n${MCP_USAGE}`, exitCode: 1 };
  }
  return { ok: true, allowBuild, help: false };
}
