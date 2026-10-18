/**
 * `code_context`: a symbol in the context of its file. For the best-ranked definition of the name (the other
 * candidates are listed, at most five) the answer is one ordered list of items, each tagged with its `section`,
 * in this priority order: the definition, the symbol that contains it, the symbols it contains, the file's
 * imports, the file's exports and the highest-ranked references (at most ten). Because it is one ordered list,
 * the same budget cut and keyset cursor apply as for every other code tool: the definition always comes first,
 * and a cut removes the lowest-priority items first.
 *
 * Callees, ADR citations and tests (`callees`, `cites_adr`, `tested_by`) are Phase 3 and are not present.
 *
 * `data.file.emittedAs` (TSM-03) lists what the project's compiler writes for the file that defines the symbol, when
 * a project model says so; it is absent otherwise.
 */
import { UnknownWorktree } from '../fact-store/index.ts';
import type { Reader, RelationRecord, SymbolRecord } from '../fact-store/index.ts';
import type { DegradedCode, Envelope, ExportSite, FileFacts, ImportSite, LocalSymbol, Span, SymbolIdentity } from '../facts/index.ts';
import { okEnvelope, symbolKey } from '../facts/index.ts';
import { cleanField, createCitations, memoLineText } from './cite.ts';
import { CODE_CONTEXT_SCHEMA, errorEnvelope, withDegraded } from './envelope.ts';
import { CURSOR_TOO_LONG_HINT, OUTPUT_TOO_LARGE_MESSAGE, TRUNCATED_HINT, notIndexed } from './find.ts';
import type { FindContext } from './find.ts';
import { pageItems } from './page.ts';
import type { PageState } from './page.ts';
import { compareRanked, contextKeyOf } from './ranking.ts';
import type { ContextSection, SortKey } from './ranking.ts';
import { NO_DEFINITION_HINT, TARGETS_CAPPED_HINT, describeDefinition, findTargets, gatherRefs, laterOf } from './refs.ts';
import type { DefinitionInfo, RefItem } from './refs.ts';
import { createLineReader } from './text.ts';
import type { CodeContextInput } from './tools.ts';

/** Other definitions of the name that are listed beside the best-ranked one. */
export const MAX_ALTERNATIVES = 5;

/** References shown for the definition; `code_refs` lists them all. */
export const MAX_CONTEXT_REFERENCES = 10;

export const REFS_CAPPED_HINT = 'Only the ten highest-ranked references are shown. Use code_refs to list them all.';

export const RELATIONS_CAPPED_HINT = 'More relations exist than one answer lists. Use code_refs or code_impact to follow them.';

type SymbolSection = 'definition' | 'parent' | 'child';

interface SymbolEntry {
  readonly key: SortKey;
  readonly section: SymbolSection;
  readonly identity: SymbolIdentity;
  readonly local: Pick<LocalSymbol, 'name' | 'kind' | 'qualifiedName' | 'exported'> & { readonly span: Span };
  /** Known for the definition; found through the Reader, only if the item is shown, for the others. */
  readonly record: SymbolRecord | null;
}

interface ImportEntry {
  readonly key: SortKey;
  readonly section: 'import';
  readonly site: ImportSite;
  readonly handle: string;
}

interface ExportEntry {
  readonly key: SortKey;
  readonly section: 'export';
  readonly site: ExportSite;
  readonly handle: string;
}

interface ReferenceEntry {
  readonly key: SortKey;
  readonly section: 'reference';
  readonly item: RefItem;
}

/**
 * A compiler relation of the definition (plan 03-25): a supertype (what the symbol extends or implements, or the member it
 * overrides) or a subtype (what extends or implements it, or the member that overrides it). It is cited at the other
 * symbol's definition, and is paged like any other entry but rendered under `data.supertypes` or `data.subtypes`.
 */
interface RelationEntry {
  readonly key: SortKey;
  readonly section: 'supertype' | 'subtype';
  readonly record: RelationRecord;
  /** The symbol on the other end of the relation, and where its definition is. */
  readonly other: { readonly identity: SymbolIdentity; readonly kind: string; readonly path: string; readonly span: Span };
}

type Entry = SymbolEntry | ImportEntry | ExportEntry | ReferenceEntry | RelationEntry;

const lastSegment = (qualifiedName: string): string => {
  const dot = qualifiedName.lastIndexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
};

/**
 * The identity of each symbol of a file, by the store's rule (fact-model ADR decision 6): the qualified name or
 * name, the kind, and a discriminator that is the zero-based index among the symbols sharing both, set only when
 * more than one does.
 */
