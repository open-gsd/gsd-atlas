/**
 * The shared kernel: a dependency-free leaf (relative imports and node: built-ins only).
 * Every seam imports these types through this file and nothing else in src/facts.
 */
export { isValidSpan } from './span.ts';
export type { Span } from './span.ts';
export { diagnostic } from './diagnostic.ts';
export type { Diagnostic, Severity } from './diagnostic.ts';
export { systemClock } from './clock.ts';
export type { Clock } from './clock.ts';
export { FACT_PREDICATES, validateFileFacts } from './file-facts.ts';
export type {
  Confidence,
  FactPredicate,
  FileFacts,
  ImportSite,
  LocalSymbol,
  RefSite,
} from './file-facts.ts';
