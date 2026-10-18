/**
 * `code_explain` (QRY-07, D-18, plan 03-26): why atlas said something. Given the `handle` of a fact (the `debug` value every
 * citation carries) it reports which extractor, tier, grammar version, file version, resolution context and overlay the fact
 * came from, whether a precise edge is stored for it, and which compiler resolved it; given the `answer_id` of an earlier
 * answer it reports what the flight recorder remembers of that answer and a summary of up to five of its facts.
 *
 * It is read-only and cheap: it asks the Fact Store reader to explain a handle (`Reader.provenance`, which reads only stored
 * rows) and the tenant's ports for the tier and the recorded answer. It never runs a resolver, never starts the compiler
 * worker and never writes. Repository text appears in the explanation only as fact data (a path, a name, a kind), cleaned like
 * every other structured field; every sentence is fixed. Source text is never returned, so there is no `untrusted_text`.
 */
import { UnknownWorktree, parseHandle } from '../fact-store/index.ts';
import type { FactExplanation } from '../fact-store/index.ts';
import { ANSWER_ID_PATTERN, isDegradedCode, okEnvelope } from '../facts/index.ts';
import type { DegradedCode, Envelope, Watermark } from '../facts/index.ts';
import { cleanField, createCitations } from './cite.ts';
import { CODE_EXPLAIN_SCHEMA, errorEnvelope, withDegraded } from './envelope.ts';
import { notIndexed } from './find.ts';
import type { FindContext } from './find.ts';
import { TOOL_NAMES } from './tools.ts';
import type { CodeExplainInput } from './tools.ts';
import type { TierInfo } from './types.ts';

/** The answers of this module's failures. Fixed sentences: none of them contains anything the caller supplied. */
export const EXPLAIN_MESSAGES = {
  invalid_handle: 'That handle is not a fact handle of this repository index. Pass the debug value of a citation unchanged.',
  stale_handle: 'The file behind that handle has changed since the handle was issued. Ask the question again to get a current handle.',
  answer_not_found: 'No recorded answer has that id. The recorder keeps only the newest answers of this repository.',
  exactly_one: 'Give exactly one of handle and answer_id.',
  bad_answer_id: 'answer_id is not an answer id. Pass the answer_id of an earlier answer unchanged.',
} as const;

/** How many of an answer's facts are summarised. */
export const MAX_ANSWER_FACTS = 5;

/** What the tier information says when no tenant port was given. */
const NO_PORT_TIER: TierInfo = { precise: 'inactive', reason: 'no precise tier is configured for this repository' };

/** The part of a request context `code_explain` uses (a {@link FindContext} satisfies it). */
export type ExplainContext = Pick<FindContext, 'deps' | 'config' | 'worktree' | 'reader' | 'nonce'>;

const BUCKET = /^(?:le[0-9]{1,5}|inf)$/;
const OUTCOME = /^[a-z][a-z0-9_]{0,63}$/;

async function tierInfoOf(ctx: ExplainContext): Promise<TierInfo> {
  const port = ctx.deps.explain;
  if (port === undefined) return NO_PORT_TIER;
  try {
    return await port.tierInfo(ctx.worktree);
  } catch {
    // The port reads state the tenant holds; if it fails the tier is simply not reported as running.
    return { precise: 'inactive', reason: 'the state of the precise tier could not be read' };
  }
}

/** The tier part of `data`: the grammar tier is always on; the precise tier is one of five states. */
function tiersOf(info: TierInfo): Record<string, unknown> {
  return {
    grammar: 'active',
    precise: info.precise,
    ...(info.reason === undefined ? {} : { reason: info.reason }),
    ...(info.code === undefined ? {} : { code: info.code }),
    ...(info.compiler === undefined
      ? {}
      : {
          compiler: {
            name: cleanField(info.compiler.name),
            version: cleanField(info.compiler.version),
            source: info.compiler.source,
            case: cleanField(info.compiler.case),
            ...(info.compiler.reason === undefined ? {} : { reason: cleanField(info.compiler.reason) }),
          },
        }),
  };
}

/** The explanation with the repository's strings cleaned and, when the module reports another grammar version now, both versions. */
function presented(explanation: FactExplanation, currentGrammar: string | undefined): FactExplanation {
  const { fact, resolution, overlay } = explanation;
  const older = currentGrammar !== undefined && currentGrammar !== fact.grammarVersion;
  return {
    ...explanation,
    fact: {
      ...fact,
      extractor: cleanField(fact.extractor),
      module: cleanField(fact.module),
      grammarVersion: cleanField(fact.grammarVersion),
      path: cleanField(fact.path),
      stale: fact.stale || older,
      ...(older ? { currentGrammarVersion: cleanField(currentGrammar) } : {}),
    },
    resolution:
      resolution === null
        ? null
        : {
            ...resolution,
            contextId: cleanField(resolution.contextId),
            ...(resolution.resolver === undefined ? {} : { resolver: cleanField(resolution.resolver) }),
            ...(resolution.target === undefined
              ? {}
              : { target: { name: cleanField(resolution.target.name), kind: cleanField(resolution.target.kind), path: cleanField(resolution.target.path) } }),
          },
    overlay: { ...overlay, worktree: cleanField(overlay.worktree) },
  };
}

