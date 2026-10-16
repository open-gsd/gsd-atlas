/**
 * The Query seam: one `ask(request)` that returns the full envelope (query-and-policy ADR). Adapters (CLI, MCP
 * shim, hooks) reach it through the HostClient; they never import this module directly.
 */
export { DEFAULT_QUERY_CONFIG, resolveQueryConfig } from './defaults.ts';
export { createQuery } from './query.ts';
export { TOOLS, TOOL_NAMES, buildRequest } from './tools.ts';
export type { ToolDefinition, ToolName } from './tools.ts';
export type { FreshPort, FreshReport, Query, QueryConfig, QueryDeps } from './types.ts';
