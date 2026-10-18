/**
 * `code_refs`: who refers to this symbol. The definitions that match the name (narrowed by `path` and `kind`) are
 * the targets; every target gets its references from the Reader, which scopes name-matched sites by file, import
 * binding and export alias, lets a precise edge supersede a grammar one, and marks a site that could point at
 * several definitions with a candidate count. Nothing is guessed: a name-matched edge shows `INFERRED`, and a
 * site that two targets could own is listed under both, never merged.
 *
 * The gathering functions are shared with `code_context`, which lists the best-ranked definition's references.
 */
import path from 'node:path';
import { UnknownWorktree } from '../fact-store/index.ts';
import type { Reader, RefRecord, RelationRecord, SymbolRecord } from '../fact-store/index.ts';
import type { Answer, DegradedCode, Envelope, RefKind, SymbolIdentity, Watermark } from '../facts/index.ts';
import { okEnvelope, symbolKey } from '../facts/index.ts';
import { cleanField, createCitations, memoLineText } from './cite.ts';
import { CODE_REFS_SCHEMA, errorEnvelope, withDegraded } from './envelope.ts';
import { CURSOR_TOO_LONG_HINT, OUTPUT_TOO_LARGE_MESSAGE, TRUNCATED_HINT, notIndexed } from './find.ts';
import type { FindContext } from './find.ts';
import { pageItems } from './page.ts';
import type { PageState } from './page.ts';
import { compareRanked, cwdHintDir, directoryDistance, refKeyOf, sortKeyOf } from './ranking.ts';
import type { SortKey } from './ranking.ts';
import { createLineReader } from './text.ts';
import type { CodeRefsInput } from './tools.ts';
import type { Edge } from './types.ts';

/** Definitions followed per request (T-02-65): the best-ranked five, with a hint when more matched. */
export const MAX_TARGETS = 5;

/** Definitions read per request, as a multiple of the maximum limit (the bound of T-02-55). */
const CANDIDATE_FACTOR = 4;

export const NO_DEFINITION_HINT =
  'No definition matched this name. Check the spelling, drop path or kind if they may be wrong, or run "gsd-atlas build" if the repository changed since it was indexed.';
export const NO_REFERENCE_HINT =
  'No reference to this definition was found. The index follows imports and uses inside the defining file; a call through a computed name is not seen.';
export const TARGETS_CAPPED_HINT = 'More definitions share this name than one answer follows. Narrow the query with path or kind.';

/** A definition a request asks about, with the key that ranks it. */
export interface Target {
  readonly record: SymbolRecord;
  readonly key: SortKey;
}

/** The newer of two watermarks (a higher seq is a later state of the store). */
export function laterOf(a: Watermark, b: Watermark): Watermark {
  return b.seq > a.seq ? b : a;
}

export interface TargetSearch {
  /** The best-ranked definitions, at most `max`. */
  readonly targets: readonly Target[];
  /** True when more definitions matched than were kept, or the read itself was bounded. */
  readonly capped: boolean;
  readonly watermark: Watermark;
  readonly degraded: readonly DegradedCode[];
}

/** A repo-relative POSIX path from what a caller typed: separators unified, leading `./` and trailing `/` removed. */
function normalizeRepoPath(value: string): string {
  const normal = path.posix.normalize(value.split(path.sep).join('/'));
  return normal.startsWith('./') ? normal.slice(2) : normal;
}

/**
 * The definitions named exactly `name`, narrowed by `path` and `kind`, ranked like `code_find` ranks an exact
 * match (exported first, nearer to the cwd hint, then position) and cut to `max`.
 */
