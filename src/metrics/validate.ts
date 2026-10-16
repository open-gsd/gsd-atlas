import type { MetricsEvent } from './types.ts';

export type ValidationResult =
  | { readonly ok: true; readonly event: MetricsEvent }
  | { readonly ok: false; readonly reason: string };

/** Placeholder for the red commit: accepts everything. Replaced by the allow-list check. */
export function validateEvent(value: unknown): ValidationResult {
  return { ok: true, event: value as MetricsEvent };
}
