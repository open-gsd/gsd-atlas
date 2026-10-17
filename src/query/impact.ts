/**
 * `code_impact`: how far a change to a symbol reaches (user decision 3, query-and-policy ADR amendment).
 *
 * The seeds are the definitions matching the name. The walk is breadth-first, hop by hop, over two kinds of edge:
 *   - a reference to a symbol, which makes the symbol that contains the reference site impacted (`call` when the
 *     site is a call, `reference` otherwise) or, when the site sits outside every symbol, the file (`reference`);
 *   - an import of a file, which makes the importing file impacted (`import`).
 * Every item carries the confidence of its own edge and the confidence of the whole chain from the seed: the chain
 * is INFERRED as soon as one edge on it is INFERRED, and an INFERRED edge is never presented as EXTRACTED. Each
 * symbol or file is reported once per seed, at the smallest hop that reaches it. Depth is clamped, a hop keeps at
 * most the per-hop row cap, and anything cut is reported (`truncated` and a hint), never dropped silently.
 */
import path from 'node:path';
import { UnknownWorktree } from '../fact-store/index.ts';
import type { Reader, SymbolRecord } from '../fact-store/index.ts';
import type { Confidence, DegradedCode, Envelope, Span, SymbolIdentity, Watermark } from '../facts/index.ts';
import { okEnvelope, symbolKey } from '../facts/index.ts';
import { cleanField, createCitations, memoLineText } from './cite.ts';
import { CODE_IMPACT_SCHEMA, errorEnvelope, withDegraded } from './envelope.ts';
import { CURSOR_TOO_LONG_HINT, OUTPUT_TOO_LARGE_MESSAGE, TRUNCATED_HINT, notIndexed } from './find.ts';
import type { FindContext } from './find.ts';
import { pageItems } from './page.ts';
import type { PageState } from './page.ts';
import { compareRanked, cwdHintDir, directoryDistance, impactKeyOf } from './ranking.ts';
import type { ImpactVia, SortKey } from './ranking.ts';
import { MAX_TARGETS, NO_DEFINITION_HINT, TARGETS_CAPPED_HINT, describeDefinition, findTargets, laterOf } from './refs.ts';
import type { DefinitionInfo } from './refs.ts';
import { createLineReader } from './text.ts';
import type { CodeImpactInput } from './tools.ts';

/** Candidates examined per hop and seed, as a multiple of the row cap, before the hop is cut to the cap. */
const CANDIDATE_FACTOR = 4;

export const NO_REFERRER_HINT =
  'Nothing in the index refers to this symbol or imports its file. The index follows imports and uses inside the defining file; a call through a computed name is not seen.';
export const DEPTH_ZERO_HINT = 'Depth 0 follows no hops. Pass a depth of 1 or more.';

const hopCappedHint = (hop: number, cap: number): string =>
  `Hop ${String(hop)} was capped at ${String(cap)} items. Narrow the query with path or ask for a smaller depth.`;

const depthClampedHint = (max: number): string => `The depth was reduced to the maximum of ${String(max)}.`;

/** One way to reach a symbol or a file, before the best of several is chosen. */
interface Edge {
  readonly via: ImpactVia;
  readonly confidence: Confidence;
  /** The confidence of the whole chain from the seed to this item, this edge included. */
  readonly chain: Confidence;
  /** The file the edge's site is in (the importing file, or the file of the reference site). */
  readonly path: string;
  readonly span: Span;
  readonly handle: string;
}

const confidenceRank = (value: Confidence): number => (value === 'EXTRACTED' ? 0 : 1);
const viaRank = (via: ImpactVia): number => (via === 'import' ? 0 : via === 'call' ? 1 : 2);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The numeric rank of an edge, the same one the item key uses: confidence, chain confidence, then how it is reached. */
const edgeRank = (edge: Edge): number => confidenceRank(edge.confidence) * 6 + confidenceRank(edge.chain) * 3 + viaRank(edge.via);

/** Negative when `a` is the better way to reach the same node than `b`; a total order, so the choice never depends on arrival order. */
const compareEdges = (a: Edge, b: Edge): number =>
  edgeRank(a) - edgeRank(b) ||
  byText(a.path, b.path) ||
  a.span.startLine - b.span.startLine ||
  a.span.startColumn - b.span.startColumn ||
  byText(a.handle, b.handle);

