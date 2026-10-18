/**
 * `kind: adr` (plan 03-28, TSM-04, D-19, D-20): which code cites ADR N, and where ADR N is.
 *
 * - `code_refs` with `kind: adr` lists the citation sites of a number (path, line, column, the section detail, the symbol the
 *   mention is attached to), each with the resolution status and the ADR files in the data.
 * - `code_find` with `kind: adr` returns the ADR file or files for a number, or the `unresolved` status with how many citations
 *   exist, so a question about a missing document is answered "not found" truthfully.
 *
 * Resolution is a read-time join of the stored citation (a number) with the repository's ADR directory (names only; ADR contents
 * are never read, indexed or returned). One file gives an `EXTRACTED` link, several give one `INFERRED` link each, and none gives
 * a citation that stays visible and is marked `unresolved`; it is never dropped.
 *
 * Everything that is a sentence here is fixed text. Repository names (paths, symbol names) appear only as field values, cleaned.
 */
import path from 'node:path';
import { UnknownWorktree } from '../fact-store/index.ts';
import type { CitationRecord } from '../fact-store/index.ts';
import type { Confidence, DegradedCode, Envelope, Watermark } from '../facts/index.ts';
import { okEnvelope } from '../facts/index.ts';
import { cleanField, createCitations, memoLineText } from './cite.ts';
import { CODE_FIND_SCHEMA, CODE_REFS_SCHEMA, errorEnvelope, withDegraded } from './envelope.ts';
import { CURSOR_TOO_LONG_HINT, OUTPUT_TOO_LARGE_MESSAGE, TRUNCATED_HINT, notIndexed } from './find.ts';
import type { FindContext } from './find.ts';
import { pageItems } from './page.ts';
import type { PageState } from './page.ts';
import { compareRanked, cwdHintDir, directoryDistance, sortKeyOf } from './ranking.ts';
import type { SortKey } from './ranking.ts';
import { createLineReader } from './text.ts';
import type { CodeFindInput, CodeRefsInput } from './tools.ts';
import type { AdrLookup, AdrStatus, QueryDeps } from './types.ts';

/** The `kind` argument of `code_find` and `code_refs` that asks about ADRs instead of symbols. */
export const ADR_KIND = 'adr';

/** The one refusal of a name that is not an ADR number. It never echoes the name. */
export const INVALID_ADR_NAME_MESSAGE = 'With kind adr the name must be an ADR number such as ADR-3473, adr 3473, ADR #3473, #3473 or 3473.';

/** A citation list is read up to this multiple of the maximum limit per request (the bound of T-02-55). */
const CANDIDATE_FACTOR = 4;

export const NO_CITATION_HINT =
  'No code comment cites this ADR number in the index. A comment is read only in a language module that supports it; run "gsd-atlas build" if the repository changed since it was indexed.';
export const NO_ADR_FILE_HINT =
  'No ADR file with this number was found in the repository\'s ADR directory. data.citations says how many code comments cite it; use code_refs with kind adr to list them.';
export const CITATIONS_CAPPED_HINT = 'More comments cite this ADR than one answer can count or rank. The list is cut; narrow the question by asking about a file.';

/** The most digits of an ADR number a name may carry: 11 digits are always a safe integer, and a longer run is not a number to ask for. */
const MAX_NAME_DIGITS = 11;

/**
 * The ADR number a name asks about: `ADR-3473`, `adr 3473`, `ADR #3473`, `ADR#3473`, `#3473`, `3473` and `ADR-03473` are all
 * 3473 (a number is compared by value). Anything else is refused, as is zero and a run of more than 11 digits. The same four
 * `ADR` spellings the extractor reads in comments are the ones accepted here, so a question uses the forms the code uses.
 */
