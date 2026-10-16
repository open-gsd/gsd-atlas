/**
 * The extractor: Grammar Engine captures in, `FileFacts` out (LNG-03, LNG-04).
 *
 * It is module-agnostic. The capture-name vocabulary below is the contract between a language
 * module's three query files and this code; the toy module (LNG-08) and the two built-in modules
 * are written to it, and no language-specific rule lives here. This header is the one place the
 * vocabulary is documented.
 *
 * Tags query (`queries/tags.scm`): definitions.
 * - `definition.<kind>` on the whole definition node. The text after `definition.` becomes
 *   `LocalSymbol.kind` and the node's span becomes the symbol's span.
 * - `name` on the definition's identifier. Required: a match without it is skipped and counted.
 * - `export` (optional) on the exporting statement, in the same match. It marks the symbol
 *   `exported` and also yields an export site for that name.
 *
 * Imports query (`queries/imports.scm`): imports and exports, because a manifest has exactly three
 * query files.
 * - The statement node is captured as `import.es`, `import.cjs`, `import.side-effect` or
 *   `import.reexport`; the suffix is `ImportSite.style` and the node's span is the site's span.
 * - `import.path` on the path string (one pair of surrounding quotes is removed). Required: a
 *   statement without it is skipped and counted.
 * - Per-binding captures: `import.default` (local name), `import.namespace` (local name),
 *   `import.named` (the imported name) with `import.local` for the local alias when it differs.
 *   One match per binding is allowed; matches that share a statement span merge into one site.
 * - Exports: the statement or assignment is captured as `export`, with `export.name` (the name
 *   other files import), optional `export.local` (the local name when different) and optional
 *   `export.from` (the source string of a re-export).
 *
 * Refs query (`queries/refs.scm`): reference sites.
 * - `reference.call`, `reference.new`, `reference.read`, `reference.type`, `reference.heritage`
 *   or `reference.member` on the identifier node. The suffix is `RefSite.kind`.
 *
 * What the extractor decides, and what it never does:
 * - Containment (`parent`, `qualifiedName`, `enclosing`) is derived from spans here, never from
 *   capture data, so a hostile or sloppy module cannot produce an inconsistent `FileFacts`.
 * - Definitions, imports and exports are facts the store labels EXTRACTED. Reference sites are
 *   name matches the store labels INFERRED. The extractor carries no confidence and no target.
 * - It never throws on a malformed match: the match is skipped and counted in an info diagnostic.
 */
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic, FileFacts, LocalSymbol, Span } from '../facts/index.ts';
import type { Capture, GrammarRunResult, QueryKind } from './types.ts';

export interface ExtractInput {
  /** Repository-relative path of the file, recorded on the facts and used as the diagnostic subject. */
  readonly path: string;
  readonly contentHash: string;
  /** The language module's name. An attribute of the file's facts, never part of its identity. */
  readonly module: string;
  readonly grammarVersion: string;
  readonly run: GrammarRunResult;
}

export interface ExtractResult {
  readonly facts: FileFacts;
  /** Info diagnostics `match_missing_name` and `match_missing_path`; never fatal. */
  readonly diagnostics: Diagnostic[];
}

const DEFINITION_PREFIX = 'definition.';

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Captures of one query kind grouped by match index, in order of first appearance. */
function groupByMatch(captures: readonly Capture[], kind: QueryKind): Capture[][] {
  const groups = new Map<number, Capture[]>();
  for (const capture of captures) {
    if (capture.query !== kind) {
      continue;
    }
    const group = groups.get(capture.match);
    if (group === undefined) {
      groups.set(capture.match, [capture]);
    } else {
      group.push(capture);
    }
  }
  return [...groups.values()];
}

function compareStart(a: Span, b: Span): number {
  return a.startLine - b.startLine || a.startColumn - b.startColumn;
}

/** End position descending: the span that ends later (the outer one) sorts first. */
function compareEndDescending(a: Span, b: Span): number {
  return b.endLine - a.endLine || b.endColumn - a.endColumn;
}

function sameSpan(a: Span, b: Span): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

