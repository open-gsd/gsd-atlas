import { diagnostic } from './diagnostic.ts';
import type { Diagnostic } from './diagnostic.ts';
import { isValidSpan } from './span.ts';
import type { Span } from './span.ts';

/**
 * The fixed fact vocabulary for this release (fact-model ADR decision 2). The vocabulary is a
 * logical enum; storage is typed tables. New predicates need an ADR.
 */
export const FACT_PREDICATES = [
  'defines',
  'contains',
  'imports',
  'reexports',
  'calls',
  'references',
  'extends',
  'extension_of',
  'implements',
  'conforms_to',
  'overrides',
  'tested_by',
  'emitted_as',
  'cites_adr',
  'uses_sdk_symbol',
  'targets_platform',
] as const;

export type FactPredicate = (typeof FACT_PREDICATES)[number];

/** Confidence tiers in gsd-graph's names (fact-model ADR decision 4). */
export type Confidence = 'EXTRACTED' | 'INFERRED';

/**
 * What a reference site does with its name (Phase 2, research Pitfall 1). Closed set: scoping
 * (D-06), ranking (D-08) and code_impact read it. Every field added in Phase 2 is optional, so a
 * Phase 1 shaped value stays valid.
 */
export const REF_KINDS = ['call', 'new', 'read', 'type', 'heritage', 'member'] as const;

export type RefKind = (typeof REF_KINDS)[number];

/** How an import is written. Closed set; optional on `ImportSite`. */
export const IMPORT_STYLES = ['es', 'cjs', 'side-effect', 'reexport'] as const;

export type ImportStyle = (typeof IMPORT_STYLES)[number];

/** A definition found in one file. */
export interface LocalSymbol {
  readonly name: string;
  readonly kind: string;
  readonly qualifiedName?: string;
  readonly span: Span;
  /** Index into the enclosing `FileFacts.symbols` array of the containing symbol. */
  readonly parent?: number;
  /** True when the definition is visible outside its file (optional, Phase 2). */
  readonly exported?: boolean;
}

/** A reference site: a name (and import path, as written) at a span. */
export interface RefSite {
  readonly name: string;
  readonly span: Span;
  readonly importPath?: string;
  /** What the site does with the name (optional, Phase 2). */
  readonly kind?: RefKind;
  /**
   * Index into `FileFacts.symbols` of the innermost symbol containing the site; absent for a
   * top-level site (optional, Phase 2).
   */
  readonly enclosing?: number;
}

/**
 * One name bound by an import. `imported` is the exported name, `default` for a default import
 * and `*` for a namespace import; `local` is the name bound in this file.
 */
export interface ImportBinding {
  readonly imported: string;
  readonly local: string;
}

/** An import as written in the source. */
export interface ImportSite {
  readonly path: string;
  readonly span: Span;
  /** How the import is written (optional, Phase 2). */
  readonly style?: ImportStyle;
  /** The names the import binds (optional, Phase 2). */
  readonly bindings?: readonly ImportBinding[];
}

/** One export of a file (optional, Phase 2). `from` is set for a re-export of another module. */
export interface ExportSite {
  /** The name other files import. */
  readonly name: string;
  /** The local name it exports, when that differs from `name`. */
  readonly local?: string;
  readonly span: Span;
  /** The module path of a re-export. */
  readonly from?: string;
}

/**
 * Local facts of one file, keyed by content hash. This is the only value that crosses from the
 * Grammar Engine to the Fact Store; `validateFileFacts` must pass before the writer commits it.
 */