/** The chain stays EXTRACTED only while every edge on it is. */
const chainOf = (before: Confidence, edge: Confidence): Confidence => (before === 'EXTRACTED' && edge === 'EXTRACTED' ? 'EXTRACTED' : 'INFERRED');

/** One item of the walk. */
interface Walked {
  readonly hop: number;
  readonly via: ImpactVia;
  readonly isFile: boolean;
  /** The impacted file, or the file the impacted symbol is defined in. */
  readonly path: string;
  /** Where the item points: the definition of a symbol, the import statement or the reference site of a file. */
  readonly span: Span;
  readonly confidence: Confidence;
  readonly chain: Confidence;
  readonly name: string;
  readonly kind: string;
  readonly handle: string;
  /** The identity of an impacted symbol; null for a file. */
  readonly identity: SymbolIdentity | null;
  /** The debug handle of the seed this item was reached from. */
  readonly from: string;
  readonly key: SortKey;
}

interface WalkSettings {
  readonly depth: number;
  readonly cap: number;
  readonly timeoutMs: number;
  readonly hint: string | null;
}

function walkedOf(
  settings: WalkSettings,
  hop: number,
  seed: SymbolRecord,
  edge: Edge,
  node: { readonly isFile: boolean; readonly path: string; readonly span: Span; readonly name: string; readonly kind: string; readonly handle: string; readonly identity: SymbolIdentity | null },
): Walked {
  const dir = path.posix.dirname(node.path);
  return {
    hop,
    via: edge.via,
    isFile: node.isFile,
    path: node.path,
    span: node.span,
    confidence: edge.confidence,
    chain: edge.chain,
    name: node.name,
    kind: node.kind,
    handle: node.handle,
    identity: node.identity,
    from: seed.debug,
    key: impactKeyOf({
      hop,
      isFile: node.isFile,
      confidence: edge.confidence,
      chain: edge.chain,
      via: edge.via,
      distance: directoryDistance(dir === '.' ? '' : dir, settings.hint),
      path: node.path,
      line: node.span.startLine,
      col: node.span.startColumn,
      // Two seeds can reach the same item; the seed in the handle keeps their keys apart, so the order stays total.
      handle: `${node.handle}\u0000${seed.debug}`,
    }),
  };
}

const lastSegment = (qualifiedName: string): string => {
  const dot = qualifiedName.lastIndexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
};

interface SeedWalk {
  readonly items: readonly Walked[];
  /** The hops that had more items than the cap, in order. */
  readonly cappedHops: readonly number[];
  readonly watermark: Watermark;
  readonly degraded: readonly DegradedCode[];
}

