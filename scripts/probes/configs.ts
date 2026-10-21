/**
 * The session configurations of the exploratory probes, built from the registered arm definitions
 * (`scripts/eval/arms.ts`, read-only use) with small, named differences. Unscored; registers nothing.
 *
 * Every configuration keeps the registered isolation flags (`--setting-sources ""`, `--strict-mcp-config`,
 * `--no-session-persistence`, the answer schema) because `buildClaudeArgs` emits them.
 */
import { ARMS, SKILL_ALLOW_RULE, SKILL_TOOL, allowedToolsFor } from '../eval/arms.ts';
import type { SessionSpec } from '../eval/claude-session.ts';
import type { PatchOptions } from './patch-server.ts';
import { hookSettings } from './route-hook.ts';

export const CONFIG_IDS = [
  'grep',
  'atlas',
  'atlas-noskill',
  'atlas-3tools-deny',
  'atlas-3tools',
  'atlas-noinstr',
  'atlas-shortdesc',
  'atlas-ts',
  'atlas-ts-env',
  'atlas-noskill-ts',
  'atlas-routed',
  'atlas-routed-ts',
  'atlas-routed-capped',
  'atlas-capped',
] as const;
export type ConfigId = (typeof CONFIG_IDS)[number];

export interface PlanContext {
  mcpConfigPath: string;
  pluginDir: string;
  hookScript: string;
  answerSchema: string;
  model: string;
  maxBudgetUsd: number;
  wallClockMs: number;
}

export interface Plan {
  /** Whether the configuration uses the atlas MCP server (an index must exist for tool calls to answer). */
  atlas: boolean;
  /** Extra flags placed before the harness argv (flags the registered argv builder has no field for). */
  prefixArgs: string[];
  /** Set when the configuration needs a patched scratch copy of the server. */
  serverPatch?: PatchOptions;
  /** The session spec without `prompt`, `cwd`, `env` base and stream path (the driver adds them). */
  spec: Omit<SessionSpec, 'prompt' | 'cwd'>;
}

const THREE = ['code_find', 'code_refs', 'code_impact'];
const OTHER_FOUR = ['code_context', 'code_explain', 'atlas_status', 'lang_list'];
export const CAPPED_BUDGET_TOKENS = 1500;

const mcp = (name: string): string => `mcp__gsd-atlas__${name}`;

export function planFor(id: ConfigId, ctx: PlanContext): Plan {
  const base = {
    mcpConfigPath: ctx.mcpConfigPath,
    jsonSchema: ctx.answerSchema,
    model: ctx.model,
    maxBudgetUsd: ctx.maxBudgetUsd,
    wallClockMs: ctx.wallClockMs,
  };
  if (id === 'grep') {
    return { atlas: false, prefixArgs: [], spec: { ...base, tools: [...ARMS.grep.builtinTools], allowedTools: allowedToolsFor('grep'), pluginDirs: [] } };
  }
  // The registered atlas arm.
  const registered = {
    ...base,
    tools: [...ARMS.atlas.builtinTools],
    allowedTools: allowedToolsFor('atlas'),
    pluginDirs: [ctx.pluginDir],
    ...(ARMS.atlas.settings === undefined ? {} : { settings: ARMS.atlas.settings }),
  };
  // The same without the skill: no Skill tool, no plugin, no Skill allow rule.
  const noSkill = {
    ...base,
    tools: ARMS.atlas.builtinTools.filter((t) => t !== SKILL_TOOL),
    allowedTools: allowedToolsFor('atlas').filter((t) => t !== SKILL_ALLOW_RULE),
    pluginDirs: [] as string[],
  };
  const onlyTools = (spec: typeof noSkill, keep: readonly string[]): typeof noSkill => ({
    ...spec,
    allowedTools: spec.allowedTools.filter((t) => !t.startsWith('mcp__gsd-atlas__') || keep.includes(t)),
  });
  const withToolSearch = <T extends { tools: string[]; allowedTools: string[] }>(spec: T): T => ({
    ...spec,
    tools: [...spec.tools, 'ToolSearch'],
    allowedTools: [...spec.allowedTools, 'ToolSearch'],
  });
  switch (id) {
    case 'atlas':
      return { atlas: true, prefixArgs: [], spec: registered };
    case 'atlas-noskill':
      return { atlas: true, prefixArgs: [], spec: noSkill };
    case 'atlas-3tools-deny':
      return { atlas: true, prefixArgs: ['--disallowedTools', OTHER_FOUR.map(mcp).join(',')], spec: noSkill };
    case 'atlas-3tools':
      return { atlas: true, prefixArgs: [], serverPatch: { tools: THREE }, spec: onlyTools(noSkill, THREE.map(mcp)) };
    case 'atlas-noinstr':
      return { atlas: true, prefixArgs: [], serverPatch: { instructions: false }, spec: noSkill };
    case 'atlas-shortdesc':
      return { atlas: true, prefixArgs: [], serverPatch: { shortDescriptions: true }, spec: noSkill };
    case 'atlas-ts':
      return { atlas: true, prefixArgs: [], spec: withToolSearch(registered) };
    case 'atlas-ts-env':
      return { atlas: true, prefixArgs: [], spec: { ...withToolSearch(registered), env: { ENABLE_TOOL_SEARCH: 'true' } } };
    case 'atlas-noskill-ts':
      return { atlas: true, prefixArgs: [], spec: withToolSearch(noSkill) };
    case 'atlas-routed':
      return { atlas: true, prefixArgs: [], spec: { ...registered, settings: hookSettings(ARMS.atlas.settings ?? '{}', ctx.hookScript) } };
    case 'atlas-routed-ts':
      return { atlas: true, prefixArgs: [], spec: withToolSearch({ ...registered, settings: hookSettings(ARMS.atlas.settings ?? '{}', ctx.hookScript) }) };
    case 'atlas-routed-capped':
      return {
        atlas: true,
        prefixArgs: [],
        serverPatch: { budgetTokens: CAPPED_BUDGET_TOKENS },
        spec: { ...registered, settings: hookSettings(ARMS.atlas.settings ?? '{}', ctx.hookScript) },
      };
    case 'atlas-capped':
      return { atlas: true, prefixArgs: [], serverPatch: { budgetTokens: CAPPED_BUDGET_TOKENS }, spec: registered };
  }
}

/** The environment of a probe session: every ANTHROPIC*, CLAUDE* and ENABLE_TOOL_SEARCH variable removed. */
export function scrubbedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(ANTHROPIC|CLAUDE)/i.test(name) || name === 'ENABLE_TOOL_SEARCH') continue;
    out[name] = value;
  }
  return out;
}