export interface FileFacts {
  readonly path: string;
  readonly contentHash: string;
  readonly module: string;
  readonly grammarVersion: string;
  readonly symbols: readonly LocalSymbol[];
  readonly refSites: readonly RefSite[];
  readonly imports: readonly ImportSite[];
  /** The file's exports (optional, Phase 2). */
  readonly exports?: readonly ExportSite[];
  readonly parse: { readonly errorBytes: number; readonly totalBytes: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function isOneOf(set: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && set.includes(value);
}

/** An absent index is fine; a present one must be an integer inside `0 .. count - 1`. */
function checkIndex(
  value: unknown,
  count: number,
  message: string,
  invalid: (message: string) => void,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= count) {
    invalid(message);
  }
}

function checkBindings(
  bindings: unknown,
  where: string,
  invalid: (message: string) => void,
): void {
  if (bindings === undefined) {
    return;
  }
  if (!Array.isArray(bindings)) {
    invalid(`${where} has bindings that are not an array`);
    return;
  }
  bindings.forEach((binding: unknown, at) => {
    if (!isRecord(binding) || !isNonEmptyString(binding.imported) || !isNonEmptyString(binding.local)) {
      invalid(`${where} has a binding at index ${at} without an imported and a local name`);
    }
  });
}

/**
 * Check a candidate FileFacts value. Returns an empty array when it is well formed.
 * The Phase 2 fields (`exported`, `kind`, `enclosing`, `style`, `bindings`, `exports`) are all
 * optional, so a Phase 1 shaped value still validates; when present they are checked, and
 * `enclosing` and `parent` must index into `symbols`.
 * A symbol, reference site or import without a valid span is rejected (code `span_missing`
 * or `span_invalid`), because a fact without a span can not exist.
 */
export function validateFileFacts(value: unknown): Diagnostic[] {
  if (!isRecord(value)) {
    return [diagnostic('facts_invalid', 'error', 'FileFacts must be an object')];
  }
  const subject = typeof value.path === 'string' ? value.path : undefined;
  const out: Diagnostic[] = [];

  if (subject === undefined) {
    out.push(diagnostic('facts_invalid', 'error', 'FileFacts.path must be a string'));
  }

  const groups: ReadonlyArray<readonly [string, string, boolean]> = [
    ['symbols', 'symbol', true],
    ['refSites', 'ref site', true],
    ['imports', 'import', true],
    ['exports', 'export', false],
  ];
  const symbolCount = Array.isArray(value.symbols) ? value.symbols.length : 0;
  const invalid = (message: string): void => {
    out.push(diagnostic('facts_invalid', 'error', message, subject));
  };
  for (const [field, label, required] of groups) {
    const items = value[field];
    if (items === undefined && !required) {
      continue;
    }
    if (!Array.isArray(items)) {
      invalid(`FileFacts.${field} must be an array`);
      continue;
    }
    items.forEach((item: unknown, index) => {
      const span = isRecord(item) ? item.span : undefined;
      if (span === undefined || span === null) {
        out.push(
          diagnostic('span_missing', 'error', `${label} at index ${index} has no span`, subject),
        );
      } else if (!isValidSpan(span)) {
        out.push(
          diagnostic('span_invalid', 'error', `${label} at index ${index} has an invalid span`, subject),
        );
      }
      if (!isRecord(item)) {
        return;
      }
      const where = `${label} at index ${index}`;
      switch (field) {
        case 'symbols':
          checkIndex(item.parent, symbolCount, `${where} has a parent outside the symbols array`, invalid);
          if (item.exported !== undefined && typeof item.exported !== 'boolean') {
            invalid(`${where} has an exported flag that is not a boolean`);
          }
          break;
        case 'refSites':
          checkIndex(item.enclosing, symbolCount, `${where} has an enclosing symbol outside the symbols array`, invalid);
          if (item.kind !== undefined && !isOneOf(REF_KINDS, item.kind)) {
            invalid(`${where} has an unknown reference kind`);
          }
          break;
        case 'imports':
          if (item.style !== undefined && !isOneOf(IMPORT_STYLES, item.style)) {
            invalid(`${where} has an unknown import style`);
          }
          checkBindings(item.bindings, where, invalid);
          break;
        case 'exports':
          if (!isNonEmptyString(item.name)) {
            invalid(`${where} has no name`);
          }
          break;
      }
    });
  }

  const parse = value.parse;
  if (
    !isRecord(parse) ||
    !isNonNegativeNumber(parse.errorBytes) ||
    !isNonNegativeNumber(parse.totalBytes)
  ) {
    out.push(
      diagnostic(
        'parse_invalid',
        'error',
        'FileFacts.parse.errorBytes and totalBytes must be non-negative numbers',
        subject,
      ),
    );
  }

  return out;
}
