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
 * - `comment` (optional, plan 03-24) on a comment node, alone in its match. A module's query filters it with
 *   a `#match?` predicate so only comments that mention an ADR cross the engine boundary; the extractor scans
 *   the text for `ADR-<n>`, `ADR <n>` and `ADR #<n>` (see `scanAdrMentions`) and turns each mention into a
 *   `CitationSite`. The engine keeps the text of a `comment` up to 65,536 UTF-16 units (`GRAMMAR_LIMITS`); a
 *   longer one arrives empty and is counted in the info diagnostic `citation_comment_too_long`. A comment
 *   match is never a "match without a name".
 *
 * Imports query (`queries/imports.scm`): imports and exports, because a manifest has exactly three
 * query files.
 * - The statement node is captured as `import.es`, `import.cjs`, `import.side-effect` or
 *   `import.reexport`; the suffix is `ImportSite.style` and the node's span is the site's span.
 * - `import.path` on the path string (one pair of surrounding quotes is removed). Required: a
 *   statement without it is skipped and counted.
 * - Per-binding captures: `import.default` (local name), `import.namespace` (local name),
 *   `import.named` (the imported name) with `import.local` for the local alias when it differs
 *   (after the `import.named`, or before it when the local name is written first, as in
 *   `const local = require(path).named`).
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
 * - Citations come from comment nodes only (never from strings, templates or regular expressions, which
 *   the grammar does not report as comments). A mention belongs to the innermost symbol containing it, else
 *   to the symbol a leading doc comment documents, else to none. Only the integer, a short `§` detail and
 *   the span of the mention are kept; comment text never leaves this module.
 * - It never throws on a malformed match: the match is skipped and counted in an info diagnostic
 *   (`match_missing_name`, `match_missing_path`, `citation_comment_too_long`).
 */
