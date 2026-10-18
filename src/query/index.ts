/**
 * The Query seam: one `ask(request)` that returns the full envelope (query-and-policy ADR). Adapters (CLI, MCP
 * shim, hooks) reach it through the HostClient; they never import this module directly.
 */
export { DEFAULT_QUERY_CONFIG, resolveQueryConfig } from './defaults.ts';
export { ERROR_SCHEMA, errorEnvelope } from './envelope.ts';
export { createQuery } from './query.ts';
export { BUG_HINT, HEALTH_REASONS, POLICY_OFF } from './status.ts';
export type { HealthReason, StatusSnapshot } from './status.ts';
export { TOOLS, TOOL_NAMES, buildRequest } from './tools.ts';
export type { ToolDefinition, ToolName } from './tools.ts';
export { EXPLAIN_MESSAGES, MAX_ANSWER_FACTS } from './explain.ts';
export type {
  AdrLookup,
  AdrPort,
  AdrStatus,
  Edge,
  ExplainPort,
  FreshPort,
  FreshReport,
  IndexerStatusLike,
  PolicyMode,
  PreciseState,
  Query,
  QueryConfig,
  QueryDeps,
  RecordedAnswer,
  StatusPort,
  TierActive,
  TierInfo,
} from './types.ts';
