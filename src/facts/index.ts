/**
 * The shared kernel: a dependency-free leaf (relative imports and node: built-ins only).
 * Every seam imports these types through this file and nothing else in src/facts.
 */
export { isValidSpan } from './span.ts';
export type { Span } from './span.ts';
export { isInside } from './inside.ts';
export { diagnostic } from './diagnostic.ts';
export type { Diagnostic, Severity } from './diagnostic.ts';
export { systemClock } from './clock.ts';
export type { Clock } from './clock.ts';
export { FACT_PREDICATES, IMPORT_STYLES, MAX_CITATIONS_PER_FILE, REF_KINDS, validateFileFacts } from './file-facts.ts';
export type {
  CitationGaps,
  CitationSite,
  Confidence,
  ExportSite,
  FactPredicate,
  FileFacts,
  ImportBinding,
  ImportSite,
  ImportStyle,
  LocalSymbol,
  RefKind,
  RefSite,
} from './file-facts.ts';
export { DEGRADED_CODES, isDegradedCode } from './degraded.ts';
export type { DegradedCode } from './degraded.ts';
export type { Answer, Watermark } from './answer.ts';
export { ANSWER_ID_PATTERN, SESSION_ID_PATTERN, createAnswerId, createSessionId, isAnswerId, isSessionId } from './answer-id.ts';
export { PROTOCOL_VERSION, failEnvelope, okEnvelope } from './request.ts';
export type {
  Citation,
  Envelope,
  EnvelopeExtras,
  Request,
  UntrustedEntry,
  UntrustedText,
} from './request.ts';
export {
  DEFAULT_PROJECT_CONTEXT,
  RELATION_KINDS,
  ResolverFailure,
  degradedCodeOf,
  isRelationKind,
  isResolverNotice,
  symbolKey,
} from './resolution.ts';
export type {
  CompilerFacts,
  EmitLookup,
  LocatedSymbol,
  OverlaySnapshot,
  PreciseFacts,
  ProjectContext,
  ProjectContextProvider,
  RefSiteKey,
  RelationKind,
  RelationsPort,
  ResolutionContext,
  ResolvedEdge,
  ResolvedRelation,
  ResolveScope,
  NoticingResolverPort,
  ResolverNotice,
  ResolverPort,
  SymbolIdentity,
  SymbolLookup,
} from './resolution.ts';
