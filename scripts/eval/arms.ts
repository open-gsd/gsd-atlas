/**
 * The two arms of the eval and everything that differs between them (D-03, D-05).
 *
 * This is the one small file the freeze hashes for the run configuration: the tools each arm may use,
 * the read-only shell patterns, the atlas tool names, the MCP configuration and the plugin directory
 * that carries the skill. Both arms get the same prompt text, the same answer schema, the same model
 * and the same bounds; the atlas arm adds the atlas MCP server, the `gsd-atlas` skill and the `Skill`
 * built-in tool that makes the skill visible to the model (Revision 1, plan 03-38: under `--tools
 * Bash,Read` the init event lists the skill, yet the model sees no skill list and has no Skill tool),
 * and nothing else. The grep arm is what it always was.
 *
 * Eval tooling: it must never import from src/ (D-02). The atlas binary is only ever run as a
 * program.
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertToolSet } from './claude-session.ts';
import type { ExpectedToolSet, InitEvent } from './claude-session.ts';
import { hashFile } from './prereg.ts';

export type ArmId = 'atlas' | 'grep';

export const ARM_IDS: readonly ArmId[] = ['atlas', 'grep'];

/** Repeats of a question in an arm (03-CONSTANTS.md `eval.runsPerCell`, D-03). A scored run takes it from the registration. */
export const DEFAULT_RUNS = 3;

/** Sessions in flight at once (03-CONSTANTS.md `eval.concurrency`). A scored run takes it from the registration. */
export const DEFAULT_CONCURRENCY = 2;

/** The seed of the run order for a pilot (03-CONSTANTS.md `eval.bootstrapSeed`); a scored run uses the registered seed. */
export const DEFAULT_SEED = 20261017;

/** Retries of a session that failed before reaching the model (registered retry rule, plan 03-10 D-03). */
export const MAX_INFRASTRUCTURE_RETRIES = 2;

/**
 * The wait before such a retry, in milliseconds. Planner-added in plan 03-10 and not in
 * 03-CONSTANTS.md: it needs the approval of the freeze review (plan 03-16), which hashes this file.
 */
export const DEFAULT_RETRY_DELAY_MS = 60_000;

/** The key of the atlas server in the MCP configuration; tool names are `mcp__<server>__<tool>`. */
export const ATLAS_SERVER_NAME = 'gsd-atlas';

/** The plugin that carries the skill (`--plugin-dir`): the skill is then listed as `<plugin>:<skill>`. */
export const PLUGIN_NAME = 'gsd-atlas-eval';

/** The skill's directory name under `skills/` and its name in the plugin. */
export const SKILL_NAME = 'gsd-atlas';

/** The seven atlas tools. The pilot runs before the seventh exists, so a session may list a subset. */
export const ATLAS_TOOL_NAMES: readonly string[] = [
  'mcp__gsd-atlas__code_find',
  'mcp__gsd-atlas__code_refs',
  'mcp__gsd-atlas__code_context',
  'mcp__gsd-atlas__code_impact',
  'mcp__gsd-atlas__code_explain',
  'mcp__gsd-atlas__atlas_status',
  'mcp__gsd-atlas__lang_list',
];

/**
 * The tool Claude Code adds to the session when `--json-schema` is given: the model delivers its final
 * answer through it. Both arms pass the schema, so both lists carry it; it is not an arm tool.
 */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** The built-in tools of the grep arm: a shell restricted to the patterns below, and the file reader. */
export const BUILTIN_TOOLS: readonly string[] = ['Bash', 'Read'];

/** The built-in `Skill` tool: the model sees the listed skill descriptions and can load a skill body through it. */
export const SKILL_TOOL = 'Skill';

/** The built-in tools of the atlas arm: those of the grep arm and the Skill tool (Revision 1). */
export const ATLAS_BUILTIN_TOOLS: readonly string[] = [...BUILTIN_TOOLS, SKILL_TOOL];

/**
 * The shell commands a session may run: search and read-only inspection, nothing that installs,
 * fetches or writes by design. A session works in a throwaway copy of the checkout (T-03-101).
 */
export const ALLOWED_SHELL: readonly string[] = [
  'Bash(rg:*)',
  'Bash(git grep:*)',
  'Bash(git ls-files:*)',
  'Bash(grep:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(ls:*)',
  'Bash(find:*)',
  'Bash(sort:*)',
  'Bash(uniq:*)',
];

export interface ArmDef {
  readonly id: ArmId;
  readonly builtinTools: readonly string[];
  readonly allowedShell: readonly string[];
  /** Empty for the grep arm. */
  readonly atlasToolNames: readonly string[];
}

export const ARMS: Readonly<Record<ArmId, ArmDef>> = {
  grep: { id: 'grep', builtinTools: BUILTIN_TOOLS, allowedShell: ALLOWED_SHELL, atlasToolNames: [] },
  atlas: { id: 'atlas', builtinTools: ATLAS_BUILTIN_TOOLS, allowedShell: ALLOWED_SHELL, atlasToolNames: ATLAS_TOOL_NAMES },
};

/**
 * The single allow rule for the Skill tool: the exact registered skill, `Skill(<plugin>:<skill>)`. No
 * other skill (bundled or otherwise) can be loaded through the tool in the atlas arm.
 */
export const SKILL_ALLOW_RULE = `${SKILL_TOOL}(${PLUGIN_NAME}:${SKILL_NAME})`;