/** Walk outward from one seed. */
async function walkSeed(reader: Reader, seed: SymbolRecord, start: Watermark, settings: WalkSettings): Promise<SeedWalk> {
  const seen = new Set<string>([`s:${symbolKey(seed.identity)}`]);
  let symbols: { identity: SymbolIdentity; chain: Confidence }[] = [{ identity: seed.identity, chain: 'EXTRACTED' }];
  let files: { path: string; chain: Confidence }[] = [{ path: seed.source_path, chain: 'EXTRACTED' }];
  let watermark = start;
  const degraded = new Set<DegradedCode>();
  const items: Walked[] = [];
  const cappedHops: number[] = [];

  for (let hop = 1; hop <= settings.depth && (symbols.length > 0 || files.length > 0); hop += 1) {
    const symbolEdges = new Map<string, { identity: SymbolIdentity; edge: Edge }>();
    const fileEdges = new Map<string, { path: string; edge: Edge }>();
    const offerSymbol = (identity: SymbolIdentity, edge: Edge): void => {
      const key = `s:${symbolKey(identity)}`;
      if (seen.has(key)) return;
      const known = symbolEdges.get(key);
      if (known === undefined || compareEdges(edge, known.edge) < 0) symbolEdges.set(key, { identity, edge });
    };
    const offerFile = (filePath: string, edge: Edge): void => {
      const key = `f:${filePath}`;
      if (seen.has(key)) return;
      const known = fileEdges.get(key);
      if (known === undefined || compareEdges(edge, known.edge) < 0) fileEdges.set(key, { path: filePath, edge });
    };

    for (const source of symbols) {
      const answer = await reader.refs(source.identity, { timeoutMs: settings.timeoutMs });
      watermark = laterOf(watermark, answer.watermark);
      for (const code of answer.degraded ?? []) degraded.add(code);
      for (const ref of answer.data) {
        const edge: Edge = {
          via: ref.kind === 'call' ? 'call' : 'reference',
          confidence: ref.confidence,
          chain: chainOf(source.chain, ref.confidence),
          path: ref.source_path,
          span: ref.span,
          handle: ref.debug,
        };
        if (ref.enclosing === undefined || ref.enclosing === null) offerFile(ref.source_path, { ...edge, via: 'reference' });
        else offerSymbol(ref.enclosing, edge);
      }
    }
    for (const source of files) {
      const answer = await reader.importers(source.path, { depth: 1 });
      watermark = laterOf(watermark, answer.watermark);
      for (const code of answer.degraded ?? []) degraded.add(code);
      for (const record of answer.data) {
        // An import cycle back to the file the seed lives in does not make that file "impacted by itself".
        if (record.importer === seed.source_path) continue;
        offerFile(record.importer, {
          via: 'import',
          confidence: record.confidence,
          chain: chainOf(source.chain, record.confidence),
          path: record.importer,
          span: record.span,
          handle: record.debug,
        });
      }
    }

    // Bound the work of resolving candidates: keep the best few times the cap by a cheap order, and say so.
    const examine = settings.cap * CANDIDATE_FACTOR;
    let tooMany = false;
    let symbolList = [...symbolEdges.values()];
    if (symbolList.length > examine) {
      tooMany = true;
      symbolList = symbolList
        .sort(
          (a, b) =>
            edgeRank(a.edge) - edgeRank(b.edge) ||
            byText(a.identity.path, b.identity.path) ||
            byText(a.identity.qualifiedName, b.identity.qualifiedName),
        )
        .slice(0, examine);
    }
    let fileList = [...fileEdges.values()];
    if (fileList.length > examine) {
      tooMany = true;
      fileList = fileList.sort((a, b) => edgeRank(a.edge) - edgeRank(b.edge) || byText(a.path, b.path)).slice(0, examine);
    }

    const walked: Walked[] = [];
    for (const candidate of symbolList) {
      const found = await reader.symbol(candidate.identity);
      watermark = laterOf(watermark, found.watermark);
      const record = found.data;
      if (record === null) continue;
      walked.push(
        walkedOf(settings, hop, seed, candidate.edge, {
          isFile: false,
          path: record.source_path,
          span: record.span,
          name: lastSegment(record.identity.qualifiedName),
          kind: record.identity.kind,
          handle: record.debug,
          identity: record.identity,
        }),
      );
    }
    for (const candidate of fileList) {
      walked.push(
        walkedOf(settings, hop, seed, candidate.edge, {
          isFile: true,
          path: candidate.path,
          span: candidate.edge.span,
          name: candidate.path,
          kind: 'file',
          handle: candidate.edge.handle,
          identity: null,
        }),
      );
    }
    walked.sort((a, b) => compareRanked(a.key, b.key));
    if (walked.length > settings.cap || tooMany) cappedHops.push(hop);

    const nextSymbols: { identity: SymbolIdentity; chain: Confidence }[] = [];
    const nextFiles: { path: string; chain: Confidence }[] = [];
    for (const item of walked.slice(0, settings.cap)) {
      items.push(item);
      if (item.identity === null) {
        seen.add(`f:${item.path}`);
        nextFiles.push({ path: item.path, chain: item.chain });
      } else {
        seen.add(`s:${symbolKey(item.identity)}`);
        nextSymbols.push({ identity: item.identity, chain: item.chain });
      }
    }
    symbols = nextSymbols;
    files = nextFiles;
  }
  return { items, cappedHops, watermark, degraded: [...degraded] };
}

