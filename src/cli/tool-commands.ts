/**
 * The command table of the CLI adapter (QRY-04): which command sends which request, which flags it accepts and how
 * flags and positionals become the input of that request.
 *
 * A tool command (find, refs, context, impact, health) validates its input against the same zod schema the MCP
 * server publishes and builds its Request with the same function (`buildRequest`), so the Host receives an
 * identical request from either adapter; parity is structural, not a convention. An index command (build,
 * maintain, status) has no MCP tool; its request is the Host's own kind.
 *
 * This module imports only the host-client seam (adapter rule) and node:path.
 */
import path from 'node:path';

import { PROTOCOL_VERSION, TOOLS, buildRequest } from '../host-client/index.ts';
import type { Request, ToolName } from '../host-client/index.ts';

/**
 * Every flag the CLI knows, once. A command lists the names it uses, so "does this command accept this flag" is a
 * lookup in data, not a branch. `--version` and `--help` are handled before any command and are not here.
 */
export const FLAGS = {
  repo: { type: 'string' },
  cwd: { type: 'string' },
  budget: { type: 'string' },
  more: { type: 'string' },
  fresh: { type: 'string', multiple: true },
  limit: { type: 'string' },
  kind: { type: 'string' },
  mode: { type: 'string' },
  path: { type: 'string' },
  at: { type: 'string' },
  depth: { type: 'string' },
  full: { type: 'boolean' },
  since: { type: 'string' },
  agent: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  'repo-root': { type: 'string' },
  'user-dir': { type: 'string' },
  'builtin-dir': { type: 'string' },
  'npm-root': { type: 'string', multiple: true },
} as const;

export type FlagName = keyof typeof FLAGS;

/** What the argument parser found: only the flags the user gave are present. */
export type FlagValues = Readonly<Partial<Record<FlagName, string | boolean | string[] | undefined>>>;

/** The module-root flags of the `lang` commands. */
export const ROOT_FLAGS: readonly FlagName[] = ['repo-root', 'user-dir', 'builtin-dir', 'npm-root'];

/** The flags of the code tools that choose the repository and shape the answer. */
const SELECTION: readonly FlagName[] = ['repo', 'cwd'];
const PAGING: readonly FlagName[] = ['budget', 'more', 'fresh', 'limit'];

/**
 * The tasks `maintain` runs, as the Host accepts them (`all` runs every other one, in this order). Kept here because an
 * adapter imports nothing but the host-client seam; scripts/cli-e2e.test.ts checks this list against the Host's.
 */
export const MAINTAIN_TASKS = ['reconcile', 'resolve', 'refresh', 'collect', 'compact', 'check', 'all'] as const;

/** The only tasks `--full` (a full vacuum) applies to. */
const FULL_TASKS: ReadonlySet<string> = new Set(['compact', 'all']);

/** The window of `status`: a count of 1 to 9999 and a unit of minutes, hours or days, as the Host reads it. */
const SINCE = /^[1-9][0-9]{0,3}[mhd]$/;

/** The window `status` shows when `--since` is not given. */
const DEFAULT_SINCE = '7d';

/** How a command takes its positional arguments. `tool name` is `history`'s pair: the code tool, then the symbol. */
export type Positional = 'name' | 'task' | 'tool name' | 'none';

/** The code tools `history` can answer as of a commit (the Host's `HISTORY_TOOLS`, kept here because an adapter imports only the host-client seam). */
export const HISTORY_TOOLS = ['find', 'refs', 'context', 'impact'] as const;

