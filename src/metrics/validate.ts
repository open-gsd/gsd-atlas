import { DEGRADED_CODES } from '../facts/index.ts';
import type { DegradedCode } from '../facts/index.ts';
import { TOOL_NAMES } from './types.ts';
import type { AnswerEvent, FreshnessEvent, IndexHealthEvent, MetricsEvent, ToolName } from './types.ts';

/**
 * Runtime check of the closed event vocabulary (MET-01 privacy prohibition). Written without a schema
 * library and with relative imports only, so the module that guards what may be recorded depends on nothing
 * it could be talked out of. It accepts exactly three shapes with exactly their keys; every string is a
 * member of a closed set and every other field is a finite non-negative number or a boolean. A rejection
 * names a fixed reason code and never echoes the input.
 */

export type RejectReason =
  | 'not_an_object'
  | 'unknown_kind'
  | 'unexpected_key'
  | 'missing_key'
  | 'bad_tool'
  | 'bad_degraded'
  | 'bad_number'
  | 'bad_boolean'
  | 'unreadable';

export type ValidationResult =
  | { readonly ok: true; readonly event: MetricsEvent }
  | { readonly ok: false; readonly reason: RejectReason };

const ANSWER_KEYS = ['kind', 'tool', 'ok', 'latencyMs', 'results', 'estimatedTokens', 'truncated', 'degraded'] as const;
const FRESHNESS_KEYS = ['kind', 'lagMs'] as const;
const HEALTH_KEYS = ['kind', 'files', 'errorFiles', 'staleFiles', 'sizeBytes'] as const;

/** A generous bound on `degraded`; the closed set has far fewer members and duplicates are collapsed. */
const MAX_DEGRADED_INPUT = 64;

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function keyProblem(target: object, expected: readonly string[]): RejectReason | null {
  if (Object.getOwnPropertySymbols(target).length > 0) return 'unexpected_key';
  for (const key of Object.keys(target)) {
    if (!expected.includes(key)) return 'unexpected_key';
  }
  for (const key of expected) {
    if (!hasOwn(target, key)) return 'missing_key';
  }
  return null;
}

function fail(reason: RejectReason): ValidationResult {
  return { ok: false, reason };
}

function validateAnswer(source: Record<string, unknown>): ValidationResult {
  const { tool, ok, latencyMs, results, estimatedTokens, truncated, degraded } = source;
  if (typeof tool !== 'string' || !(TOOL_NAMES as readonly string[]).includes(tool)) return fail('bad_tool');
  if (typeof ok !== 'boolean' || typeof truncated !== 'boolean') return fail('bad_boolean');
  if (!isCount(latencyMs) || !isCount(results) || !isCount(estimatedTokens)) return fail('bad_number');
  if (!Array.isArray(degraded) || degraded.length > MAX_DEGRADED_INPUT) return fail('bad_degraded');
  const codes: DegradedCode[] = [];
  for (const code of degraded as readonly unknown[]) {
    if (typeof code !== 'string' || !(DEGRADED_CODES as readonly string[]).includes(code)) return fail('bad_degraded');
    if (!codes.includes(code as DegradedCode)) codes.push(code as DegradedCode);
  }
  const event: AnswerEvent = {
    kind: 'answer',
    tool: tool as ToolName,
    ok,
    latencyMs,
    results,
    estimatedTokens,
    truncated,
    degraded: codes,
  };
  return { ok: true, event };
}

function validateFreshness(source: Record<string, unknown>): ValidationResult {
  const { lagMs } = source;
  if (!isCount(lagMs)) return fail('bad_number');
  const event: FreshnessEvent = { kind: 'freshness', lagMs };
  return { ok: true, event };
}

function validateHealth(source: Record<string, unknown>): ValidationResult {
  const { files, errorFiles, staleFiles, sizeBytes } = source;
  if (!isCount(files) || !isCount(errorFiles) || !isCount(staleFiles) || !isCount(sizeBytes)) return fail('bad_number');
  const event: IndexHealthEvent = { kind: 'index_health', files, errorFiles, staleFiles, sizeBytes };
  return { ok: true, event };
}

/**
 * Check one candidate event. On success the returned event is a fresh copy built only from checked fields,
 * so later changes to the caller's object cannot alter what is queued.
 */
export function validateEvent(value: unknown): ValidationResult {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('not_an_object');
    const source = value as Record<string, unknown>;
    const kind = source.kind;
    const expected =
      kind === 'answer' ? ANSWER_KEYS : kind === 'freshness' ? FRESHNESS_KEYS : kind === 'index_health' ? HEALTH_KEYS : null;
    if (expected === null) return fail('unknown_kind');
    const problem = keyProblem(value, expected);
    if (problem !== null) return fail(problem);
    if (kind === 'answer') return validateAnswer(source);
    if (kind === 'freshness') return validateFreshness(source);
    return validateHealth(source);
  } catch {
    // A getter or a proxy trap threw: the value is not a plain record of the allowed shapes.
    return fail('unreadable');
  }
}
