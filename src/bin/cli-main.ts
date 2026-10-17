/**
 * The body of the `gsd-atlas` command, with everything the real process supplies injected (IN-07, IN-09): the Host is
 * composed on the first request, not at start, so `--help`, `--version`, a usage error and `init` never build the Host,
 * read the user configuration or start the engine. Composition happens inside the same try block that reports a
 * failure as the CLI's own `error internal_error` line (exit code 2), and only what was composed is disposed.
 *
 * Signal exits (143, 130) are decided by `shutdown.ts`, outside the CLI's 0/1/2/3 table (QRY-04).
 */
import type { CliIo } from '../cli/index.ts';
import type { HostClient } from '../host-client/index.ts';
import type { Composed } from './compose.ts';

export interface CliMainDeps {
  readonly argv: readonly string[];
  /** Builds the Host. Called at most once, on the first request. */
  readonly compose: () => Composed;
  readonly runCli: (argv: readonly string[], io: CliIo) => Promise<number>;
  readonly version: () => string;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly cwd: string;
  readonly init: NonNullable<CliIo['init']>;
  /** Told how to dispose whatever has been composed so far (signal handlers use it). Called once, before the command runs. */
  readonly installShutdown?: (dispose: () => Promise<void>) => void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the command; resolves to the process exit code (0/1/2/3 as the CLI decides, 2 for a failure outside it). */
export async function runCliMain(deps: CliMainDeps): Promise<number> {
  let composed: Composed | undefined;
  const client: HostClient = {
    handle(request) {
      composed ??= deps.compose();
      return composed.client.handle(request);
    },
  };
  deps.installShutdown?.(() => composed?.dispose() ?? Promise.resolve());

  try {
    return await deps.runCli(deps.argv, {
      client,
      version: deps.version,
      stdout: deps.stdout,
      stderr: deps.stderr,
      cwd: deps.cwd,
      init: deps.init,
    });
  } catch (error) {
    deps.stderr.write(`gsd-atlas: error internal_error: ${reasonOf(error)}\n`);
    return 2;
  } finally {
    await composed?.dispose();
  }
}