export async function findTargets(
  reader: Reader,
  ctx: FindContext,
  query: { readonly name: string; readonly path?: string | undefined; readonly kind?: string | undefined; readonly cwd?: string | undefined },
  max: number,
): Promise<TargetSearch> {
  const candidateLimit = ctx.config.maxLimit * CANDIDATE_FACTOR;
  const answer: Answer<readonly SymbolRecord[]> = await reader.find(query.name, { mode: 'exact', limit: candidateLimit });
  const wantedPath = query.path === undefined ? undefined : normalizeRepoPath(query.path);
  const hint = cwdHintDir(ctx.worktree, query.cwd);

  const ranked: Target[] = [];
  for (const record of answer.data) {
    if (wantedPath !== undefined && record.source_path !== wantedPath) continue;
    if (query.kind !== undefined && record.identity.kind !== query.kind) continue;
    const dir = path.posix.dirname(record.source_path);
    ranked.push({
      record,
      key: sortKeyOf({
        tier: 0,
        isReference: false,
        confidence: record.confidence,
        exported: record.exported === true,
        distance: directoryDistance(dir === '.' ? '' : dir, hint),
        path: record.source_path,
        line: record.span.startLine,
        col: record.span.startColumn,
        handle: record.debug,
      }),
    });
  }
  ranked.sort((a, b) => compareRanked(a.key, b.key));
  return {
    targets: ranked.slice(0, max),
    capped: ranked.length > max || answer.data.length >= candidateLimit,
    watermark: answer.watermark,
    degraded: answer.degraded ?? [],
  };
}

/** One reference to one target, with the key that ranks it. */
export interface RefItem {
  readonly target: SymbolRecord;
  readonly ref: RefRecord;
  readonly key: SortKey;
  /** What the compiler says this item is; absent for a name-matched (grammar-tier) item. */
  readonly edge?: Edge;
}

/** A reference with the edge it carries, before it is ranked. */
export interface LabelledRef {
  readonly ref: RefRecord;
  readonly edge?: Edge;
}

const lastSegmentOf = (qualifiedName: string): string => {
  const dot = qualifiedName.lastIndexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
};

/** The reference a relation stands for when no reference site of the grammar tier shows it: cited at the subtype's definition. */
function refOfRelation(relation: RelationRecord, named: string, kind: RefKind | undefined): RefRecord {
  return {
    source_path: relation.source_path,
    span: relation.span,
    extractor: relation.extractor,
    content_hash: relation.content_hash,
    first_seen: relation.first_seen,
    last_seen: relation.last_seen,
    confidence: 'EXTRACTED',
    debug: relation.debug,
    site: { path: relation.source_path, span: relation.span, name: named },
    target: relation.to,
    tier: 'precise',
    enclosing: relation.from,
    ...(kind === undefined ? {} : { kind }),
  };
}

/**
 * The references of `target` with the edge each one carries, from the references the Reader returned and the relations that
 * end at `target` (`Reader.relations(target, { direction: 'in' })`).
 *
 * - A precise reference is a `calls` edge when it is a call and a `references` edge otherwise.
 * - A heritage site (`class Sub extends Base`) that a compiler relation names, whatever tier the site came from, is the
 *   `extends` or `implements` edge itself: it becomes a precise `EXTRACTED` item carrying that name. The label comes only
 *   from the relation, never from the name match, so a heritage site no relation names keeps the grammar tier and no edge.
 * - A relation no site shows (the heritage clause names an expression the grammar tier does not see) is added as an item
 *   cited at the subtype; so is every `overrides` relation, which has no reference site at all.
 */
