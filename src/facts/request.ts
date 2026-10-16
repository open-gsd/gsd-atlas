import type { DegradedCode } from './degraded.ts';
import type { Diagnostic } from './diagnostic.ts';

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

/** The reply to a Request. `data` is null when `ok` is false. */
export interface Envelope<T = unknown> {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: T | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly degraded?: readonly DegradedCode[];
}

export function okEnvelope<T>(
  schema: string,
  data: T,
  diagnostics: readonly Diagnostic[] = [],
): Envelope<T> {
  return { schema, ok: true, data, diagnostics };
}

export function failEnvelope<T = unknown>(
  schema: string,
  diagnostics: readonly Diagnostic[],
): Envelope<T> {
  return { schema, ok: false, data: null, diagnostics };
}
