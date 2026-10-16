/**
 * `code_find`: where is this symbol defined. The Reader supplies definitions, the store supplies positions
 * (0-based) and Source Tree supplies the matched line. Positions leave Query 1-based, the way an editor shows
 * them (the store keeps 0-based lines and UTF-16 columns).
 */
import { UnknownWorktree } from '../fact-store/index.ts';
import type { SymbolRecord } from '../fact-store/index.ts';
import type { Answer, Citation, DegradedCode, Envelope, UntrustedEntry } from '../facts/index.ts';
import { diagnostic, okEnvelope } from '../facts/index.ts';
import { CODE_FIND_SCHEMA, errorWith, withDegraded } from './envelope.ts';
import { FIELD_MAX_CHARS, fenceText, normalizeText } from './fence.ts';
import { createLineReader } from './text.ts';
import type { CodeFindInput } from './tools.ts';
import type { QueryConfig, QueryDeps } from './types.ts';

export interface FindContext {
  readonly deps: QueryDeps;
  readonly config: QueryConfig;
  readonly worktree: string;
  /** The nonce of this response. */
  readonly nonce: string;
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

function simpleName(record: SymbolRecord): string {
  const qualified = record.identity.qualifiedName;
  const dot = qualified.lastIndexOf('.');
  return dot < 0 ? qualified : qualified.slice(dot + 1);
}

export async function runFind(ctx: FindContext, input: CodeFindInput): Promise<Envelope> {
  let answer: Answer<readonly SymbolRecord[]>;
  try {
    answer = await ctx.deps.store.at(ctx.worktree).find(input.name, { mode: 'exact' });
  } catch (error) {
    if (error instanceof UnknownWorktree) return notIndexed();
    throw error;
  }

  const lines = createLineReader(ctx.deps.text, ctx.worktree, new Set(answer.watermark.stalePaths));
  const results: FoundResult[] = [];
  const citations: Citation[] = [];
  const entries: UntrustedEntry[] = [];
  const degraded = new Set<DegradedCode>(answer.degraded ?? []);

  for (const record of answer.data) {
    const id = `c${String(citations.length + 1)}`;
    const line = await lines.lineAt(record.source_path, record.span);
    let textRef: string | undefined;
    if (line.kind === 'ok') {
      textRef = `ut${String(entries.length + 1)}`;
      entries.push({ ref: textRef, text: fenceText(line.text, ctx.nonce, ctx.config.lineTextMaxChars) });
    } else {
      degraded.add('stale');
    }
    const path = clean(record.source_path);
    const startLine = record.span.startLine + 1;
    const startCol = record.span.startColumn + 1;
    citations.push({
      id,
      path,
      line: startLine,
      col: startCol,
      endLine: record.span.endLine + 1,
      endCol: record.span.endColumn + 1,
      confidence: record.confidence,
      debug: record.debug,
      ...(textRef === undefined ? {} : { text_ref: textRef }),
    });
    results.push({
      name: clean(simpleName(record)),
      kind: clean(record.identity.kind),
      path,
      line: startLine,
      col: startCol,
      ...(record.exported === undefined ? {} : { exported: record.exported }),
      confidence: record.confidence,
      citation: id,
    });
  }

  const envelope = okEnvelope(CODE_FIND_SCHEMA, { results }, [], {
    ...(citations.length === 0 ? {} : { citations }),
    watermark: answer.watermark,
    ...(entries.length === 0 ? {} : { untrusted_text: { nonce: ctx.nonce, entries } }),
    ...(results.length === 0 ? { hints: [NO_MATCH_HINT] } : {}),
  });
  return withDegraded(envelope, degraded);
}
