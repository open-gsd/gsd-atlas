/**
 * The init signature of a scored session (plan 03-39, D-03): what the `system` init event of a Claude Code
 * session must list for each arm of the registered run. `EXPECTED_INIT` holds the two signatures observed in
 * all 450 streams of the original scored run (225 sessions each); `diffSignature` names every difference
 * between an observed signature and the one registered for the arm.
 *
 * Replication tooling: it imports only Node built-ins and the registered `scripts/eval` modules, read-only, and
 * never anything from `src/` (D-02).
 */
import { ATLAS_TOOL_NAMES, PLUGIN_NAME, SKILL_NAME, ATLAS_SERVER_NAME } from '../eval/arms.ts';
import type { ArmId } from '../eval/arms.ts';

export interface McpServerSignature {
  readonly name: string;
  readonly status: string;
}

/** The fields of an init event that the registered environment fixes. Every list is compared without regard to order. */
export interface InitSignature {
  readonly tools: readonly string[];
  readonly mcpServers: readonly McpServerSignature[];
  readonly skills: readonly string[];
  /** Plugin names; the path and source of a plugin are not part of the signature. */
  readonly plugins: readonly string[];
  readonly agents: readonly string[];
  readonly apiKeySource: string;
  readonly claudeCodeVersion: string;
  readonly model: string;
  readonly permissionMode: string;
}

const BUILT_IN_PLUGINS: readonly string[] = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring'];

/** The 19 skills Claude Code 2.1.302 lists on its own; in the grep arm they are invisible to the model (no Skill tool). */
const CLAUDE_CODE_SKILLS: readonly string[] = [
  'deep-research',
  'design',
  'design-sync',
  'dataviz',
  'update-config',
  'verify',
  'debug',
  'code-review',
  'simplify',
  'batch',
  'fewer-permission-prompts',
  'doctor',
  'loop',
  'schedule',
  'claude-api',
  'workflow-authoring',
  'run',
  'run-skill-generator',
  'plugin-authoring',
];

const COMMON = {
  agents: ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
  apiKeySource: 'none',
  claudeCodeVersion: '2.1.302',
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
} as const;

export const EXPECTED_INIT: Readonly<Record<ArmId, InitSignature>> = {
  atlas: {
    // `StructuredOutput` is added by `--json-schema` in both arms; `Skill` is the atlas arm's addition (Revision 1).
    tools: ['Bash', 'Read', 'Skill', 'StructuredOutput', ...ATLAS_TOOL_NAMES],
    mcpServers: [{ name: ATLAS_SERVER_NAME, status: 'connected' }],
    skills: [`${PLUGIN_NAME}:${SKILL_NAME}`],
    plugins: [PLUGIN_NAME, ...BUILT_IN_PLUGINS],
    ...COMMON,
  },
  grep: {
    tools: ['Bash', 'Read', 'StructuredOutput'],
    mcpServers: [],
    skills: CLAUDE_CODE_SKILLS,
    plugins: BUILT_IN_PLUGINS,
    ...COMMON,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** True for the `system` event with subtype `init`. */
export function isInitEvent(event: unknown): event is Record<string, unknown> {
  return isRecord(event) && event['type'] === 'system' && event['subtype'] === 'init';
}

/** The signature of a parsed init event, or null when the value is not an init event. */
export function signatureOf(event: unknown): InitSignature | null {
  if (!isInitEvent(event)) return null;
  const servers: McpServerSignature[] = [];
  if (Array.isArray(event['mcp_servers'])) {
    for (const entry of event['mcp_servers']) {
      if (isRecord(entry) && typeof entry['name'] === 'string') servers.push({ name: entry['name'], status: text(entry['status']) });
    }
  }
  const plugins: string[] = [];
  if (Array.isArray(event['plugins'])) {
    for (const entry of event['plugins']) {
      if (isRecord(entry) && typeof entry['name'] === 'string') plugins.push(entry['name']);
    }
  }
  return {
    tools: strings(event['tools']),
    mcpServers: servers,
    skills: strings(event['skills']),
    plugins,
    agents: strings(event['agents']),
    apiKeySource: text(event['apiKeySource']),
    claudeCodeVersion: text(event['claude_code_version']),
    model: text(event['model']),
    permissionMode: text(event['permissionMode']),
  };
}

/** The signature of the first init event among parsed stream events, or null when there is none. */
export function signatureFromEvents(events: readonly unknown[]): InitSignature | null {
  const init = events.find(isInitEvent);
  return init === undefined ? null : signatureOf(init);
}

function listDiffs(field: string, noun: string, expected: readonly string[], actual: readonly string[]): string[] {
  const diffs: string[] = [];
  const have = new Set(actual);
  const want = new Set(expected);
  for (const entry of [...want].sort()) if (!have.has(entry)) diffs.push(`${field}: missing ${noun}: ${entry}`);
  for (const entry of [...have].sort()) if (!want.has(entry)) diffs.push(`${field}: extra ${noun}: ${entry}`);
  return diffs;
}

function scalarDiff(field: string, expected: string, actual: string): string[] {
  return actual === expected ? [] : [`${field}: expected ${expected}, got ${actual === '' ? '(absent)' : actual}`];
}

/**
 * One string per difference between an observed signature and the one registered for the arm; the string names
 * the field. An empty list means the session ran in the registered environment. The order of every list is
 * ignored. A missing init event is itself a difference.
 */
export function diffSignature(arm: ArmId, signature: InitSignature | null): string[] {
  if (signature === null) return ['init event absent'];
  const expected = EXPECTED_INIT[arm];
  const diffs: string[] = [
    ...listDiffs('tools', 'tool', expected.tools, signature.tools),
    ...listDiffs('skills', 'skill', expected.skills, signature.skills),
    ...listDiffs('plugins', 'plugin', expected.plugins, signature.plugins),
    ...listDiffs('agents', 'agent', expected.agents, signature.agents),
  ];
  const expectedServers = new Map(expected.mcpServers.map((server) => [server.name, server.status]));
  const actualServers = new Map(signature.mcpServers.map((server) => [server.name, server.status]));
  for (const [name, status] of [...expectedServers].sort()) {
    const seen = actualServers.get(name);
    if (seen === undefined) diffs.push(`mcpServers: missing server: ${name}`);
    else if (seen !== status) diffs.push(`mcpServers: server ${name} status ${seen}, expected ${status}`);
  }
  for (const name of [...actualServers.keys()].sort()) {
    if (!expectedServers.has(name)) diffs.push(`mcpServers: extra server: ${name}`);
  }
  diffs.push(
    ...scalarDiff('apiKeySource', expected.apiKeySource, signature.apiKeySource),
    ...scalarDiff('claude_code_version', expected.claudeCodeVersion, signature.claudeCodeVersion),
    ...scalarDiff('model', expected.model, signature.model),
    ...scalarDiff('permissionMode', expected.permissionMode, signature.permissionMode),
  );
  return diffs;
}
