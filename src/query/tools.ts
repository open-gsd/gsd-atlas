// RED stub (plan 02-16, task 1): replaced by the real tool definitions in the GREEN commit.
import type { Request } from '../facts/index.ts';

export const TOOL_NAMES = ['code_find', 'code_refs', 'code_context', 'code_impact', 'atlas_status', 'lang_list'] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: { safeParse(value: unknown): { success: boolean } };
  readonly readOnlyHint: true;
}

export const TOOLS: readonly ToolDefinition[] = [];

export function buildRequest(_tool: ToolName, _input: Record<string, unknown>): Request {
  throw new Error('buildRequest is not implemented yet');
}
