/**
 * What the Tenant tells Metrics about an answer (MET-02, D-17). The event is built from the structure of the
 * envelope only: counts, flags and codes of the closed vocabulary. No path, symbol name, repository name, prompt or
 * source text is read, so none can reach `metrics.db` (T-02-98).
 */
import { isDegradedCode } from '../facts/index.ts';
import type { DegradedCode, Envelope, Request } from '../facts/index.ts';
import { LATENCY_BUCKETS_MS, bucketLabelFor } from '../metrics/index.ts';
import type { AnswerEvent, ToolName } from '../metrics/index.ts';
import type { FlightEventInput } from './flight.ts';

/** The request kinds a Tenant answers; `build`, `maintain`, `status` and `lang_*` are not answers. */
const ANSWERED: ReadonlySet<string> = new Set<ToolName>(['code_find', 'code_refs', 'code_context', 'code_impact', 'atlas_status', 'code_explain']);

/** True for the six request kinds a Tenant answers with a tool answer (and so stamps with an answer id and records). */
export const isAnsweredKind = (kind: string): boolean => ANSWERED.has(kind);

/**
 * The answer event for `envelope`, or null when `kind` is not one of the six tools a Tenant answers.
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

/**
 * What the flight recorder keeps of an answer (plan 03-17, DIAGNOSTICS.md 9.1), or null when `request.kind` is not a
 * tool answer. The id is the one stamped on the envelope. The event holds the request arguments (the recorder cuts
 * long strings), the outcome (`ok`, or the first diagnostic code), a latency bucket label, the degraded codes of the
 * closed vocabulary, the number of citations and their debug handles. It reads no `data` and no `untrusted_text`.
 */
export function flightAnswer(request: Request, envelope: Envelope, latencyMs: number, answerId: string): FlightEventInput | null {
  if (!ANSWERED.has(request.kind)) return null;
  const degraded: string[] = [];
  for (const code of envelope.degraded ?? []) {
    if (typeof code === 'string' && isDegradedCode(code) && !degraded.includes(code)) degraded.push(code);
  }
  const handles: string[] = [];
  for (const citation of envelope.citations ?? []) {
    if (typeof citation.debug === 'string') handles.push(citation.debug);
  }
  const args = typeof request.args === 'object' && request.args !== null && !Array.isArray(request.args) ? (request.args as Record<string, unknown>) : undefined;
  return {
    kind: 'answer',
    id: answerId,
    tool: request.kind,
    ...(args === undefined ? {} : { args }),
    outcome: envelope.ok ? 'ok' : (envelope.diagnostics[0]?.code ?? 'error'),
    ms: bucketLabelFor(LATENCY_BUCKETS_MS, Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0),
    degraded,
    count: envelope.citations?.length ?? 0,
    handles,
    // Plan 03-32: what `gsd-atlas bug` shows of the envelope. Words the program chose, and a number; no data.
    schema: envelope.schema,
    diag: envelope.diagnostics.map((entry) => entry.code),
    ...(envelope.watermark === undefined ? {} : { seq: envelope.watermark.seq }),
  };
}