export function labelRefs(target: SymbolIdentity, refs: readonly RefRecord[], relations: readonly RelationRecord[]): LabelledRef[] {
  const targetKey = symbolKey(target);
  const heritage = new Map<string, RelationRecord>();
  for (const relation of relations) {
    if ((relation.relation === 'extends' || relation.relation === 'implements') && symbolKey(relation.to) === targetKey) {
      heritage.set(symbolKey(relation.from), relation);
    }
  }
  const named = new Set<string>();
  const out: LabelledRef[] = [];
  for (const ref of refs) {
    const subtype = ref.kind === 'heritage' && ref.enclosing !== undefined && ref.enclosing !== null ? heritage.get(symbolKey(ref.enclosing)) : undefined;
    if (subtype !== undefined) {
      named.add(symbolKey(subtype.from));
      const { candidates, ...rest } = ref;
      void candidates; // a compiler relation is not ambiguous
      out.push({ ref: { ...rest, extractor: subtype.extractor, confidence: 'EXTRACTED', tier: 'precise' }, edge: subtype.relation });
    } else if (ref.tier === 'precise') {
      out.push({ ref, edge: ref.kind === 'call' ? 'calls' : 'references' });
    } else {
      out.push({ ref });
    }
  }
  for (const relation of relations) {
    if (symbolKey(relation.to) !== targetKey) continue;
    if (relation.relation === 'overrides') {
      out.push({ ref: refOfRelation(relation, lastSegmentOf(relation.from.qualifiedName), undefined), edge: 'overrides' });
    } else if (!named.has(symbolKey(relation.from))) {
      out.push({ ref: refOfRelation(relation, lastSegmentOf(relation.to.qualifiedName), 'heritage'), edge: relation.relation });
    }
  }
  return out;
}

export interface GatheredRefs {
  /** Every reference of every target in the total order. */
  readonly items: readonly RefItem[];
  readonly watermark: Watermark;
  readonly degraded: readonly DegradedCode[];
}

/**
 * The references of each target from the Reader (the approved resolve bound applies to each call), ranked: precise
 * before grammar, EXTRACTED before INFERRED, then call, new, type, heritage, read, member, then the directory
 * nearer to the cwd hint, then path, line, column and the two handles. A site two targets could own appears once
 * per target.
 */
export async function gatherRefs(
  reader: Reader,
  ctx: FindContext,
  targets: readonly Target[],
  cwd: string | undefined,
  start: Watermark,
): Promise<GatheredRefs> {
  const hint = cwdHintDir(ctx.worktree, cwd);
  let watermark = start;
  const degraded = new Set<DegradedCode>();
  const items: RefItem[] = [];
  for (const { record } of targets) {
    const answer = await reader.refs(record.identity, { timeoutMs: ctx.config.resolveTimeoutMs });
    watermark = laterOf(watermark, answer.watermark);
    for (const code of answer.degraded ?? []) degraded.add(code);
    // The compiler's relations that end at the target: they label heritage sites and add the overriding members.
    const related = await reader.relations(record.identity, {
      direction: 'in',
      timeoutMs: ctx.config.resolveTimeoutMs,
      limit: ctx.config.maxLimit * CANDIDATE_FACTOR,
    });
    watermark = laterOf(watermark, related.watermark);
    for (const code of related.degraded ?? []) degraded.add(code);
    for (const { ref, edge } of labelRefs(record.identity, answer.data, related.data)) {
      const dir = path.posix.dirname(ref.source_path);
      items.push({
        target: record,
        ref,
        ...(edge === undefined ? {} : { edge }),
        key: refKeyOf({
          tier: ref.tier,
          confidence: ref.confidence,
          kind: ref.kind,
          distance: directoryDistance(dir === '.' ? '' : dir, hint),
          path: ref.source_path,
          line: ref.span.startLine,
          col: ref.span.startColumn,
          handle: `${ref.debug}\u0000${record.debug}`,
        }),
      });
    }
  }
  items.sort((a, b) => compareRanked(a.key, b.key));
  return { items, watermark, degraded: [...degraded] };
}

/** One entry of `data.results` of `code_refs` (also the shape of a `reference` item of `code_context`, plus its section). */
export interface RefResult {
  /** The debug handle of the definition this reference is to. */
  readonly target: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly kind: string | null;
  /** The qualified name of the symbol that contains the site; null for a top-level site. */
  readonly enclosing: string | null;
  readonly tier: string;
  readonly confidence: string;
  /** True when the site could point at more than one definition. */
  readonly ambiguous: boolean;
  /** How many definitions the site could point at: 1 unless ambiguous. */
  readonly candidates: number;
  /** What the compiler says this item is; absent for a name-matched item (mcp-contract ADR amendment, point 9). */
  readonly edge?: Edge;
  readonly citation: string;
}

