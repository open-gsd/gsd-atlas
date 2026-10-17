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
  depth: { type: 'string' },
  task: { type: 'string' },
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

/** How a command takes its positional arguments. */
export type Positional = 'name' | 'task' | 'none';

export interface Command {
  /** What the user types; `lang list` and `lang test` have two words. */
  readonly name: string;
  /** `tool`: an MCP tool's twin. `index`: a Host request with no MCP tool. `lang` and `init` have their own handlers. */
  readonly kind: 'tool' | 'index' | 'lang' | 'init';
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
    name: 'build',
    kind: 'index',
    request: 'build',
    positional: 'none',
    flags: [...SELECTION],
    usage: 'gsd-atlas build [--repo <dir>] [--cwd <dir>]',
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

  if (command.kind === 'tool') return validateTool(command, input);
  return { ok: true, input };
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
  return { protocol: PROTOCOL_VERSION, kind: command.request ?? command.name, args: input };
}