export interface Command {
  /** What the user types; `lang list` and `lang test` have two words. */
  readonly name: string;
  /** `tool`: an MCP tool's twin. `index`: a Host request with no MCP tool. `history`: a code tool as of a commit. `lang` and `init` have their own handlers. */
  readonly kind: 'tool' | 'index' | 'history' | 'lang' | 'init';
  /** The MCP tool whose schema and request builder this command shares. */
  readonly tool?: ToolName;
  /** The Host request kind an `index` command sends. */
  readonly request?: string;
  readonly positional: Positional;
  readonly flags: readonly FlagName[];
  /** The line this command has in the usage text. */
  readonly usage: string;
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'find',
    kind: 'tool',
    tool: 'code_find',
    positional: 'name',
    flags: [...SELECTION, ...PAGING, 'kind', 'mode'],
    usage: 'gsd-atlas find <name> [--kind <kind>] [--mode exact|prefix|fuzzy|auto] [selection and paging flags]',
  },
  {
    name: 'refs',
    kind: 'tool',
    tool: 'code_refs',
    positional: 'name',
    flags: [...SELECTION, ...PAGING, 'kind', 'path'],
    usage: 'gsd-atlas refs <name> [--kind <kind>] [--path <file>] [selection and paging flags]',
  },
  {
    name: 'context',
    kind: 'tool',
    tool: 'code_context',
    positional: 'name',
    flags: [...SELECTION, ...PAGING, 'path'],
    usage: 'gsd-atlas context <name> [--path <file>] [selection and paging flags]',
  },
  {
    name: 'impact',
    kind: 'tool',
    tool: 'code_impact',
    positional: 'name',
    flags: [...SELECTION, ...PAGING, 'path', 'depth'],
    usage: 'gsd-atlas impact <name> [--path <file>] [--depth <hops>] [selection and paging flags]',
  },
  {
    name: 'history',
    kind: 'history',
    request: 'history',
    positional: 'tool name',
    flags: [...SELECTION, 'budget', 'limit', 'at', 'path', 'kind', 'mode', 'depth'],
    usage:
      'gsd-atlas history <find|refs|context|impact> <name> --at <revision> [--path <file>] [--kind <kind>] [--mode exact|prefix|fuzzy|auto] [--depth <hops>] [--limit <n>] [--budget <tokens>] [--repo <dir>] [--cwd <dir>]   (the code as of a commit, from git alone; never writes to the index)',
  },
  {
    name: 'health',
    kind: 'tool',
    tool: 'atlas_status',
    positional: 'none',
    flags: [...SELECTION],
    usage: 'gsd-atlas health [--repo <dir>] [--cwd <dir>]   (index status, the atlas_status tool)',
  },
  {
    name: 'build',
    kind: 'index',
    request: 'build',
    positional: 'none',
    flags: [...SELECTION],
    usage: 'gsd-atlas build [--repo <dir>] [--cwd <dir>]   (index the repository; the only way an index is created)',
  },
  {
    name: 'maintain',
    kind: 'index',
    request: 'maintain',
    positional: 'task',
    flags: [...SELECTION, 'full'],
    usage: `gsd-atlas maintain [${MAINTAIN_TASKS.join('|')}] [--full] [--repo <dir>] [--cwd <dir>]   (exit 3 when another process holds the writer lease)`,
  },
  {
    name: 'status',
    kind: 'index',
    request: 'status',
    positional: 'none',
    flags: [...SELECTION, 'since'],
    usage: 'gsd-atlas status [--since <count>m|h|d] [--repo <dir>] [--cwd <dir>]   (local metrics panels; token figures are estimates)',
  },
  {
    name: 'init',
    kind: 'init',
    positional: 'none',
    flags: ['agent', 'dry-run'],
    usage: 'gsd-atlas init [--agent claude|cursor|codex] [--dry-run]',
  },
  {
    name: 'lang list',
    kind: 'lang',
    positional: 'none',
    flags: [...ROOT_FLAGS],
    usage: 'gsd-atlas lang list [root flags]',
  },
  {
    name: 'lang test',
    kind: 'lang',
    positional: 'none',
    flags: [...ROOT_FLAGS],
    usage: 'gsd-atlas lang test <module-folder>|<module-id> [root flags]',
  },
];

/** The command the leading positionals name, and the positionals that remain for it; undefined for an unknown one. */
export function resolveCommand(positionals: readonly string[]): { readonly command: Command; readonly rest: readonly string[] } | undefined {
  const [first, second] = positionals;
  if (first === undefined) return undefined;
  const words = first === 'lang' ? 2 : 1;
  const name = words === 2 ? `${first} ${second ?? ''}` : first;
  const command = COMMANDS.find((candidate) => candidate.name === name);
  return command === undefined ? undefined : { command, rest: positionals.slice(words) };
}

/** The first flag the user gave that this command does not use, or undefined. */
export function unusedFlag(command: Command, values: FlagValues): FlagName | undefined {
  const allowed: ReadonlySet<string> = new Set(command.flags);
  const given = (Object.keys(values) as FlagName[]).filter((flag) => values[flag] !== undefined);
  return given.find((flag) => !allowed.has(flag));
}

export type InputResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): InputResult => ({ ok: false, message });

/** A whole number from a flag value, or a message naming the flag. */
function whole(flag: string, text: string): number | string {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value)) return `--${flag} must be a whole number, got "${text}"`;
  return value;
}

