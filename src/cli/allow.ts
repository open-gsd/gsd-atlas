/**
 * `gsd-atlas allow` (D-15, SEC-02): approve ONE exact command for ONE repository. It is the only way a permission is
 * created, so it is built to be unreachable by anything but a person at a terminal:
 *   - with no terminal it writes nothing and exits 2 (`allow needs a terminal`), and it never asks over MCP: there is no
 *     MCP tool for it and a Host started for MCP refuses the request;
 *   - the person is shown the exact argv, the repository and the working directory before being asked;
 *   - the write step carries the hash of what was shown, and the Host writes only if the hash still matches.
 *
 * It imports only the host-client seam (adapter rule). Text that came from a repository or was pasted can hold terminal
 * control sequences, so every value is printed quoted, with control characters escaped.
 */
import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, EXIT_LEASE_HELD, EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.ts';
import { approvedLine, oneLine, printEnvelope, show } from './text.ts';
import type { Sinks } from './text.ts';

/** What `allow` needs from the CLI's io. */
export interface AllowIo extends Sinks {
  readonly client: HostClient;
  /** True when standard input and the stream the person reads are a terminal. Absent means no terminal. */
  readonly isTTY?: boolean | undefined;
  /** Asks one question on the terminal and resolves to the line the person typed. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
}

/** What the person asked for, with paths already made absolute. */
export interface AllowRequestInput {
  readonly repo?: string | undefined;
  readonly cwd?: string | undefined;
  readonly workdir?: string | undefined;
  readonly module?: string | undefined;
  readonly argv?: readonly string[] | undefined;
}

/** The preview a dry run returns, as this command reads it. */
interface Preview {
  readonly repo: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sha256: string;
  /** True when a language module's manifest proposed the command; the module's name is never sent. */
  readonly fromModule: boolean;
}

const NEEDS_TERMINAL = 'gsd-atlas: error allow_needs_terminal: allow needs a terminal\n';
const QUESTION = 'Allow this exact command to run for this repository? [y/N] ';
const RESTART_NOTE =
  'gsd-atlas: approved. A running MCP server must be restarted to see this approval, and it runs an approved command only when it was started with --allow-build.\n';

function readPreview(data: unknown): Preview | null {
  if (typeof data !== 'object' || data === null) return null;
  const { repo, executable, args, cwd, sha256, fromModule } = data as Record<string, unknown>;
  if (typeof repo !== 'string' || typeof executable !== 'string' || typeof cwd !== 'string') return null;
  if (!Array.isArray(args) || !args.every((each): each is string => typeof each === 'string')) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { repo, executable, args, cwd, sha256, fromModule: fromModule === true };
}

function previewLines(preview: Preview): string {
  return [
    'gsd-atlas: review this approval. Nothing runs now: it only records that you allow this exact command.',
    ...(preview.fromModule
      ? ['  This command was proposed by a language module manifest in the repository: read it as carefully as if you had typed it.']
      : []),
    `  repository:         ${show(preview.repo)}`,
    `  executable:         ${show(preview.executable)}`,
    `  arguments:          [${preview.args.map(show).join(', ')}]`,
    `  working directory:  ${show(preview.cwd)} (relative to the repository)`,
    `  approval hash:      ${preview.sha256}`,
    '',
  ].join('\n');
}

const isYes = (answer: string): boolean => /^(y|yes)$/i.test(answer.trim());

/** The exit code of a reply: an invalid user configuration file is 3 (nothing changed, fix the file and try again). */
function exitCodeOf(envelope: Envelope): number {
  return envelope.diagnostics.some((d) => d.code === 'config_invalid') ? EXIT_LEASE_HELD : exitCodeFor(envelope);
}

const requestOf = (input: AllowRequestInput, confirm?: string): Request => ({
  protocol: PROTOCOL_VERSION,
  kind: 'allow',
  args: {
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
    ...(input.module === undefined ? {} : { module: input.module }),
    ...(input.argv === undefined ? {} : { argv: [...input.argv] }),
    ...(confirm === undefined ? {} : { confirm }),
  },
});

/** Send one request; a client that throws is the CLI's usual `internal_error` line and exit 2. */
async function ask(io: AllowIo, request: Request): Promise<Envelope | null> {
  try {
    return await io.client.handle(request);
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${oneLine(error instanceof Error ? error.message : String(error))}\n`);
    return null;
  }
}

/** Run `gsd-atlas allow`: preview, ask, then write. Resolves to the process exit code. */
export async function runAllow(io: AllowIo, input: AllowRequestInput): Promise<number> {
  // Checked first and before anything is sent: no terminal, no approval, and no request that could write.
  if (io.isTTY !== true || io.prompt === undefined) {
    io.stderr.write(NEEDS_TERMINAL);
    return EXIT_FAILURE;
  }

  const dry = await ask(io, requestOf(input));
  if (dry === null) return EXIT_FAILURE;
  if (!dry.ok) {
    printEnvelope(io, dry);
    return exitCodeOf(dry);
  }
  const preview = readPreview(dry.data);
  if (preview === null) {
    io.stderr.write('gsd-atlas: error allow_preview_unreadable: the host answered with a preview this command cannot read, so nothing was asked or written\n');
    return EXIT_FAILURE;
  }

  io.stderr.write(previewLines(preview));
  let answer = '';
  try {
    answer = await io.prompt(QUESTION);
  } catch {
    answer = '';
  }
  if (!isYes(answer)) {
    io.stderr.write('gsd-atlas: nothing was approved and nothing was written\n');
    return EXIT_USAGE;
  }

  const done = await ask(io, requestOf(input, preview.sha256));
  if (done === null) return EXIT_FAILURE;
  printEnvelope(io, done);
  if (done.ok) {
    const approved = approvedLine(done.data);
    if (approved !== null) io.stderr.write(approved);
    const already = (done.data as { already_allowed?: unknown } | null)?.already_allowed === true;
    io.stderr.write(already ? 'gsd-atlas: this exact command was already approved; nothing was changed\n' : RESTART_NOTE);
  }
  return done.ok ? EXIT_OK : exitCodeOf(done);
}