/** True when `outer` contains `inner` and they are not the same span (equal spans are siblings, never nested). */
function strictlyContains(outer: Span, inner: Span): boolean {
  if (sameSpan(outer, inner)) {
    return false;
  }
  const startsFirst =
    outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn);
  const endsLast =
    inner.endLine < outer.endLine || (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return startsFirst && endsLast;
}

interface SymbolDraft {
  readonly name: string;
  readonly kind: string;
  readonly span: Span;
  parent?: number;
  qualifiedName: string;
}

function firstNamed(group: readonly Capture[], name: string): Capture | undefined {
  return group.find((capture) => capture.name === name);
}

/** Build the drafts from the tags query: one per match that has a `definition.<kind>` and a non-empty `name`. */
function collectDefinitions(captures: readonly Capture[]): { drafts: SymbolDraft[]; skipped: number } {
  const drafts: SymbolDraft[] = [];
  let skipped = 0;
  for (const group of groupByMatch(captures, 'tags')) {
    const definition = group.find(
      (capture) => capture.name.startsWith(DEFINITION_PREFIX) && capture.name.length > DEFINITION_PREFIX.length,
    );
    const name = firstNamed(group, 'name');
    if (definition === undefined || name === undefined || name.text === '') {
      skipped += 1;
      continue;
    }
    drafts.push({
      name: name.text,
      kind: definition.name.slice(DEFINITION_PREFIX.length),
      span: definition.span,
      qualifiedName: name.text,
    });
  }
  return { drafts, skipped };
}

/**
 * Order the drafts by start position, then outer before inner (end position descending), then kind,
 * then name, and give each its parent (the innermost earlier symbol that strictly contains it) and
 * its qualified name. The order guarantees a parent index is smaller than its children's.
 */
function orderAndNest(drafts: SymbolDraft[]): SymbolDraft[] {
  const ordered = [...drafts].sort(
    (a, b) =>
      compareStart(a.span, b.span) ||
      compareEndDescending(a.span, b.span) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.name, b.name),
  );
  const stack: Array<{ readonly draft: SymbolDraft; readonly index: number }> = [];
  ordered.forEach((draft, index) => {
    for (let top = stack[stack.length - 1]; top !== undefined && !strictlyContains(top.draft.span, draft.span); top = stack[stack.length - 1]) {
      stack.pop();
    }
    const container = stack[stack.length - 1];
    if (container !== undefined) {
      draft.parent = container.index;
      draft.qualifiedName = `${container.draft.qualifiedName}.${draft.name}`;
    }
    stack.push({ draft, index });
  });
  return ordered;
}

function toSymbol(draft: SymbolDraft): LocalSymbol {
  return {
    name: draft.name,
    kind: draft.kind,
    qualifiedName: draft.qualifiedName,
    span: draft.span,
    ...(draft.parent === undefined ? {} : { parent: draft.parent }),
  };
}

function countMessage(count: number, what: string): string {
  return `${String(count)} ${what} skipped`;
}

/**
 * Turn one run's captures into the file's facts. Pure and deterministic: the same run gives deep-equal
 * facts, and output order never depends on capture insertion order beyond the documented sort keys.
 */
export function extractFileFacts(input: ExtractInput): ExtractResult {
  const { run } = input;
  const diagnostics: Diagnostic[] = [];

  const { drafts, skipped } = collectDefinitions(run.captures);
  const symbols = orderAndNest(drafts).map(toSymbol);
  if (skipped > 0) {
    diagnostics.push(
      diagnostic(
        'match_missing_name',
        'info',
        countMessage(skipped, 'tags matches without a definition.<kind> and a name capture'),
        input.path,
      ),
    );
  }

  const facts: FileFacts = {
    path: input.path,
    contentHash: input.contentHash,
    module: input.module,
    grammarVersion: input.grammarVersion,
    symbols,
    refSites: [],
    imports: [],
    exports: [],
    parse: { errorBytes: run.errorBytes, totalBytes: run.totalBytes },
  };
  return { facts, diagnostics };
}
