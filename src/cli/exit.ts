/**
 * The exit codes of the command-line adapter and the one place that turns an envelope into one (QRY-04, D-11, the
 * mcp-contract amendment). The mapping is a pure function of the envelope's diagnostics, so a script can rely on
 * it without reading any text.
 *
 * 0  ok
 * 1  usage error, invalid arguments, or a target that is neither a module folder nor a known module id
 * 2  any other failure (not_indexed, not_a_repo, parse and store errors, an internal error)
 * 3  the writer lease is held by another process, or the host is busy: try again, or use the other process
 */
export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILURE = 2;
export const EXIT_LEASE_HELD = 3;

/** Diagnostic codes that mean the caller asked for something that cannot be asked (exit 1). */
const USAGE_CODES: ReadonlySet<string> = new Set(['module_not_found', 'invalid_args']);

/** Diagnostic codes that mean "not now, and not here" (exit 3). */
const LEASE_CODES: ReadonlySet<string> = new Set(['lease_held', 'busy']);

/** The part of an envelope the mapping reads; `diagnostics` may be missing on a malformed reply. */
export interface ExitInput {
  readonly ok: boolean;
  readonly diagnostics?: readonly { readonly code: string }[] | undefined;
}

/**
 * The exit code for a reply. Precedence: usage (1), then lease held or busy (3, even when other errors ride along),
 * then any other failure (2), then ok (0). A not-ok reply without a diagnostic list is a failure.
 */
export function exitCodeFor(envelope: ExitInput): number {
  const codes = (envelope.diagnostics ?? []).map((diagnostic) => diagnostic.code);
  if (codes.some((code) => USAGE_CODES.has(code))) return EXIT_USAGE;
  if (codes.some((code) => LEASE_CODES.has(code))) return EXIT_LEASE_HELD;
  return envelope.ok ? EXIT_OK : EXIT_FAILURE;
}