function stringOf(value: string | boolean | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The input object of a command's tool or request, from its flags and positionals. Relative `--repo` and `--cwd`
 * are resolved against the process working directory here, before the Host sees them. Numbers are parsed and
 * checked to be whole; everything else is validated by the tool's own schema (tool commands) or checked below
 * (index commands). A failure is a usage error with a one-line reason.
 */
export function inputFromFlags(
  command: Command,
  values: FlagValues,
  positionals: readonly string[],
  io: { readonly cwd: string },
): InputResult {
  const input: Record<string, unknown> = {};

  if (command.positional === 'name') {
    if (positionals.length !== 1) return refuse(`${command.name} needs exactly one symbol name`);
    input['name'] = positionals[0];
  } else if (command.positional === 'task') {
    if (positionals.length > 1) return refuse(`${command.name} takes at most one task`);
    const task = positionals[0] ?? 'all';
    if (!(MAINTAIN_TASKS as readonly string[]).includes(task)) {
      return refuse(`unknown task "${task}" (expected ${MAINTAIN_TASKS.join(', ')})`);
    }
    if (values.full === true && !FULL_TASKS.has(task)) {
      return refuse('--full applies only to maintain compact and maintain all');
    }
    input['task'] = task;
    if (values.full === true) input['full'] = true;
  } else if (command.positional === 'tool name') {
    const [tool, name, ...extra] = positionals;
    if (tool === undefined || !(HISTORY_TOOLS as readonly string[]).includes(tool)) {
      return refuse(`${command.name} needs a tool (${HISTORY_TOOLS.join(', ')}) and a symbol name`);
    }
    if (name === undefined || extra.length > 0) return refuse(`${command.name} ${tool} needs exactly one symbol name`);
    input['tool'] = tool;
    input['name'] = name;
    const at = stringOf(values.at);
    if (at === undefined) return refuse(`${command.name} needs --at <revision>`);
    if (at === '' || at.startsWith('-')) return refuse('--at must be a revision name or commit id, not an option');
    input['at'] = at;
  } else if (command.positional === 'none' && positionals.length > 0) {
    return refuse(`${command.name} takes no arguments`);
  }

  const repo = stringOf(values.repo);
  if (repo !== undefined) input['repo'] = path.resolve(io.cwd, repo);
  const cwd = stringOf(values.cwd);
  if (cwd !== undefined) input['cwd'] = path.resolve(io.cwd, cwd);

  for (const [flag, field] of [
    ['budget', 'budget_tokens'],
    ['limit', 'limit'],
    ['depth', 'depth'],
  ] as const) {
    const text = stringOf(values[flag]);
    if (text === undefined) continue;
    const value = whole(flag, text);
    if (typeof value === 'string') return refuse(value);
    input[field] = value;
  }

  for (const flag of ['more', 'kind', 'mode', 'path'] as const) {
    const text = stringOf(values[flag]);
    if (text !== undefined) input[flag] = text;
  }
  if (Array.isArray(values.fresh)) input['fresh'] = [...values.fresh];

  if (command.request === 'status') {
    const since = stringOf(values.since) ?? DEFAULT_SINCE;
    if (!SINCE.test(since)) return refuse(`--since must be a count and a unit, such as 30m, 12h or 7d, got "${since}"`);
    input['since'] = since;
  }

  if (command.kind === 'tool') return validateTool(command, input);
  if (command.kind === 'history') return validateHistory(command, input);
  return { ok: true, input };
}

/**
 * Check a history command's tool arguments against the schema the MCP server publishes for that tool. `at` and
 * `path` are history's own (the commit, and the one file to read), so the tool's schema never sees them.
 */
function validateHistory(command: Command, input: Record<string, unknown>): InputResult {
  const definition = TOOLS.find((tool) => tool.name === `code_${String(input['tool'])}`);
  if (definition === undefined) return refuse(`${command.name} has no tool definition for ${String(input['tool'])}`);
  const { tool: _tool, at: _at, path: _path, ...toolInput } = input;
  const checked = definition.inputSchema.safeParse(toolInput);
  if (checked.success) return { ok: true, input };
  const issues = checked.error.issues.map((issue) => {
    const where = issue.path.length === 0 ? 'arguments' : issue.path.map(String).join('.');
    return `${where}: ${issue.message}`;
  });
  return refuse(`invalid arguments: ${issues.join('; ')}`);
}

/** Check a tool command's input against the schema the MCP server publishes for the same tool. */
function validateTool(command: Command, input: Record<string, unknown>): InputResult {
  const definition = TOOLS.find((tool) => tool.name === command.tool);
  if (definition === undefined) return refuse(`${command.name} has no tool definition`);
  // `--cwd` only chooses the directory inside the repository; the tools whose schema is `repo` alone do not list it.
  const { cwd: _cwd, ...withoutCwd } = input;
  const checked = definition.inputSchema.safeParse(command.tool === 'atlas_status' ? withoutCwd : input);
  if (checked.success) return { ok: true, input };
  const issues = checked.error.issues.map((issue) => {
    const where = issue.path.length === 0 ? 'arguments' : issue.path.map(String).join('.');
    return `${where}: ${issue.message}`;
  });
  return refuse(`invalid arguments: ${issues.join('; ')}`);
}

/** The Request a command sends for `input`. A tool command uses the builder the MCP adapter uses. */
export function requestFor(command: Command, input: Record<string, unknown>): Request {
  if (command.kind === 'tool' && command.tool !== undefined) return buildRequest(command.tool, input);
  if (command.kind === 'history') {
    // As for a tool request, the budget rides at the request level and everything else stays in `args`.
    const { budget_tokens: budget, ...args } = input;
    return { protocol: PROTOCOL_VERSION, kind: 'history', args, ...(typeof budget === 'number' ? { budget_tokens: budget } : {}) };
  }
  return { protocol: PROTOCOL_VERSION, kind: command.request ?? command.name, args: input };
}
