/**
 * `code_find`: where is this symbol defined. The Reader supplies definitions (positions 0-based, as the store
 * keeps them), Source Tree supplies the matched line, and this file ranks, cuts to the budget and pages.
 * Positions leave Query 1-based, the way an editor shows them.
 *
 * Paging is keyset: every call re-queries the store and resumes strictly after the cursor's sort key, so the
 * server holds nothing between calls. The candidate set is bounded (four times the maximum limit per read); a
 * request that hits the bound says so with `truncated` and a hint rather than cutting silently.
 */
import path from 'node:path';
import { UnknownWorktree } from '../fact-store/index.ts';
import type { FindMode, Reader, SymbolRecord } from '../fact-store/index.ts';
import type { Answer, DegradedCode, Diagnostic, Envelope, Watermark } from '../facts/index.ts';
import { diagnostic, okEnvelope } from '../facts/index.ts';
import { createCitations, memoLineText } from './cite.ts';
import type { CursorPayload } from './cursor.ts';
import { CODE_FIND_SCHEMA, errorEnvelope, errorWith, withDegraded } from './envelope.ts';
import { FIELD_MAX_CHARS, normalizeText } from './fence.ts';
import { pageItems } from './page.ts';
import type { PageState } from './page.ts';
import { compareRanked, cwdHintDir, directoryDistance, nameAndTier, sortKeyOf } from './ranking.ts';
import type { SortKey } from './ranking.ts';
import { createLineReader } from './text.ts';
import type { CodeFindInput } from './tools.ts';
import type { QueryConfig, QueryDeps } from './types.ts';

/** What the `fresh` step contributed to a response (see `freshOutcome` in query.ts). */
export interface FreshOutcome {
  readonly degraded: readonly DegradedCode[];
  readonly diagnostics: readonly Diagnostic[];
  /** Paths the Indexer could not finish: the file on disk is newer than the facts, so its line text is not trusted. */
  readonly stalePaths: readonly string[];
  /** The follower overlay the fresh port built for this request, when it built one (see `FreshReport.reader`). */
  readonly reader?: Reader;
}

export interface FindContext {
  readonly deps: QueryDeps;
  readonly config: QueryConfig;
  readonly worktree: string;
  readonly fresh: FreshOutcome;
  /** The one Reader every read of this request goes through: the fresh port's overlay, else the store's (query.ts). */
  readonly reader: Reader;
  /** The nonce of this response. */
  readonly nonce: string;
  /** The hash of this query, carried by every cursor it issues. */
  readonly queryHash: string;
  /** The decoded `more` cursor of this request, when it sent one. */
  readonly cursor: CursorPayload | null;
}

/** One entry of `data.results`. */
export interface FoundResult {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly exported?: boolean;
  readonly confidence: string;
  /** The `id` of the citation that carries this result's debug handle and text reference. */
  readonly citation: string;
}

export const NO_MATCH_HINT =
  'No definition matched this name. Check the spelling, try mode "fuzzy", or run "gsd-atlas build" if the repository changed since it was indexed.';
export const TRUNCATED_HINT = 'Results were cut to fit the budget or the limit. Pass the "more" value from this response to get the next page.';
export const CURSOR_TOO_LONG_HINT =
  'Results were cut, but a path is too long to continue from. Narrow the query with kind or a longer name instead.';
export const CAPPED_HINT = 'More definitions match than one answer can rank. Narrow the query with kind or a longer name.';
export const OUTPUT_TOO_LARGE_MESSAGE = 'A single result is larger than the output ceiling. Narrow the query with kind or a longer name.';

/** Candidates read per read mode, as a multiple of the maximum limit (the bound of T-02-55). */
const CANDIDATE_FACTOR = 4;

export function notIndexed(): Envelope {
  return errorWith([
    diagnostic(
      'not_indexed',
      'error',
      'This repository has not been indexed yet. Run "gsd-atlas build" in it, then ask again.',
    ),
  ]);
}

const clean = (value: string): string => normalizeText(value, FIELD_MAX_CHARS);

/** The reads a mode asks of the Reader. Fuzzy reads need three characters; shorter queries get exact and prefix. */
function readsFor(mode: NonNullable<CodeFindInput['mode']>, name: string): FindMode[] {
  if (mode === 'exact') return ['exact'];
  if (mode === 'prefix') return ['exact', 'prefix'];
  return name.length >= 3 ? ['exact', 'prefix', 'fuzzy'] : ['exact', 'prefix'];
}

interface Ranked {
  readonly record: SymbolRecord;
  readonly name: string;
  readonly key: SortKey;
}

