/**
 * What the Tenant tells Metrics about an answer (MET-02, D-17). The event is built from the structure of the
 * envelope only: counts, flags and codes of the closed vocabulary. No path, symbol name, repository name, prompt or
 * source text is read, so none can reach `metrics.db` (T-02-98).
 */
import { isDegradedCode } from '../facts/index.ts';
import type { DegradedCode, Envelope } from '../facts/index.ts';
import type { AnswerEvent, ToolName } from '../metrics/index.ts';

/** The request kinds a Tenant answers; `build`, `maintain`, `status` and `lang_*` are not answers. */
const ANSWERED: ReadonlySet<string> = new Set<ToolName>(['code_find', 'code_refs', 'code_context', 'code_impact', 'atlas_status']);

/**
 * The answer event for `envelope`, or null when `kind` is not one of the five tools a Tenant answers.
 * `results` is the number of citations; `estimatedTokens` is the serialized length divided by four, rounded up (an
 * estimate, never a measured count); `degraded` keeps each code of the closed vocabulary once, in order.
 */
export function answerEvent(kind: string, envelope: Envelope, latencyMs: number): AnswerEvent | null {
  if (!ANSWERED.has(kind)) return null;
  const degraded: DegradedCode[] = [];
  for (const code of envelope.degraded ?? []) {
    if (typeof code === 'string' && isDegradedCode(code) && !degraded.includes(code)) degraded.push(code);
  }
  return {
    kind: 'answer',
    tool: kind as ToolName,
    ok: envelope.ok,
    latencyMs: Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0,
    results: envelope.citations?.length ?? 0,
    estimatedTokens: Math.ceil(JSON.stringify(envelope).length / 4),
    truncated: envelope.truncated === true,
    degraded,
  };
}
