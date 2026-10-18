import type { Watermark } from './answer.ts';
import type { DegradedCode } from './degraded.ts';
import type { Diagnostic } from './diagnostic.ts';
import type { Confidence } from './file-facts.ts';

/** Wire protocol version. Carried on every request from the first release (Day-One Invariant 3). */
export const PROTOCOL_VERSION = 1;

/**
 * A request to the host. `kind` is an open string in Phase 1 (plan 01-14 defines `lang_test`,
 * plan 01-17 adds `lang_list`). The protocol number, tenant hint and worktree exist from the
 * start so the Phase 4 transport changes nothing about the shape.
 */
export interface Request {
  readonly protocol: number;
  readonly kind: string;
  readonly args?: unknown;
  readonly worktree?: string;
  readonly tenantHint?: string;
  readonly budget_tokens?: number;
  readonly fresh?: readonly string[];
}

/**
 * Where a fact lives. Structure only (path, position, confidence, handles): a Citation never
 * carries matched source text. Repo text travels in `UntrustedText`, fenced by Query.
 * `line` and `col` are 1-based for display; spans elsewhere in the kernel are 0-based.
 */
export interface Citation {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly endLine: number;
  readonly endCol: number;
  readonly confidence: Confidence;
  /** Handle for the debug view of this fact. */
  readonly debug: string;
  /** The `UntrustedEntry.ref` that holds the source text of this citation, when any. */
  readonly text_ref?: string;
}

/** One piece of repo text, tied to the citation or fact it belongs to by `ref`. */
export interface UntrustedEntry {
  readonly ref: string;
  readonly text: string;
}

/** The only place repo text may appear in an Envelope. `nonce` fences it for the consumer. */
export interface UntrustedText {
  readonly nonce: string;
  readonly entries: readonly UntrustedEntry[];
}

/** The optional fields of an Envelope (QRY-01, HST-03). All are additive. */
export interface EnvelopeExtras {
  readonly citations?: readonly Citation[];
  readonly watermark?: Watermark;
  readonly untrusted_text?: UntrustedText;
  readonly truncated?: boolean;
  /** Cursor for the next page. */
  readonly more?: string;
  readonly hints?: readonly string[];
  /** Milliseconds to wait before retrying; present only on a busy error. */
  readonly retry_after?: number;
  /**
   * Random identifier of this answer (`a_` and 16 hex digits), stamped by the Host after the answer
   * exists. It holds no content, so a rating or report can name an answer without storing it.
   */
  readonly answer_id?: string;
}

/** The reply to a Request. `data` is null when `ok` is false. */
export interface Envelope<T = unknown> extends EnvelopeExtras {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: T | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly degraded?: readonly DegradedCode[];
}

/** Copy only the keys of `extras` that are present, so JSON output never has undefined keys. */
function definedExtras(extras: EnvelopeExtras | undefined): EnvelopeExtras {
  if (extras === undefined) {
    return {};
  }
  return Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined));
}

export function okEnvelope<T>(
  schema: string,
  data: T,
  diagnostics: readonly Diagnostic[] = [],
  extras?: EnvelopeExtras,
): Envelope<T> {
  return { schema, ok: true, data, diagnostics, ...definedExtras(extras) };
}

export function failEnvelope<T = unknown>(
  schema: string,
  diagnostics: readonly Diagnostic[],
  extras?: EnvelopeExtras,
): Envelope<T> {
  return { schema, ok: false, data: null, diagnostics, ...definedExtras(extras) };
}
