/**
 * The Tenant's refusals that tell a person what to do (WR-02, plan 02-40). Each builder returns a ready error
 * envelope, so the CLI and the MCP tool, which render the same envelope, answer with the same bytes (QRY-04).
 *
 * The honest limit, which the texts below state rather than hide: while an agent's MCP server holds the writer
 * lease, `gsd-atlas build` in a terminal answers `lease_held` (exit 3). Handing the build to the process that holds the
 * lease is the socket Host of Phase 4 (D-01); until then the only way to build while another process leads is to
 * end that process, then start it again.
 *
 * A text carries a process id and a version at most, both already in `lease.json`: no path, repository name or content.
 */
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic, Envelope } from '../facts/index.ts';
import { errorEnvelope } from '../query/index.ts';

/** Who holds the writer lease, as far as `StoreStatus.leaseHolder` knows. */
export interface LeaseHolderName {
  readonly pid: number;
  readonly version: string;
}

const NOT_INDEXED_NO_STORE =
  'This repository has not been indexed yet. Run "gsd-atlas build" in a terminal inside it, then ask again.';

/** The repository has no index at all (the Host, plan 02-41): the exact command to run. */
export function notIndexedNoStore(): Envelope {
  return errorEnvelope('not_indexed', NOT_INDEXED_NO_STORE);
}

const who = (holder: LeaseHolderName | undefined): string =>
  holder === undefined ? 'another gsd-atlas process' : `gsd-atlas process ${String(holder.pid)} (version ${holder.version})`;

/**
 * The store exists but this worktree was never built, and a process holds the writer lease (this one, when it
 * leads). `gsd-atlas build` in a terminal cannot take the lease, so the message names what to end first.
 */
export function notIndexedEnvelope(holder: LeaseHolderName | undefined): Envelope {
  return errorEnvelope(
    'not_indexed',
    `This worktree has not been indexed yet, and ${who(holder)} holds the writer for this repository, so "gsd-atlas build" in a terminal answers lease_held (exit 3). ` +
      'End the agent session that started that process, run "gsd-atlas build" in a terminal, then start the agent again.',
  );
}

/** A build or maintenance request reached a process that does not hold the writer lease. */
export function leaseHeldEnvelope(holder: LeaseHolderName | undefined): Envelope {
  return errorEnvelope(
    'lease_held',
    `${who(holder)} holds the writer for this repository, so this process cannot index or run maintenance. ` +
      'Handing a build to the process that holds the writer is not available yet: end that process (the agent session that started it), run the command again in a terminal, then start the agent again.',
  );
}

/**
 * The codes of the notes of `BuildResult.skipped` that may reach the envelope of a build (amendment of 2026-10-18, SEC-01):
 * the two aggregated, pathless notes the Indexer makes. Anything else the build collected (a source-tree diagnostic names a path
 * in its subject or its text) is counted in `skipped` and goes no further.
 */
export const BUILD_NOTE_CODES: readonly string[] = ['emit_output_not_indexed', 'citation_comment_too_long'];

/** The Tenant's own note when the eager pass after a build ran out of its bound. Fixed words: nothing from the repository. */
const RESOLVER_TIMEOUT_NOTE =
  'The compiler pass that follows a build did not finish within its time bound. The index is complete; run "gsd-atlas maintain resolve" to continue the pass, or let the first questions fill it in.';

/**
 * The `diagnostics` of a build envelope: the notes of `skipped` whose code is on the allow-list and that have no `subject`
 * (in the order the build reported them), then the `resolver_timeout` note when the eager pass ran out of its bound. A note
 * with a subject, or with any other code, is not copied, so no repository path or text reaches the envelope through the notes
 * of a build. It reads `skipped` and nothing else, so a build that parsed nothing repeats a note the build result carries.
 */
export function buildNotes(skipped: readonly Diagnostic[], resolverTimedOut: boolean): Diagnostic[] {
  const notes = skipped.filter((note) => note.subject === undefined && BUILD_NOTE_CODES.includes(note.code));
  return resolverTimedOut ? [...notes, diagnostic('resolver_timeout', 'info', RESOLVER_TIMEOUT_NOTE)] : notes;
}

/** The store closed itself (after a failed recovery) or was closed under a request. */
export function storeUnavailableEnvelope(): Envelope {
  return errorEnvelope(
    'store_unavailable',
    'The index of this repository is closed and cannot answer. End this session and start it again to reopen the index.',
  );
}