function identitiesOf(repo: string, filePath: string, symbols: readonly LocalSymbol[]): SymbolIdentity[] {
  const group = (symbol: LocalSymbol): string => `${symbol.qualifiedName ?? symbol.name}\u0000${symbol.kind}`;
  const sizes = new Map<string, number>();
  for (const symbol of symbols) sizes.set(group(symbol), (sizes.get(group(symbol)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return symbols.map((symbol) => {
    const key = group(symbol);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const base = { repo, path: filePath, qualifiedName: symbol.qualifiedName ?? symbol.name, kind: symbol.kind };
    return (sizes.get(key) ?? 0) > 1 ? { ...base, discriminator: String(index) } : base;
  });
}

/** The handle of an import or export, in the shape the store gives its own import records. */
const siteHandle = (prefix: 'imp' | 'exp', filePath: string, hash: string, index: number): string =>
  `${prefix}/${encodeURIComponent(filePath)}/${hash}/${String(index)}`;

/** The ordered entries around the definition, from the file's facts. */
function entriesAround(best: SymbolRecord, facts: FileFacts | null): Entry[] {
  const filePath = best.source_path;
  const entries: Entry[] = [
    {
      key: contextKeyOf('definition', 0, filePath, best.span.startLine, best.span.startColumn),
      section: 'definition',
      identity: best.identity,
      local: {
        name: lastSegment(best.identity.qualifiedName),
        kind: best.identity.kind,
        span: best.span,
        ...(best.exported === undefined ? {} : { exported: best.exported }),
      },
      record: best,
    },
  ];
  if (facts === null) return entries;

  const identities = identitiesOf(best.identity.repo, filePath, facts.symbols);
  const wanted = symbolKey(best.identity);
  const at = identities.findIndex((identity) => symbolKey(identity) === wanted);
  const symbolEntry = (section: SymbolSection, ordinal: number, index: number): SymbolEntry | null => {
    const local = facts.symbols[index];
    const identity = identities[index];
    if (local === undefined || identity === undefined) return null;
    return {
      key: contextKeyOf(section, ordinal, filePath, local.span.startLine, local.span.startColumn),
      section,
      identity,
      local: {
        name: local.name,
        kind: local.kind,
        span: local.span,
        ...(local.qualifiedName === undefined ? {} : { qualifiedName: local.qualifiedName }),
        ...(local.exported === undefined ? {} : { exported: local.exported }),
      },
      record: null,
    };
  };

  if (at >= 0) {
    const parentIndex = facts.symbols[at]?.parent;
    if (parentIndex !== undefined) {
      const parent = symbolEntry('parent', 0, parentIndex);
      if (parent !== null) entries.push(parent);
    }
    const children = facts.symbols
      .map((symbol, index) => ({ symbol, index }))
      .filter(({ symbol }) => symbol.parent === at)
      .sort(
        (a, b) =>
          a.symbol.span.startLine - b.symbol.span.startLine ||
          a.symbol.span.startColumn - b.symbol.span.startColumn ||
          a.index - b.index,
      );
    children.forEach(({ index }, ordinal) => {
      const child = symbolEntry('child', ordinal, index);
      if (child !== null) entries.push(child);
    });
  }

  facts.imports.forEach((site, index) => {
    entries.push({
      key: contextKeyOf('import', index, filePath, site.span.startLine, site.span.startColumn),
      section: 'import',
      site,
      handle: siteHandle('imp', filePath, facts.contentHash, index),
    });
  });
  (facts.exports ?? []).forEach((site, index) => {
    entries.push({
      key: contextKeyOf('export', index, filePath, site.span.startLine, site.span.startColumn),
      section: 'export',
      site,
      handle: siteHandle('exp', filePath, facts.contentHash, index),
    });
  });
  return entries;
}

export async function runContext(ctx: FindContext, input: CodeContextInput): Promise<Envelope> {
  const { config } = ctx;
  const { reader } = ctx;
  try {
    const search = await findTargets(reader, ctx, input, 1 + MAX_ALTERNATIVES);
    const best = search.targets[0]?.record;
    const filePath = best?.source_path ?? '';
    const alternatives: DefinitionInfo[] = search.targets.slice(1).map((target) => describeDefinition(target.record));

    let watermark = search.watermark;
    const degraded = new Set<DegradedCode>([...ctx.fresh.degraded, ...search.degraded]);
    let entries: Entry[] = [];
    let refsCapped = false;
    let relationsCapped = false;
    /** What the project's compiler writes for the defining file (TSM-03); empty when it says nothing. */
    let emittedAs: readonly string[] = [];
    if (best !== undefined) {
      const factsAnswer = await reader.fileFacts(best.source_path);
      watermark = laterOf(watermark, factsAnswer.watermark);
      for (const code of factsAnswer.degraded ?? []) degraded.add(code);
      entries = entriesAround(best, factsAnswer.data);

      const emitted = await reader.emittedAs(best.source_path);
      watermark = laterOf(watermark, emitted.watermark);
      for (const code of emitted.degraded ?? []) degraded.add(code);
      emittedAs = emitted.data;

      const gathered = await gatherRefs(reader, ctx, search.targets.slice(0, 1), input.cwd, watermark);
      watermark = laterOf(watermark, gathered.watermark);
      for (const code of gathered.degraded) degraded.add(code);
      refsCapped = gathered.items.length > MAX_CONTEXT_REFERENCES;
      gathered.items.slice(0, MAX_CONTEXT_REFERENCES).forEach((item, ordinal) => {
        entries.push({
          key: contextKeyOf('reference', ordinal, item.ref.source_path, item.ref.span.startLine, item.ref.span.startColumn),
          section: 'reference',
          item,
        });
      });

      // The compiler's relations of the definition: both what it extends, implements or overrides and what does so to it.
      const related = await reader.relations(best.identity, { direction: 'both', timeoutMs: config.resolveTimeoutMs, limit: config.maxLimit });
      watermark = laterOf(watermark, related.watermark);
      for (const code of related.degraded ?? []) degraded.add(code);
      relationsCapped = related.data.length >= config.maxLimit;
      const bestKey = symbolKey(best.identity);
      const ordinals = { supertype: 0, subtype: 0 };
      for (const record of related.data) {
        const subtype = symbolKey(record.to) === bestKey;
        const section = subtype ? 'subtype' : 'supertype';
        // A subtype is cited where it is defined, which is where the relation is written; a supertype at its own definition.
        const other = subtype ? undefined : await reader.symbol(record.to);
        if (!subtype && (other === undefined || other.data === null)) continue;
        const entryOther = subtype
          ? { identity: record.from, kind: record.from.kind, path: record.source_path, span: record.span }
          : { identity: record.to, kind: record.to.kind, path: other?.data?.source_path ?? record.to.path, span: other?.data?.span ?? record.span };
        if (other !== undefined) watermark = laterOf(watermark, other.watermark);
        entries.push({
          key: contextKeyOf(section, ordinals[section], entryOther.path, entryOther.span.startLine, entryOther.span.startColumn),
          section,
          record,
          other: entryOther,
        });
        ordinals[section] += 1;
      }
    }
    entries.sort((a, b) => compareRanked(a.key, b.key));

    const lines = createLineReader(ctx.deps.text, ctx.worktree, new Set([...watermark.stalePaths, ...ctx.fresh.stalePaths]));
    const textOf = memoLineText<Entry>(lines);
    const handleOf = new Map<Entry, Promise<string | null>>();
    const handleFor = (entry: SymbolEntry): Promise<string | null> => {
      if (entry.record !== null) return Promise.resolve(entry.record.debug);
      const known = handleOf.get(entry);
      if (known !== undefined) return known;
      const pending = reader.symbol(entry.identity).then((answer) => answer.data?.debug ?? null);
      handleOf.set(entry, pending);
      return pending;
    };

    const render = async (kept: readonly Entry[], state: PageState): Promise<Envelope> => {
      const cites = createCitations(ctx.nonce, config.lineTextMaxChars);
      const results: Record<string, unknown>[] = [];
      const supertypes: Record<string, unknown>[] = [];
      const subtypes: Record<string, unknown>[] = [];
      for (const entry of kept) {
        const section: ContextSection = entry.section;
        if (entry.section === 'supertype' || entry.section === 'subtype') {
          const line = await textOf(entry, entry.other.path, entry.other.span);
          const id = cites.add({ path: entry.other.path, span: entry.other.span, confidence: 'EXTRACTED', debug: entry.record.debug, line });
          const item = {
            relation: entry.record.relation,
            name: cleanField(lastSegment(entry.other.identity.qualifiedName)),
            kind: cleanField(entry.other.kind),
            path: cleanField(entry.other.path),
            line: entry.other.span.startLine + 1,
            col: entry.other.span.startColumn + 1,
            confidence: 'EXTRACTED',
            citation: id,
          };
          (entry.section === 'supertype' ? supertypes : subtypes).push(item);
          continue;
        }
        if (entry.section === 'definition' || entry.section === 'parent' || entry.section === 'child') {
          const handle = await handleFor(entry);
          if (handle === null) continue; // the symbol vanished between the two reads
          const line = await textOf(entry, filePath, entry.local.span);
          const id = cites.add({ path: filePath, span: entry.local.span, confidence: 'EXTRACTED', debug: handle, line });
          results.push({
            section,
            name: cleanField(entry.local.name),
            kind: cleanField(entry.local.kind),
            path: cleanField(filePath),
            line: entry.local.span.startLine + 1,
            col: entry.local.span.startColumn + 1,
            ...(entry.local.exported === undefined ? {} : { exported: entry.local.exported }),
            confidence: 'EXTRACTED',
            citation: id,
          });
        } else if (entry.section === 'import') {
          const line = await textOf(entry, filePath, entry.site.span);
          const id = cites.add({ path: filePath, span: entry.site.span, confidence: 'EXTRACTED', debug: entry.handle, line });
          results.push({
            section,
            name: cleanField(entry.site.path),
            kind: 'import',
            path: cleanField(filePath),
            line: entry.site.span.startLine + 1,
            col: entry.site.span.startColumn + 1,
            ...(entry.site.style === undefined ? {} : { style: entry.site.style }),
            ...(entry.site.bindings === undefined
              ? {}
              : { bindings: entry.site.bindings.map((binding) => ({ imported: cleanField(binding.imported), local: cleanField(binding.local) })) }),
            confidence: 'EXTRACTED',
            citation: id,
          });
        } else if (entry.section === 'export') {
          const line = await textOf(entry, filePath, entry.site.span);
          const id = cites.add({ path: filePath, span: entry.site.span, confidence: 'EXTRACTED', debug: entry.handle, line });
          results.push({
            section,
            name: cleanField(entry.site.name),
            kind: 'export',
            path: cleanField(filePath),
            line: entry.site.span.startLine + 1,
            col: entry.site.span.startColumn + 1,
            ...(entry.site.local === undefined ? {} : { local: cleanField(entry.site.local) }),
            ...(entry.site.from === undefined ? {} : { from: cleanField(entry.site.from) }),
            confidence: 'EXTRACTED',
            citation: id,
          });
        } else if (entry.section === 'reference') {
          const { ref } = entry.item;
          const line = await textOf(entry, ref.source_path, ref.span);
          const id = cites.add({ path: ref.source_path, span: ref.span, confidence: ref.confidence, debug: ref.debug, line });
          const candidates = ref.candidates ?? 1;
          results.push({
            section,
            name: cleanField(ref.site.name),
            kind: ref.kind ?? 'reference',
            path: cleanField(ref.source_path),
            line: ref.span.startLine + 1,
            col: ref.span.startColumn + 1,
            target: entry.item.target.debug,
            enclosing: ref.enclosing === undefined || ref.enclosing === null ? null : cleanField(ref.enclosing.qualifiedName),
            tier: ref.tier,
            confidence: ref.confidence,
            ambiguous: candidates > 1,
            candidates,
            ...(entry.item.edge === undefined ? {} : { edge: entry.item.edge }),
            citation: id,
          });
        }
      }
      const codes = new Set<DegradedCode>([...degraded, ...state.degraded]);
      if (cites.lacksText()) codes.add('stale');

      const hints: string[] = [];
      if (best === undefined) hints.push(NO_DEFINITION_HINT);
      if (state.cut) hints.push(state.more === null ? CURSOR_TOO_LONG_HINT : TRUNCATED_HINT);
      if (refsCapped) hints.push(REFS_CAPPED_HINT);
      if (relationsCapped) hints.push(RELATIONS_CAPPED_HINT);
      if (search.capped) hints.push(TARGETS_CAPPED_HINT);

      // `file` is there only when the compiler's emit mapping names an output: a file in no project, or a repository with
      // no project model, has no `file` and no empty `emittedAs`. The paths come from a repository's configuration, so
      // they are cleaned like every other repository string.
      // `supertypes` and `subtypes` are there only when the compiler reported a relation that is on this page, never empty.
      const data = {
        results,
        alternatives,
        ...(emittedAs.length === 0 ? {} : { file: { path: cleanField(filePath), emittedAs: emittedAs.map(cleanField) } }),
        ...(supertypes.length === 0 ? {} : { supertypes }),
        ...(subtypes.length === 0 ? {} : { subtypes }),
      };
      const envelope = okEnvelope(CODE_CONTEXT_SCHEMA, data, ctx.fresh.diagnostics, {
        ...(cites.citations.length === 0 ? {} : { citations: cites.citations }),
        watermark,
        ...(cites.entries.length === 0 ? {} : { untrusted_text: { nonce: ctx.nonce, entries: cites.entries } }),
        ...(state.cut || refsCapped || relationsCapped || search.capped ? { truncated: true } : {}),
        ...(state.more === null ? {} : { more: state.more }),
        ...(hints.length === 0 ? {} : { hints }),
      });
      return withDegraded(envelope, codes);
    };

    const page = await pageItems(entries, {
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
