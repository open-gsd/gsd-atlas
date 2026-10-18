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
export { FACT_PREDICATES, IMPORT_STYLES, REF_KINDS, validateFileFacts } from './file-facts.ts';
export type {
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
export { DEFAULT_PROJECT_CONTEXT, symbolKey } from './resolution.ts';
export type {
  EmitLookup,
  LocatedSymbol,
  OverlaySnapshot,
  ProjectContext,
  ProjectContextProvider,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  ResolveScope,
  ResolverPort,
  SymbolIdentity,
  SymbolLookup,
} from './resolution.ts';