export async function runFind(ctx: FindContext, input: CodeFindInput): Promise<Envelope> {
  const { config } = ctx;
  const reads = readsFor(input.mode ?? 'auto', input.name);
  const candidateLimit = config.maxLimit * CANDIDATE_FACTOR;
  const { reader } = ctx;

  let answers: Answer<readonly SymbolRecord[]>[];
  try {
    answers = await Promise.all(reads.map((mode) => reader.find(input.name, { mode, limit: candidateLimit })));
  } catch (error) {
    if (error instanceof UnknownWorktree) return notIndexed();
    throw error;
  }

  // One entry per debug handle; a definition the exact read returned is remembered as exact.
  const found = new Map<string, { record: SymbolRecord; exact: boolean }>();
  for (const [index, answer] of answers.entries()) {
    for (const record of answer.data) {
      const known = found.get(record.debug);
      if (known === undefined) found.set(record.debug, { record, exact: reads[index] === 'exact' });
      else if (reads[index] === 'exact') known.exact = true;
    }
  }
  const capped = answers.some((answer) => answer.data.length >= candidateLimit);

  let watermark: Watermark = answers[0]?.watermark ?? { seq: 0, stalePaths: [] };
  const degraded = new Set<DegradedCode>(ctx.fresh.degraded);
  for (const answer of answers) {
    if (answer.watermark.seq > watermark.seq) watermark = answer.watermark;
    for (const code of answer.degraded ?? []) degraded.add(code);
  }

  const hint = cwdHintDir(ctx.worktree, input.cwd);
  const ranked: Ranked[] = [];
  for (const { record, exact } of found.values()) {
    if (input.kind !== undefined && record.identity.kind !== input.kind) continue;
    const { name, tier } = nameAndTier(record.identity.qualifiedName, input.name, exact);
    const dir = path.posix.dirname(record.source_path);
    const key = sortKeyOf({
      tier,
      isReference: false,
      confidence: record.confidence,
      exported: record.exported === true,
      distance: directoryDistance(dir === '.' ? '' : dir, hint),
      path: record.source_path,
      line: record.span.startLine,
      col: record.span.startColumn,
      handle: record.debug,
    });
    ranked.push({ record, name, key });
  }
  ranked.sort((a, b) => compareRanked(a.key, b.key));

  const lines = createLineReader(ctx.deps.text, ctx.worktree, new Set([...watermark.stalePaths, ...ctx.fresh.stalePaths]));
  const textOf = memoLineText<Ranked>(lines);

  /** The response that carries exactly `kept`, marked as cut as `state` says. */
  const render = async (kept: readonly Ranked[], state: PageState): Promise<Envelope> => {
    const results: FoundResult[] = [];
    const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
    const codes = new Set<DegradedCode>([...degraded, ...state.degraded]);
    for (const item of kept) {
      const { record } = item;
      const line = await textOf(item, record.source_path, record.span);
      const id = cites.add({ path: record.source_path, span: record.span, confidence: record.confidence, debug: record.debug, line });
      results.push({
        name: clean(item.name),
        kind: clean(record.identity.kind),
        path: clean(record.source_path),
        line: record.span.startLine + 1,
        col: record.span.startColumn + 1,
        ...(record.exported === undefined ? {} : { exported: record.exported }),
        confidence: record.confidence,
        citation: id,
      });
    }
    if (cites.lacksText()) codes.add('stale');

    const hints: string[] = [];
    if (results.length === 0) hints.push(NO_MATCH_HINT);
    else if (state.cut) hints.push(state.more === null ? CURSOR_TOO_LONG_HINT : TRUNCATED_HINT);
    if (capped) hints.push(CAPPED_HINT);

    const envelope = okEnvelope(CODE_FIND_SCHEMA, { results }, ctx.fresh.diagnostics, {
      ...(cites.citations.length === 0 ? {} : { citations: cites.citations }),
      watermark,
      ...(cites.entries.length === 0 ? {} : { untrusted_text: { nonce: ctx.nonce, entries: cites.entries } }),
      ...(state.cut || capped ? { truncated: true } : {}),
      ...(state.more === null ? {} : { more: state.more }),
      ...(hints.length === 0 ? {} : { hints }),
    });
    return withDegraded(envelope, codes);
  };

  const page = await pageItems(ranked, {
    budgetTokens: input.budget_tokens ?? config.defaultBudgetTokens,
    ceilingTokens: config.hardCeilingTokens,
    limit: Math.min(input.limit ?? config.defaultLimit, config.maxLimit),
    cursor: ctx.cursor,
    cursorMaxChars: config.cursorMaxChars,
    queryHash: ctx.queryHash,
    watermarkSeq: watermark.seq,
    renderEnvelope: render,
  });
  if (page.envelope === null) return errorEnvelope('output_too_large', OUTPUT_TOO_LARGE_MESSAGE);
  return page.envelope;
}