export function normaliseAdrName(text: string): number | null {
  const match = new RegExp(`^(?:adr(?:-| #|#| )|#)?([0-9]{1,${String(MAX_NAME_DIGITS)}})$`, 'i').exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The ADR files a number names, from the Tenant's port. No port, or one that fails, knows no file; a failure also says it may be incomplete. */
export async function lookupAdr(deps: Pick<QueryDeps, 'adr'>, worktree: string, number: number): Promise<AdrLookup> {
  const port = deps.adr;
  if (port === undefined) return { status: 'unresolved', files: [] };
  try {
    return await port.lookup(worktree, number);
  } catch {
    return { status: 'unresolved', files: [], listTruncated: true };
  }
}

/** The confidence of the link from a citation to its ADR file: one file is `EXTRACTED`; several, or none, are not. */
export const linkConfidence = (status: AdrStatus): Confidence => (status === 'resolved' ? 'EXTRACTED' : 'INFERRED');

/** The `adr` object of the data: the number, its status and the files (cleaned); `listTruncated` only when it is true. */
export function adrData(number: number, lookup: AdrLookup): Record<string, unknown> {
  return {
    number,
    status: lookup.status,
    files: lookup.files.map(cleanField),
    ...(lookup.listTruncated === true ? { listTruncated: true } : {}),
  };
}

const lastSegment = (qualifiedName: string): string => {
  const dot = qualifiedName.lastIndexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
};

/** The handle an ADR file's citation carries. It names a document, not a fact of the index, so `code_explain` does not accept it. */
const adrFileHandle = (file: string): string => `adr/${encodeURIComponent(file)}`;

interface CitationItem {
  readonly record: CitationRecord;
  readonly key: SortKey;
}

export interface CitationRow {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly detail?: string;
  readonly attachedTo: string | null;
  readonly confidence: Confidence;
  readonly citation: string;
}

/** `code_refs` with `kind: adr`: every stored citation of the number, with the status and the ADR files of the number. */
export async function runAdrRefs(ctx: FindContext, input: CodeRefsInput): Promise<Envelope> {
  const number = normaliseAdrName(input.name);
  if (number === null) return errorEnvelope('invalid_args', INVALID_ADR_NAME_MESSAGE);
  const { config, reader } = ctx;
  try {
    const candidateLimit = config.maxLimit * CANDIDATE_FACTOR;
    const found = await reader.citations({ number }, { limit: candidateLimit });
    const lookup = await lookupAdr(ctx.deps, ctx.worktree, number);
    const confidence = linkConfidence(lookup.status);
    const capped = found.data.length >= candidateLimit;
    const watermark: Watermark = found.watermark;
    const hint = cwdHintDir(ctx.worktree, input.cwd);

    const items: CitationItem[] = found.data
      .map((record) => {
        const dir = path.posix.dirname(record.source_path);
        return {
          record,
          key: sortKeyOf({
            tier: 0,
            isReference: false,
            confidence,
            exported: false,
            distance: directoryDistance(dir === '.' ? '' : dir, hint),
            path: record.source_path,
            line: record.span.startLine,
            col: record.span.startColumn,
            handle: record.debug,
          }),
        };
      })
      .sort((a, b) => compareRanked(a.key, b.key));

    const lines = createLineReader(ctx.deps.text, ctx.worktree, new Set([...watermark.stalePaths, ...ctx.fresh.stalePaths]));
    const textOf = memoLineText<CitationItem>(lines);

    const render = async (kept: readonly CitationItem[], state: PageState): Promise<Envelope> => {
      const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
      const results: CitationRow[] = [];
      for (const item of kept) {
        const { record } = item;
        const line = await textOf(item, record.source_path, record.span);
        const id = cites.add({ path: record.source_path, span: record.span, confidence, debug: record.debug, line });
        results.push({
          path: cleanField(record.source_path),
          line: record.span.startLine + 1,
          col: record.span.startColumn + 1,
          ...(record.detail === undefined ? {} : { detail: cleanField(record.detail) }),
          attachedTo: record.enclosing === null ? null : cleanField(lastSegment(record.enclosing.qualifiedName)),
          confidence,
          citation: id,
        });
      }
      const codes = new Set<DegradedCode>([...ctx.fresh.degraded, ...(found.degraded ?? []), ...state.degraded]);
      if (cites.lacksText()) codes.add('stale');

      const hints: string[] = [];
      if (results.length === 0 && !state.cut) hints.push(NO_CITATION_HINT);
      if (state.cut) hints.push(state.more === null ? CURSOR_TOO_LONG_HINT : TRUNCATED_HINT);
      if (capped) hints.push(CITATIONS_CAPPED_HINT);

      const envelope = okEnvelope(CODE_REFS_SCHEMA, { adr: adrData(number, lookup), results }, [...ctx.fresh.diagnostics, ...(lookup.diagnostics ?? [])], {
        ...(cites.citations.length === 0 ? {} : { citations: cites.citations }),
        watermark,
        ...(cites.entries.length === 0 ? {} : { untrusted_text: { nonce: ctx.nonce, entries: cites.entries } }),
        ...(state.cut || capped ? { truncated: true } : {}),
        ...(state.more === null ? {} : { more: state.more }),
        ...(hints.length === 0 ? {} : { hints }),
      });
      return withDegraded(envelope, codes);
    };

    const page = await pageItems(items, {
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
  } catch (error) {
    if (error instanceof UnknownWorktree) return notIndexed();
    throw error;
  }
}

interface FileItem {
  readonly file: string;
  readonly key: SortKey;
}

/**
 * `code_find` with `kind: adr`: the ADR file or files the number names (path, number, the citation at line 1 of the file, no
 * text because ADR contents are never read), the status, and how many code comments cite the number.
 */
export async function runAdrFind(ctx: FindContext, input: CodeFindInput): Promise<Envelope> {
  const number = normaliseAdrName(input.name);
  if (number === null) return errorEnvelope('invalid_args', INVALID_ADR_NAME_MESSAGE);
  const { config, reader } = ctx;
  try {
    const candidateLimit = config.maxLimit * CANDIDATE_FACTOR;
    const found = await reader.citations({ number }, { limit: candidateLimit });
    const lookup = await lookupAdr(ctx.deps, ctx.worktree, number);
    const confidence = linkConfidence(lookup.status);
    const capped = found.data.length >= candidateLimit;
    const watermark = found.watermark;

    const items: FileItem[] = lookup.files.map((file) => ({
      file,
      key: sortKeyOf({ tier: 0, isReference: false, confidence, exported: false, distance: 0, path: file, line: 0, col: 0, handle: adrFileHandle(file) }),
    }));
    items.sort((a, b) => compareRanked(a.key, b.key));

    const render = (kept: readonly FileItem[], state: PageState): Envelope => {
      const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
      const results: Array<Record<string, unknown>> = [];
      for (const item of kept) {
        // The document itself is never read, so its citation has no text; it points at the first line of the file.
        const id = cites.add({
          path: item.file,
          span: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
          confidence,
          debug: adrFileHandle(item.file),
          line: { kind: 'unavailable' },
        });
        results.push({ path: cleanField(item.file), number, confidence, citation: id });
      }
      const codes = new Set<DegradedCode>([...ctx.fresh.degraded, ...(found.degraded ?? []), ...state.degraded]);

      const hints: string[] = [];
      if (lookup.status === 'unresolved') hints.push(NO_ADR_FILE_HINT);
      if (state.cut) hints.push(state.more === null ? CURSOR_TOO_LONG_HINT : TRUNCATED_HINT);
      if (capped) hints.push(CITATIONS_CAPPED_HINT);

      const data = {
        number,
        status: lookup.status,
        citations: found.data.length,
        ...(lookup.listTruncated === true ? { listTruncated: true } : {}),
        results,
      };
      const envelope = okEnvelope(CODE_FIND_SCHEMA, data, [...ctx.fresh.diagnostics, ...(lookup.diagnostics ?? [])], {
        ...(cites.citations.length === 0 ? {} : { citations: cites.citations }),
        watermark,
        ...(state.cut || capped ? { truncated: true } : {}),
        ...(state.more === null ? {} : { more: state.more }),
        ...(hints.length === 0 ? {} : { hints }),
      });
      return withDegraded(envelope, codes);
    };

    const page = await pageItems(items, {
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
  } catch (error) {
    if (error instanceof UnknownWorktree) return notIndexed();
    throw error;
  }
}
