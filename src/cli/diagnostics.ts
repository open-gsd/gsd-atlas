/**
 * `gsd-atlas diagnostics` (SKL-03; docs/DIAGNOSTICS.md section 4): the user-facing side of user-controlled diagnostics.
 * Diagnostics are off by default; this command is the only way to turn a data type on, and the Host refuses the whole
 * request kind when it was started for an agent's MCP server. The CLI imports only the host-client seam (adapter rule): it
 * sends requests and prints what the Host answers.
 *
 * Nothing here sends a report anywhere. `preview` shows the exact report, and `--save` keeps it on this machine.
 */
import { DIAGNOSTICS_KIND, PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, exitCodeFor } from './exit.ts';
import { oneLine, printEnvelope } from './text.ts';
import type { Sinks } from './text.ts';

/** What `diagnostics` needs from the CLI's io. */
export interface DiagnosticsIo extends Sinks {
  readonly client: HostClient;
  /** True when standard input and the stream the person reads are a terminal. Absent means no terminal. */
  readonly isTTY?: boolean | undefined;
  /** Asks one question on the terminal and resolves to the line the person typed. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
}

/** The sub-commands, in the order the usage line names them. */
export const DIAGNOSTICS_SUBCOMMANDS = ['enable', 'types', 'preview', 'disable', 'history'] as const;
type Sub = (typeof DIAGNOSTICS_SUBCOMMANDS)[number];

/** What the person typed, with paths already made absolute. */
export interface DiagnosticsInput {
  readonly sub: string | undefined;
  readonly rest: readonly string[];
  readonly repo?: string | undefined;
  readonly cwd?: string | undefined;
}

const isSub = (name: string | undefined): name is Sub => (DIAGNOSTICS_SUBCOMMANDS as readonly string[]).includes(name ?? '');

const requestOf = (args: Record<string, unknown>): Request => ({ protocol: PROTOCOL_VERSION, kind: DIAGNOSTICS_KIND, args });

/** Send one request; a client that throws is the CLI's usual `internal_error` line and exit 2. */
async function ask(io: DiagnosticsIo, request: Request): Promise<Envelope | null> {
  try {
    return await io.client.handle(request);
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${oneLine(error instanceof Error ? error.message : String(error))}\n`);
    return null;
  }
}

/** The notes the Host adds in words (`diagnostics_*` infos): printed on stderr, after the envelope. */
function printNotes(io: DiagnosticsIo, envelope: Envelope): void {
  for (const d of envelope.diagnostics) {
    if (d.severity === 'info' && d.code.startsWith('diagnostics_')) io.stderr.write(`gsd-atlas: ${oneLine(d.message)}\n`);
  }
}

async function preview(io: DiagnosticsIo, input: DiagnosticsInput): Promise<number> {
  const reply = await ask(io, requestOf({ action: 'preview', ...(input.repo === undefined ? {} : { repo: input.repo }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) }));
  if (reply === null) return EXIT_FAILURE;
  printEnvelope(io, reply);
  printNotes(io, reply);
  return exitCodeFor(reply);
}

/** Run `gsd-atlas diagnostics <sub>`. Resolves to the process exit code; `usage` reports a usage error and returns its code. */
export async function runDiagnostics(io: DiagnosticsIo, input: DiagnosticsInput, usage: (message: string) => number): Promise<number> {
  if (!isSub(input.sub)) {
    return usage(`diagnostics needs one of: ${DIAGNOSTICS_SUBCOMMANDS.join('|')}`);
  }
  switch (input.sub) {
    case 'preview':
      if (input.rest.length > 0) return usage('diagnostics preview takes no arguments, only flags');
      return preview(io, input);
    default:
      return usage(`diagnostics ${input.sub} is not available yet`);
  }
}