export function describeRef(item: RefItem, citation: string): RefResult {
  const { ref } = item;
  const candidates = ref.candidates ?? 1;
  return {
    target: item.target.debug,
    path: cleanField(ref.source_path),
    line: ref.span.startLine + 1,
    col: ref.span.startColumn + 1,
    kind: ref.kind ?? null,
    enclosing: ref.enclosing === undefined || ref.enclosing === null ? null : cleanField(ref.enclosing.qualifiedName),
    tier: ref.tier,
    confidence: ref.confidence,
    ambiguous: candidates > 1,
    candidates,
    ...(item.edge === undefined ? {} : { edge: item.edge }),
    citation,
  };
}

/** An entry of `data.targets` or `data.seeds`: a definition the request is about. */
export interface DefinitionInfo {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly handle: string;
}

export function describeDefinition(record: SymbolRecord): DefinitionInfo {
  const dot = record.identity.qualifiedName.lastIndexOf('.');
  const last = dot < 0 ? record.identity.qualifiedName : record.identity.qualifiedName.slice(dot + 1);
  return {
    name: cleanField(last),
    kind: cleanField(record.identity.kind),
    path: cleanField(record.source_path),
    line: record.span.startLine + 1,
    handle: record.debug,
  };
}

export async function runRefs(ctx: FindContext, input: CodeRefsInput): Promise<Envelope> {
  const { config } = ctx;
  const { reader } = ctx;
  try {
    const search = await findTargets(reader, ctx, input, MAX_TARGETS);
    const gathered = await gatherRefs(reader, ctx, search.targets, input.cwd, search.watermark);
    const { watermark } = gathered;
    const degraded = new Set<DegradedCode>([...ctx.fresh.degraded, ...search.degraded, ...gathered.degraded]);

    const lines = createLineReader(ctx.deps.text, ctx.worktree, new Set([...watermark.stalePaths, ...ctx.fresh.stalePaths]));
    const textOf = memoLineText<RefItem>(lines);
    const targetInfo = search.targets.map((target) => describeDefinition(target.record));

    const render = async (kept: readonly RefItem[], state: PageState): Promise<Envelope> => {
      const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
      const results: RefResult[] = [];
      for (const item of kept) {
        const line = await textOf(item, item.ref.source_path, item.ref.span);
        const id = cites.add({
          path: item.ref.source_path,
          span: item.ref.span,
          confidence: item.ref.confidence,
          debug: item.ref.debug,
          line,
        });
        results.push(describeRef(item, id));
      }
      const codes = new Set<DegradedCode>([...degraded, ...state.degraded]);
      if (cites.lacksText()) codes.add('stale');

      const hints: string[] = [];
      if (search.targets.length === 0) hints.push(NO_DEFINITION_HINT);
      else if (results.length === 0 && !state.cut) hints.push(NO_REFERENCE_HINT);
      if (state.cut) hints.push(state.more === null ? CURSOR_TOO_LONG_HINT : TRUNCATED_HINT);
      if (search.capped) hints.push(TARGETS_CAPPED_HINT);

      const envelope = okEnvelope(CODE_REFS_SCHEMA, { targets: targetInfo, results }, ctx.fresh.diagnostics, {
        ...(cites.citations.length === 0 ? {} : { citations: cites.citations }),
        watermark,
        ...(cites.entries.length === 0 ? {} : { untrusted_text: { nonce: ctx.nonce, entries: cites.entries } }),
        ...(state.cut || search.capped ? { truncated: true } : {}),
        ...(state.more === null ? {} : { more: state.more }),
        ...(hints.length === 0 ? {} : { hints }),
      });
      return withDegraded(envelope, codes);
    };

    const page = await pageItems(gathered.items, {
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