/**
 * The `--allowedTools` list of an arm: the shell patterns, `Read`, and for the atlas arm the one Skill
 * rule and the atlas tools.
 */
export function allowedToolsFor(arm: ArmId): string[] {
  const def = ARMS[arm];
  const skillRules = def.builtinTools.includes(SKILL_TOOL) ? [SKILL_ALLOW_RULE] : [];
  return [...def.allowedShell, 'Read', ...skillRules, ...def.atlasToolNames];
}

/** The arm's `--mcp-config` content: no server for the grep arm, the atlas MCP server for the atlas arm. */
export interface McpConfig {
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }>;
}

export interface McpConfigOptions {
  /** The built CLI, `dist/bin/gsd-atlas.js`; the MCP shim is its sibling `gsd-atlas-mcp.js`. */
  atlasBin: string;
  storeDir: string;
  userDir: string;
  /** Where to write the configuration. */
  configPath: string;
}

/** The MCP shim next to the built CLI. */
export function mcpBinFor(atlasBin: string): string {
  return path.join(path.dirname(path.resolve(atlasBin)), 'gsd-atlas-mcp.js');
}

/** Builds the arm's MCP configuration and writes it to `configPath`. */
export function buildMcpConfig(arm: ArmId, options: McpConfigOptions): McpConfig {
  const config: McpConfig = { mcpServers: {} };
  if (arm === 'atlas') {
    config.mcpServers[ATLAS_SERVER_NAME] = {
      type: 'stdio',
      command: process.execPath,
      args: [mcpBinFor(options.atlasBin)],
      env: { GSD_ATLAS_STORE_DIR: options.storeDir, GSD_ATLAS_USER_DIR: options.userDir },
    };
  }
  fs.mkdirSync(path.dirname(options.configPath), { recursive: true });
  fs.writeFileSync(options.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/**
 * Creates the plugin directory for the atlas arm under `scratch`: `.claude-plugin/plugin.json` named
 * `gsd-atlas-eval` and `skills/gsd-atlas/SKILL.md`, a byte copy of `skillPath`. Returns the directory
 * to pass to `--plugin-dir`.
 */
export function buildPluginDir(scratch: string, skillPath: string, expectedSha256?: string): string {
  // A scored run copies only the skill that was registered at Stage B; nothing is written otherwise.
  if (expectedSha256 !== undefined && hashFile(skillPath) !== expectedSha256) {
    throw new Error(`the skill file ${skillPath} does not match the registered Stage B hash`);
  }
  const dir = path.join(scratch, 'plugin');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', SKILL_NAME), { recursive: true });
  const manifest = { name: PLUGIN_NAME, version: '0.0.0', description: 'The registered gsd-atlas skill for the eval, and nothing else.' };
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(skillPath, path.join(dir, 'skills', SKILL_NAME, 'SKILL.md'));
  return dir;
}

/**
 * What an arm's init event must contain, for `assertToolSet`: the built-in tools exactly `Bash` and
 * `Read` (plus `Skill` for the atlas arm); the server `gsd-atlas` for the atlas arm and no server for
 * the grep arm. The atlas MCP tools are checked by `checkInit`, because a session may list a subset of
 * the seven.
 */
export function expectedToolSet(arm: ArmId): ExpectedToolSet {
  return {
    tools: [...ARMS[arm].builtinTools],
    mcpServers: arm === 'atlas' ? [ATLAS_SERVER_NAME] : [],
  };
}

const isAtlasSkill = (skill: string): boolean => skill === SKILL_NAME || skill === `${PLUGIN_NAME}:${SKILL_NAME}`;

/**
 * Compares an init event with the arm's registered environment (Pitfall 14). Returns one string per
 * difference; an empty array means the session ran where it was meant to.
 *
 * - Built-in tools must equal `Bash` and `Read` exactly in the grep arm and `Bash`, `Read` and `Skill`
 *   exactly in the atlas arm.
 * - Atlas arm: the server `gsd-atlas` is present, the MCP tools are a non-empty subset of the seven
 *   atlas tools, and the skill is listed. No other server, no other MCP tool.
 * - Grep arm: no MCP server, no MCP tool, no Skill tool (an extra tool) and no atlas skill.
 */
export function checkInit(arm: ArmId, init: InitEvent | null): string[] {
  if (init === null) return ['init event absent'];
  const expected = expectedToolSet(arm);
  const allowedMcp = new Set(ARMS[arm].atlasToolNames);
  const mcpTools = init.tools.filter((tool) => tool.startsWith('mcp__'));
  const allowedPresent = mcpTools.filter((tool) => allowedMcp.has(tool));
  // `--json-schema` makes Claude Code add its own `StructuredOutput` tool, in both arms (pilot finding, plan 03-14).
  const structured = init.tools.includes(STRUCTURED_OUTPUT_TOOL) ? [STRUCTURED_OUTPUT_TOOL] : [];
  const diffs = assertToolSet(init, { tools: [...expected.tools, ...structured, ...allowedPresent], mcpServers: expected.mcpServers });
  if (arm === 'atlas') {
    if (allowedPresent.length === 0) diffs.push('no atlas tool in the init event');
    if (!init.skills.some(isAtlasSkill)) diffs.push(`skill absent: ${PLUGIN_NAME}:${SKILL_NAME}`);
  } else if (init.skills.some(isAtlasSkill)) {
    diffs.push(`unexpected skill: ${SKILL_NAME}`);
  }
  return diffs;
}