/** One entry of `data.results` of `code_impact`. */
export interface ImpactResult {
  readonly hop: number;
  readonly via: ImpactVia;
  /** The kind of the impacted symbol, or `file`. */
  readonly kind: string;
  /** The impacted symbol's name, or the file's path. */
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  /** The confidence of the edge that reaches this item. */
  readonly confidence: Confidence;
  /** INFERRED when any edge on the path from the seed is INFERRED. */
  readonly chain_confidence: Confidence;
  readonly handle: string;
  /** The debug handle of the seed it was reached from. */
  readonly from: string;
  readonly citation: string;
}

export async function runImpact(ctx: FindContext, input: CodeImpactInput): Promise<Envelope> {
  const { config } = ctx;
  const { reader } = ctx;
  const requested = input.depth ?? config.impactDefaultDepth;
  const depth = Math.min(requested, config.impactMaxDepth);
  try {
    const search = await findTargets(reader, ctx, input, MAX_TARGETS);
    const settings: WalkSettings = {
      depth,
      cap: config.impactRowCapPerHop,
      timeoutMs: config.resolveTimeoutMs,
      hint: cwdHintDir(ctx.worktree, input.cwd),
    };

    let watermark = search.watermark;
    const degraded = new Set<DegradedCode>([...ctx.fresh.degraded, ...search.degraded]);
    const items: Walked[] = [];
    const capped = new Set<number>();
    for (const target of search.targets) {
      const walk = await walkSeed(reader, target.record, watermark, settings);
      watermark = laterOf(watermark, walk.watermark);
      for (const code of walk.degraded) degraded.add(code);
      for (const hop of walk.cappedHops) capped.add(hop);
      items.push(...walk.items);
    }
    items.sort((a, b) => compareRanked(a.key, b.key));
    const cappedHops = [...capped].sort((a, b) => a - b);

    const lines = createLineReader(ctx.deps.text, ctx.worktree, new Set([...watermark.stalePaths, ...ctx.fresh.stalePaths]));
    const textOf = memoLineText<Walked>(lines);
    const seeds: DefinitionInfo[] = search.targets.map((target) => describeDefinition(target.record));

    const render = async (kept: readonly Walked[], state: PageState): Promise<Envelope> => {
      const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
      const results: ImpactResult[] = [];
      for (const item of kept) {
        const line = await textOf(item, item.path, item.span);
        const id = cites.add({ path: item.path, span: item.span, confidence: item.confidence, debug: item.handle, line });
        results.push({
          hop: item.hop,
          via: item.via,
          kind: cleanField(item.kind),
          name: cleanField(item.name),
          path: cleanField(item.path),
          line: item.span.startLine + 1,
          col: item.span.startColumn + 1,
          confidence: item.confidence,
          chain_confidence: item.chain,
          handle: item.handle,
          from: item.from,
          citation: id,
        });
      }
      const codes = new Set<DegradedCode>([...degraded, ...state.degraded]);
      if (cites.lacksText()) codes.add('stale');

      const hints: string[] = [];
      if (search.targets.length === 0) hints.push(NO_DEFINITION_HINT);
      else if (depth === 0) hints.push(DEPTH_ZERO_HINT);
      else if (items.length === 0) hints.push(NO_REFERRER_HINT);
      if (requested > config.impactMaxDepth) hints.push(depthClampedHint(config.impactMaxDepth));
      for (const hop of cappedHops) hints.push(hopCappedHint(hop, config.impactRowCapPerHop));
      if (state.cut) hints.push(state.more === null ? CURSOR_TOO_LONG_HINT : TRUNCATED_HINT);
      if (search.capped) hints.push(TARGETS_CAPPED_HINT);

      const envelope = okEnvelope(CODE_IMPACT_SCHEMA, { seeds, results }, ctx.fresh.diagnostics, {
        ...(cites.citations.length === 0 ? {} : { citations: cites.citations }),
        watermark,
        ...(cites.entries.length === 0 ? {} : { untrusted_text: { nonce: ctx.nonce, entries: cites.entries } }),
        ...(state.cut || cappedHops.length > 0 || search.capped ? { truncated: true } : {}),
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
