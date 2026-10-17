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
import { defaultCacheRoot } from '../fact-store/index.ts';
import { systemClock } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import { createPooledGrammarEngine } from '../grammar-engine/index.ts';
import { createInProcessHostClient } from '../host-client/index.ts';
import type { HostClient, Roots } from '../host-client/index.ts';
import { createHost, loadUserConfig } from '../host/index.ts';
import type { Host } from '../host/index.ts';
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
}

export interface Composed {
  readonly host: Host;
  readonly client: HostClient;
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

  // The pooled engine with the approved defaults: its pool size, recycle interval and parse deadline are the
  // constants of 02-CONSTANTS.md, carried by the pool itself.
  const engine = createPooledGrammarEngine();
  const host = createHost({
    roots,
    engine,
    runner: createRealRunner({ env: options.env, ...(config.permissions === undefined ? {} : { user: config.permissions }) }),
    governor: createGovernor({ clock: systemClock }),
    clock: systemClock,
    cwd: options.cwd,
    userDir: roots.userDir,
    config,
    version: readVersion(),
    cacheRoot: defaultCacheRoot(options.env, home),
    eventSource: () => createParcelEventSource(),
  });
  const client = createInProcessHostClient({ roots, engine, host });

  let disposing: Promise<void> | undefined;
  return {
    host,
    client,
    dispose(): Promise<void> {
      disposing ??= (async () => {
        await host.close();
        await engine.dispose();
      })();
      return disposing;
    },
  };
}
