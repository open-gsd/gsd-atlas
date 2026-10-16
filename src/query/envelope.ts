/**
 * Envelope helpers for Query: the schema ids, the error envelope and the degraded list. Every Query response is
 * an Envelope; an empty result is an ok envelope, never an error (QRY-01).
 */
import { DEGRADED_CODES, diagnostic, failEnvelope } from '../facts/index.ts';
import type { DegradedCode, Diagnostic, Envelope, EnvelopeExtras } from '../facts/index.ts';

/** Schema of a reply that is only an error (unsupported protocol, unknown kind, bad args, bad cursor, ...). */
export const ERROR_SCHEMA = 'gsd-atlas.error/1';

export const CODE_FIND_SCHEMA = 'gsd-atlas.code-find/1';
export const CODE_REFS_SCHEMA = 'gsd-atlas.code-refs/1';
export const CODE_CONTEXT_SCHEMA = 'gsd-atlas.code-context/1';
export const CODE_IMPACT_SCHEMA = 'gsd-atlas.code-impact/1';
export const ATLAS_STATUS_SCHEMA = 'gsd-atlas.atlas-status/1';

/** An error envelope with one diagnostic. `message` must not carry unnormalized repo text. */
export function errorEnvelope(code: string, message: string, extras?: EnvelopeExtras): Envelope {
  return failEnvelope(ERROR_SCHEMA, [diagnostic(code, 'error', message)], extras);
}

export function errorWith(diagnostics: readonly Diagnostic[]): Envelope {
  return failEnvelope(ERROR_SCHEMA, diagnostics);
}

/** Distinct codes in the order of the closed vocabulary, so the same degradations always serialize the same way. */
export function orderedDegraded(codes: Iterable<DegradedCode>): DegradedCode[] {
  const seen = new Set(codes);
  return DEGRADED_CODES.filter((code) => seen.has(code));
}

/** The envelope with its `degraded` list set; an empty list leaves the key out. */
export function withDegraded<T>(envelope: Envelope<T>, codes: Iterable<DegradedCode>): Envelope<T> {
  const ordered = orderedDegraded(codes);
  return ordered.length === 0 ? envelope : { ...envelope, degraded: ordered };
}
