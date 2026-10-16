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
 * - Reference sites are scope-filtered at extraction (D-06, research Pattern 2): a site is recorded
 *   only when its name is defined at module top level in the same file, is an import binding, is
 *   an export name, or is the property of a member call (kind `member`). A declaration's own name
 *   is never a reference. `importPath` is set when a non-member site's name is an import binding.
 * - Definitions, imports and exports are facts the store labels EXTRACTED. Reference sites are
 *   name matches the store labels INFERRED. The extractor carries no confidence and no target.
 * - It never throws on a malformed match: the match is skipped and counted in an info diagnostic
 *   (`match_missing_name`, `match_missing_path`).
 */
import { IMPORT_STYLES, REF_KINDS, diagnostic } from '../facts/index.ts';
import type {
  Diagnostic,
  ExportSite,
  FileFacts,
  ImportBinding,
  ImportSite,
  ImportStyle,
  LocalSymbol,
  RefKind,
  RefSite,
  Span,
} from '../facts/index.ts';
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
const IMPORT_PREFIX = 'import.';
const REFERENCE_PREFIX = 'reference.';

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStart(a: Span, b: Span): number {
  return a.startLine - b.startLine || a.startColumn - b.startColumn;
}

/** End position descending: the span that ends later (the outer one) sorts first. */
function compareEndDescending(a: Span, b: Span): number {
  return b.endLine - a.endLine || b.endColumn - a.endColumn;
}

function compareEndAscending(a: Span, b: Span): number {
  return a.endLine - b.endLine || a.endColumn - b.endColumn;
}

function sameSpan(a: Span, b: Span): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

function spanKey(span: Span): string {
  return `${String(span.startLine)}:${String(span.startColumn)}-${String(span.endLine)}:${String(span.endColumn)}`;
}

/** True when `outer` contains `inner` (equal spans count). */
function contains(outer: Span, inner: Span): boolean {
  const startsFirst =
    outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn);
  const endsLast =
    inner.endLine < outer.endLine || (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
  return startsFirst && endsLast;
}

/** True when `outer` contains `inner` and they are not the same span (equal spans are siblings, never nested). */
function strictlyContains(outer: Span, inner: Span): boolean {
  return !sameSpan(outer, inner) && contains(outer, inner);
}

/** Captures of one query kind grouped by match index, in order of first appearance; each group in position order. */
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
  return [...groups.values()].map((group) =>
    [...group].sort((a, b) => compareStart(a.span, b.span) || compareEndDescending(a.span, b.span) || compareStrings(a.name, b.name)),
  );
}

function firstNamed(group: readonly Capture[], name: string): Capture | undefined {
  return group.find((capture) => capture.name === name);
}

