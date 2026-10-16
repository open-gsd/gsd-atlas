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

/** A definition found in one file. */
export interface LocalSymbol {
  readonly name: string;
  readonly kind: string;
  readonly qualifiedName?: string;
  readonly span: Span;
  /** Index into the enclosing `FileFacts.symbols` array of the containing symbol. */
  readonly parent?: number;
}

/** A reference site: a name (and import path, as written) at a span. */
export interface RefSite {
  readonly name: string;
  readonly span: Span;
  readonly importPath?: string;
}

/** An import as written in the source. */
export interface ImportSite {
  readonly path: string;
  readonly span: Span;
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
  readonly parse: { readonly errorBytes: number; readonly totalBytes: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Check a candidate FileFacts value. Returns an empty array when it is well formed.
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

  const groups: ReadonlyArray<readonly [string, string]> = [
    ['symbols', 'symbol'],
    ['refSites', 'ref site'],
    ['imports', 'import'],
  ];
  for (const [field, label] of groups) {
    const items = value[field];
    if (!Array.isArray(items)) {
      out.push(diagnostic('facts_invalid', 'error', `FileFacts.${field} must be an array`, subject));
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