import { IMPORT_STYLES, MAX_CITATIONS_PER_FILE, REF_KINDS, diagnostic } from '../facts/index.ts';
import type {
  CitationSite,
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
  /** Info diagnostics `match_missing_name`, `match_missing_path` and `citation_comment_too_long`; never fatal. */
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
// ADR mentions in comments (tags query capture `comment`)

/** One ADR mention found in the text of a comment: where it starts and ends in that text, its number and detail. */
export interface AdrMention {
  readonly index: number;
  readonly end: number;
  readonly number: number;
  readonly detail?: string;
}

/** A step counter a test passes in to prove the scan is linear: it counts every character the scan looks at. */
export interface ScanProbe {
  steps: number;
}

/** The most characters of a section token kept after the `§` of a mention. */
const CITATION_TOKEN_MAX = 16;

/** The longest digit string that can still be a safe integer (`9007199254740991` has 16 digits). */
const SAFE_DIGITS_MAX = 16;

const CHAR_A = 0x61;
const CHAR_D = 0x64;
const CHAR_R = 0x72;
const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;
const CHAR_SPACE = 0x20;
const CHAR_HYPHEN = 0x2d;
const CHAR_HASH = 0x23;
const CHAR_DOT = 0x2e;
const CHAR_SECTION = 0xa7;

const isDigitCode = (code: number): boolean => code >= CHAR_ZERO && code <= CHAR_NINE;

/** ASCII letters, digits and underscore: the characters that make `quadr-5` or `ADR_9` not a mention. */
function isWordCode(code: number): boolean {
  return (
    isDigitCode(code) || (code >= 0x41 && code <= 0x5a) || (code >= CHAR_A && code <= 0x7a) || code === 0x5f
  );
}

/** A character a section token may hold: an ASCII letter, a digit or a dot. */
function isTokenCode(code: number): boolean {
  return isDigitCode(code) || (code >= 0x41 && code <= 0x5a) || (code >= CHAR_A && code <= 0x7a) || code === CHAR_DOT;
}

/**
 * Find the ADR mentions in the text of one comment (D-19): `ADR-<n>`, `ADR <n>`, `ADR #<n>` and `ADR#<n>`, in any
 * letter case, at a word boundary (the start of the text or a character that is not a letter, digit or underscore),
 * with an optional section suffix, at most one space and a `§` plus up to 16 letters, digits or dots (trailing dots
 * trimmed, so `ADR-1 §3.` keeps `§3`).
 *
 * The number is the digit run after the separator, compared by value: leading zeros are dropped, `0` and anything
 * beyond the safe integers is no citation, and a letter after the digits does not extend the number (`ADR-1a` is 1).
 * A malformed mention (`ADR-`, `ADR - 1`) is skipped, never guessed.
 *
 * One pass, no backtracking: every position is looked at once, and a digit run is consumed once and then skipped, so
 * the work is linear in the length of the text whatever its shape (`probe.steps` counts it for the tests).
 */
export function scanAdrMentions(text: string, probe?: ScanProbe): AdrMention[] {
  const found: AdrMention[] = [];
  const length = text.length;
  let steps = 0;
  let at = 0;
  while (at < length) {
    steps += 1;
    // Cheapest test first: `A` or `a` (0x41 | 0x20 and 0x61 are the only code units that give 0x61).
    if ((text.charCodeAt(at) | 0x20) !== CHAR_A || (at > 0 && isWordCode(text.charCodeAt(at - 1)))) {
      at += 1;
      continue;
    }
    if ((text.charCodeAt(at + 1) | 0x20) !== CHAR_D || (text.charCodeAt(at + 2) | 0x20) !== CHAR_R) {
      at += 1;
      continue;
    }
    let cursor = at + 3;
    const separator = text.charCodeAt(cursor);
    if (separator === CHAR_HYPHEN || separator === CHAR_HASH) {
      cursor += 1;
    } else if (separator === CHAR_SPACE) {
      cursor += 1;
      if (text.charCodeAt(cursor) === CHAR_HASH) {
        cursor += 1;
      }
    } else {
      at += 1;
      continue;
    }
    const digitsStart = cursor;
    while (cursor < length && isDigitCode(text.charCodeAt(cursor))) {
      cursor += 1;
      steps += 1;
    }
    if (cursor === digitsStart) {
      at += 1;
      continue;
    }
    let significant = digitsStart;
    while (significant < cursor - 1 && text.charCodeAt(significant) === CHAR_ZERO) {
      significant += 1;
      steps += 1;
    }
    const digits = cursor - significant;
    const value = digits <= SAFE_DIGITS_MAX ? Number(text.slice(significant, cursor)) : Number.NaN;
    let end = cursor;
    let detail: string | undefined;
    if (Number.isSafeInteger(value) && value > 0) {
      let section = cursor;
      if (text.charCodeAt(section) === CHAR_SPACE) {
        section += 1;
      }
      if (text.charCodeAt(section) === CHAR_SECTION) {
        let tokenEnd = section + 1;
        const limit = Math.min(length, tokenEnd + CITATION_TOKEN_MAX);
        while (tokenEnd < limit && isTokenCode(text.charCodeAt(tokenEnd))) {
          tokenEnd += 1;
          steps += 1;
        }
        while (tokenEnd > section + 1 && text.charCodeAt(tokenEnd - 1) === CHAR_DOT) {
          tokenEnd -= 1;
        }
        if (tokenEnd > section + 1) {
          detail = text.slice(section, tokenEnd);
          end = tokenEnd;
        }
      }
      found.push({ index: at, end, number: value, ...(detail === undefined ? {} : { detail }) });
    }
    // The digits (and the detail) belong to this mention: nothing inside them can start another.
    at = end;
  }
  if (probe !== undefined) {
    probe.steps += steps;
  }
  return found;
}

interface CommentDraft {
  readonly number: number;
  readonly detail: string | undefined;
  readonly span: Span;
}

/**
 * The mentions of every `comment` capture of the tags query, each with the span of the mention itself. A comment
 * whose text was dropped by the engine (over the 65,536-unit bound) is counted and yields nothing. Only the number,
 * the detail and the span leave this function; the comment text is read here and never kept.
 */
function collectCitationDrafts(captures: readonly Capture[]): {
  drafts: CommentDraft[];
  comments: Span[];
  tooLong: number;
} {
  const drafts: CommentDraft[] = [];
  const comments: Span[] = [];
  let tooLong = 0;
  for (const capture of captures) {
    if (capture.query !== 'tags' || capture.name !== 'comment') {
      continue;
    }
    if (capture.text === '') {
      tooLong += 1;
      continue;
    }
    comments.push(capture.span);
    // Lines and columns of each mention come from the capture's start and the text before it: rows count LF only,
    // columns count UTF-16 units from the last LF (or from the capture's own column on its first line).
    let line = capture.span.startLine;
    let lineStart = -capture.span.startColumn;
    let nextLf = capture.text.indexOf('\n');
    for (const mention of scanAdrMentions(capture.text)) {
      while (nextLf !== -1 && nextLf < mention.index) {
        line += 1;
        lineStart = nextLf + 1;
        nextLf = capture.text.indexOf('\n', lineStart);
      }
      drafts.push({
        number: mention.number,
        detail: mention.detail,
        span: {
          startLine: line,
          startColumn: mention.index - lineStart,
          endLine: line,
          endColumn: mention.end - lineStart,
        },
      });
    }
  }
  return { drafts, comments, tooLong };
}

/**
 * Attach each mention to a symbol and order the citations by position. A mention belongs to the innermost symbol
 * that contains it; failing that, to the symbol a leading doc comment documents (the first symbol that starts at
 * or after the comment's end, on the comment's last line or the next one, unless the comment trails a symbol on
 * its own line); failing that, to none (a file-level mention). The cap keeps the first
 * `MAX_CITATIONS_PER_FILE` in position order.
 */
function attachCitations(
  drafts: readonly CommentDraft[],
  comments: readonly Span[],
  symbols: readonly LocalSymbol[],
): CitationSite[] {
  const ordered = [...drafts].sort(
    (a, b) => compareStart(a.span, b.span) || compareEndAscending(a.span, b.span) || a.number - b.number,
  );
  const enclosingOf = enclosingFinder(symbols);
  return ordered.slice(0, MAX_CITATIONS_PER_FILE).map((draft): CitationSite => {
    let enclosing = enclosingOf(draft.span);
    if (enclosing === undefined) {
      const comment = comments.find((span) => contains(span, draft.span));
      if (comment !== undefined) {
        enclosing = documentedSymbol(symbols, comment);
      }
    }
    return {
      number: draft.number,
      ...(draft.detail === undefined ? {} : { detail: draft.detail }),
      span: draft.span,
      ...(enclosing === undefined ? {} : { enclosing }),
    };
  });
}

/** The index of the symbol a comment documents, or undefined; see `attachCitations`. */
function documentedSymbol(symbols: readonly LocalSymbol[], comment: Span): number | undefined {
  const trails = symbols.some(
    (symbol) =>
      symbol.span.endLine === comment.startLine &&
      symbol.span.endColumn <= comment.startColumn &&
      compareStart(symbol.span, comment) < 0,
  );
  if (trails) {
    return undefined;
  }
  const index = symbols.findIndex(
    (symbol) =>
      (symbol.span.startLine > comment.endLine ||
        (symbol.span.startLine === comment.endLine && symbol.span.startColumn >= comment.endColumn)) &&
      symbol.span.startLine <= comment.endLine + 1,
  );
  return index >= 0 ? index : undefined;
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
    if (definition === undefined && name === undefined && firstNamed(group, 'comment') !== undefined) {
      continue; // the ADR mention filter of the tags query: a comment, not a definition (read by the citation pass)
    }
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

/**
 * The bindings one match carries, in position order. `import.local` aliases the `import.named` before it;
 * an `import.local` that comes before every `import.named` of the match (`const local = require(p).named`)
 * aliases the first one after it.
 */
function bindingsOf(group: readonly Capture[]): PositionedBinding[] {
  const out: PositionedBinding[] = [];
  let lastNamed: PositionedBinding | undefined;
  let leadingLocal: string | undefined;
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
        lastNamed = { at: capture.span, binding: { imported: capture.text, local: leadingLocal ?? capture.text } };
        leadingLocal = undefined;
        out.push(lastNamed);
        break;
      case 'import.local':
        if (lastNamed !== undefined) {
          const index = out.indexOf(lastNamed);
          lastNamed = { at: lastNamed.at, binding: { imported: lastNamed.binding.imported, local: capture.text } };
          out[index] = lastNamed;
        } else {
          leadingLocal = capture.text;
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

  const cited = collectCitationDrafts(run.captures);
  const citations = attachCitations(cited.drafts, cited.comments, symbols);

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

  if (cited.tooLong > 0) {
    diagnostics.push(
      diagnostic(
        'citation_comment_too_long',
        'info',
        countMessage(cited.tooLong, 'comments that mention an ADR but are over the comment size bound'),
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
    ...(citations.length === 0 ? {} : { citations }),
    parse: { errorBytes: run.errorBytes, totalBytes: run.totalBytes },
  };
  return { facts, diagnostics };
}