/** Remove exactly one pair of matching surrounding quotes (double, single or backtick) when both are present. */
function unquote(text: string): string {
  const first = text[0];
  if (text.length >= 2 && (first === '"' || first === "'" || first === '`') && text.endsWith(first)) {
    return text.slice(1, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// Definitions (tags query)

interface SymbolDraft {
  readonly name: string;
  readonly kind: string;
  readonly span: Span;
  /** The span of the `name` capture: a reference site at this span is the declaration itself, not a use. */
  readonly nameSpan: Span;
  /** Set by the definition match's own `export` capture. */
  readonly exportSpan: Span | undefined;
  exported: boolean;
  parent?: number;
  qualifiedName: string;
}

/** One draft per tags match that has a `definition.<kind>` and a non-empty `name`; the rest are counted. */
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
    const exporting = firstNamed(group, 'export');
    drafts.push({
      name: name.text,
      kind: definition.name.slice(DEFINITION_PREFIX.length),
      span: definition.span,
      nameSpan: name.span,
      exportSpan: exporting?.span,
      exported: exporting !== undefined,
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
    for (
      let top = stack[stack.length - 1];
      top !== undefined && !strictlyContains(top.draft.span, draft.span);
      top = stack[stack.length - 1]
    ) {
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
    ...(draft.exported ? { exported: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Imports (imports query)

interface PositionedBinding {
  readonly at: Span;
  readonly binding: ImportBinding;
}

interface ImportDraft {
  readonly span: Span;
  style: ImportStyle | undefined;
  path: string;
  readonly bindings: PositionedBinding[];
}

function importStyleOf(capture: Capture): ImportStyle | undefined {
  if (!capture.name.startsWith(IMPORT_PREFIX)) {
    return undefined;
  }
  const suffix = capture.name.slice(IMPORT_PREFIX.length);
  return (IMPORT_STYLES as readonly string[]).includes(suffix) ? (suffix as ImportStyle) : undefined;
}

/** The bindings one match carries, in position order. `import.local` aliases the `import.named` before it. */
function bindingsOf(group: readonly Capture[]): PositionedBinding[] {
  const out: PositionedBinding[] = [];
  let lastNamed: PositionedBinding | undefined;
  for (const capture of group) {
    if (capture.text === '') {
      continue;
    }
    switch (capture.name) {
      case 'import.default':
        out.push({ at: capture.span, binding: { imported: 'default', local: capture.text } });
        break;
      case 'import.namespace':
        out.push({ at: capture.span, binding: { imported: '*', local: capture.text } });
        break;
      case 'import.named':
        lastNamed = { at: capture.span, binding: { imported: capture.text, local: capture.text } };
        out.push(lastNamed);
        break;
      case 'import.local':
        if (lastNamed !== undefined) {
          const index = out.indexOf(lastNamed);
          lastNamed = { at: lastNamed.at, binding: { imported: lastNamed.binding.imported, local: capture.text } };
          out[index] = lastNamed;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * One draft per statement span: matches that share the statement merge. A match with no statement
 * keys on its path capture. A match with import captures but neither is an orphan and is counted.
 */
function collectImports(captures: readonly Capture[]): { drafts: ImportDraft[]; orphans: number } {
  const drafts = new Map<string, ImportDraft>();
  let orphans = 0;
  for (const group of groupByMatch(captures, 'imports')) {
    if (!group.some((capture) => capture.name.startsWith(IMPORT_PREFIX))) {
      continue;
    }
    const statement = group.find((capture) => importStyleOf(capture) !== undefined);
    const pathCapture = firstNamed(group, 'import.path');
    const span = statement?.span ?? pathCapture?.span;
    if (span === undefined) {
      orphans += 1;
      continue;
    }
    const key = spanKey(span);
    let draft = drafts.get(key);
    if (draft === undefined) {
      draft = { span, style: undefined, path: '', bindings: [] };
      drafts.set(key, draft);
    }
    if (statement !== undefined && draft.style === undefined) {
      draft.style = importStyleOf(statement);
    }
    if (pathCapture !== undefined && draft.path === '') {
      draft.path = unquote(pathCapture.text);
    }
    for (const bound of bindingsOf(group)) {
      const duplicate = draft.bindings.some(
        (existing) =>
          sameSpan(existing.at, bound.at) &&
          existing.binding.imported === bound.binding.imported &&
          existing.binding.local === bound.binding.local,
      );
      if (!duplicate) {
        draft.bindings.push(bound);
      }
    }
  }
  return { drafts: [...drafts.values()], orphans };
}

function toImportSite(draft: ImportDraft): ImportSite {
  const bindings = [...draft.bindings].sort((a, b) => compareStart(a.at, b.at) || compareEndAscending(a.at, b.at));
  return {
    path: draft.path,
    span: draft.span,
    ...(draft.style === undefined ? {} : { style: draft.style }),
    ...(bindings.length === 0 ? {} : { bindings: bindings.map((bound) => bound.binding) }),
  };
}

// ---------------------------------------------------------------------------------------------
// Exports (imports query `export*` captures, and definition matches with an `export` capture)

function collectExports(captures: readonly Capture[], symbols: readonly SymbolDraft[]): { sites: ExportSite[]; skipped: number } {
  const byKey = new Map<string, ExportSite>();
  const add = (site: ExportSite): void => {
    const key = `${site.name}\u0000${spanKey(site.span)}`;
    if (!byKey.has(key)) {
      byKey.set(key, site);
    }
  };
  let skipped = 0;
  for (const group of groupByMatch(captures, 'imports')) {
    const statement = firstNamed(group, 'export');
    const name = firstNamed(group, 'export.name');
    if (statement === undefined && name === undefined) {
      continue;
    }
    if (name === undefined || name.text === '') {
      skipped += 1;
      continue;
    }
    const local = firstNamed(group, 'export.local');
    const from = firstNamed(group, 'export.from');
    const fromText = from === undefined ? '' : unquote(from.text);
    add({
      name: name.text,
      ...(local === undefined || local.text === '' ? {} : { local: local.text }),
      span: (statement ?? name).span,
      ...(fromText === '' ? {} : { from: fromText }),
    });
  }
  for (const symbol of symbols) {
    if (symbol.exportSpan !== undefined) {
      add({ name: symbol.name, local: symbol.name, span: symbol.exportSpan });
    }
  }
  const sites = [...byKey.values()].sort(
    (a, b) => compareStart(a.span, b.span) || compareEndDescending(a.span, b.span) || compareStrings(a.name, b.name),
  );
  return { sites, skipped };
}

// ---------------------------------------------------------------------------------------------
// Reference sites (refs query)

/**
 * The index of the innermost symbol containing a site, for sites visited in ascending start order.
 * `symbols` is in the extractor's order, so the last symbol that starts at or before the site is
 * either the innermost container or a finished sibling, and walking up its parents finds the container.
 */
function enclosingFinder(symbols: readonly LocalSymbol[]): (site: Span) => number | undefined {
  let cursor = -1;
  return (site) => {
    for (let next = symbols[cursor + 1]; next !== undefined && compareStart(next.span, site) <= 0; next = symbols[cursor + 1]) {
      cursor += 1;
    }
    let index = cursor;
    while (index >= 0) {
      const symbol = symbols[index];
      if (symbol === undefined || contains(symbol.span, site)) {
        break;
      }
      index = symbol.parent ?? -1;
    }
    return index >= 0 ? index : undefined;
  };
}

interface Scope {
  readonly topLevelNames: ReadonlySet<string>;
  readonly importPaths: ReadonlyMap<string, string>;
  readonly exportNames: ReadonlySet<string>;
  readonly declarationSpans: ReadonlySet<string>;
}

function collectRefSites(captures: readonly Capture[], symbols: readonly LocalSymbol[], scope: Scope): RefSite[] {
  const candidates = new Map<string, { name: string; kind: RefKind; span: Span }>();
  for (const capture of captures) {
    if (capture.query !== 'refs' || !capture.name.startsWith(REFERENCE_PREFIX) || capture.text === '') {
      continue;
    }
    const kind = capture.name.slice(REFERENCE_PREFIX.length);
    if (!(REF_KINDS as readonly string[]).includes(kind)) {
      continue;
    }
    const name = capture.text;
    const inScope =
      kind === 'member' || scope.topLevelNames.has(name) || scope.importPaths.has(name) || scope.exportNames.has(name);
    if (!inScope || scope.declarationSpans.has(spanKey(capture.span))) {
      continue;
    }
    candidates.set(`${kind}\u0000${name}\u0000${spanKey(capture.span)}`, { name, kind: kind as RefKind, span: capture.span });
  }
  const ordered = [...candidates.values()].sort(
    (a, b) =>
      compareStart(a.span, b.span) ||
      compareEndAscending(a.span, b.span) ||
      compareStrings(a.name, b.name) ||
      compareStrings(a.kind, b.kind),
  );
  const enclosingOf = enclosingFinder(symbols);
  return ordered.map((site): RefSite => {
    const enclosing = enclosingOf(site.span);
    const importPath = site.kind === 'member' ? undefined : scope.importPaths.get(site.name);
    return {
      name: site.name,
      span: site.span,
      kind: site.kind,
      ...(importPath === undefined ? {} : { importPath }),
      ...(enclosing === undefined ? {} : { enclosing }),
    };
  });
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

  const defined = collectDefinitions(run.captures);
  const drafts = orderAndNest(defined.drafts);
  const exported = collectExports(run.captures, drafts);

  // An export site that names a local top-level symbol (and is not a re-export) marks it exported.
  const exportedLocals = new Set(
    exported.sites.filter((site) => site.from === undefined).map((site) => site.local ?? site.name),
  );
  for (const draft of drafts) {
    if (draft.parent === undefined && exportedLocals.has(draft.name)) {
      draft.exported = true;
    }
  }
  const symbols = drafts.map(toSymbol);

  const collectedImports = collectImports(run.captures);
  const importSites = collectedImports.drafts
    .map(toImportSite)
    .sort(
      (a, b) => compareStart(a.span, b.span) || compareEndDescending(a.span, b.span) || compareStrings(a.path, b.path),
    );
  const imports: ImportSite[] = [];
  let pathSkipped = collectedImports.orphans;
  const importPaths = new Map<string, string>();
  for (const site of importSites) {
    if (site.path === '') {
      pathSkipped += 1;
      continue;
    }
    imports.push(site);
    for (const binding of site.bindings ?? []) {
      if (!importPaths.has(binding.local)) {
        importPaths.set(binding.local, site.path);
      }
    }
  }

  const refSites = collectRefSites(run.captures, symbols, {
    topLevelNames: new Set(drafts.filter((draft) => draft.parent === undefined).map((draft) => draft.name)),
    importPaths,
    exportNames: new Set(exported.sites.map((site) => site.name)),
    declarationSpans: new Set(drafts.map((draft) => spanKey(draft.nameSpan))),
  });

  const nameSkipped = defined.skipped + exported.skipped;
  if (nameSkipped > 0) {
    diagnostics.push(
      diagnostic(
        'match_missing_name',
        'info',
        countMessage(nameSkipped, 'matches without a name capture (definition.<kind> with name, or export.name)'),
        input.path,
      ),
    );
  }
  if (pathSkipped > 0) {
    diagnostics.push(
      diagnostic(
        'match_missing_path',
        'info',
        countMessage(pathSkipped, 'import statements without an import.path capture'),
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
    refSites,
    imports,
    exports: exported.sites,
    parse: { errorBytes: run.errorBytes, totalBytes: run.totalBytes },
  };
  return { facts, diagnostics };
}