const laterOf = (a: Watermark | undefined, b: Watermark): Watermark => (a === undefined || b.seq > a.seq ? b : a);

/** The codes the explanation itself adds: a compiler other than the project's did the resolving, or the tier needs approval. */
function tierCodes(explanation: FactExplanation | null, info: TierInfo): DegradedCode[] {
  const codes: DegradedCode[] = [];
  if (explanation?.fact.tier === 'precise' && info.compiler?.source === 'bundled') codes.push('compiler_fallback');
  if (info.precise === 'needs_approval') codes.push('needs_approval');
  return codes;
}

async function explainFact(ctx: ExplainContext, handle: string): Promise<Envelope> {
  const { reader, config } = ctx;
  const read = await reader.provenance(handle);
  if (read.data === null) return errorEnvelope('invalid_handle', EXPLAIN_MESSAGES.invalid_handle);
  if (read.data === 'stale') return errorEnvelope('stale_handle', EXPLAIN_MESSAGES.stale_handle);

  const info = await tierInfoOf(ctx);
  const explanation = presented(read.data, ctx.deps.explain?.grammarVersion(read.data.fact.module));
  const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
  cites.add({ path: explanation.fact.path, span: explanation.fact.span, confidence: explanation.fact.confidence, debug: explanation.handle, line: { kind: 'unavailable' } });

  const envelope = okEnvelope(CODE_EXPLAIN_SCHEMA, { explanation, tiers: tiersOf(info) }, [], {
    citations: cites.citations,
    watermark: read.watermark,
  });
  return withDegraded(envelope, [...(read.degraded ?? []), ...tierCodes(explanation, info)]);
}

/** A recorded string kept only when it is of the closed shape it should have; anything else reads as `unknown`. */
const closed = (value: unknown, pattern: RegExp): string => (typeof value === 'string' && pattern.test(value) ? value : 'unknown');

async function explainAnswer(ctx: ExplainContext, id: string): Promise<Envelope> {
  if (!ANSWER_ID_PATTERN.test(id)) return errorEnvelope('invalid_args', EXPLAIN_MESSAGES.bad_answer_id);
  const recorded = ctx.deps.explain?.answer(id) ?? null;
  if (recorded === null) return errorEnvelope('answer_not_found', EXPLAIN_MESSAGES.answer_not_found);

  let watermark: Watermark | undefined;
  const degraded = new Set<DegradedCode>();
  const facts: Record<string, unknown>[] = [];
  const handles = Array.isArray(recorded.handles) ? recorded.handles.slice(0, MAX_ANSWER_FACTS) : [];
  for (const raw of handles) {
    const parsed = typeof raw === 'string' ? parseHandle(raw) : null;
    if (parsed === null || typeof raw !== 'string') {
      facts.push({ status: 'unknown' });
      continue;
    }
    const read = await ctx.reader.provenance(raw);
    watermark = laterOf(watermark, read.watermark);
    for (const code of read.degraded ?? []) degraded.add(code);
    if (read.data === null) facts.push({ handle: raw, status: 'unknown' });
    else if (read.data === 'stale') facts.push({ handle: raw, status: 'stale' });
    else facts.push({ handle: raw, status: 'ok', kind: read.data.kind, tier: read.data.fact.tier, confidence: read.data.fact.confidence });
  }
  if (watermark === undefined) {
    // No fact was read: one empty read still reports the watermark, and an unknown worktree.
    const probe = await ctx.reader.provenance('');
    watermark = probe.watermark;
    for (const code of probe.degraded ?? []) degraded.add(code);
  }

  const info = await tierInfoOf(ctx);
  const answer = {
    id,
    tool: (TOOL_NAMES as readonly string[]).includes(recorded.tool) ? recorded.tool : 'unknown',
    outcome: closed(recorded.outcome, OUTCOME),
    latency: closed(recorded.ms, BUCKET),
    degraded: (Array.isArray(recorded.degraded) ? recorded.degraded : []).filter((code): code is DegradedCode => typeof code === 'string' && isDegradedCode(code)),
    results: Number.isSafeInteger(recorded.count) && recorded.count >= 0 ? recorded.count : 0,
  };
  const envelope = okEnvelope(CODE_EXPLAIN_SCHEMA, { answer, facts, tiers: tiersOf(info) }, [], { watermark });
  return withDegraded(envelope, [...degraded, ...(info.precise === 'needs_approval' ? (['needs_approval'] as const) : [])]);
}

/**
 * Answer a `code_explain` request whose arguments were checked against the tool's schema. Exactly one of `handle` and
 * `answer_id` must be there. Every outcome is an envelope.
 */
export async function runExplain(ctx: ExplainContext, input: CodeExplainInput): Promise<Envelope> {
  const hasHandle = input.handle !== undefined;
  const hasAnswer = input.answer_id !== undefined;
  if (hasHandle === hasAnswer) return errorEnvelope('invalid_args', EXPLAIN_MESSAGES.exactly_one);
  try {
    return hasHandle ? await explainFact(ctx, input.handle as string) : await explainAnswer(ctx, input.answer_id as string);
  } catch (error) {
    if (error instanceof UnknownWorktree) return notIndexed();
    throw error;
  }
}
