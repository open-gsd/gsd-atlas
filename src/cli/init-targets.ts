/**
 * The agent hosts `gsd-atlas init` can register the MCP server with: where each host keeps its user
 * scope configuration, how to tell the host is installed, and how to put the `gsd-atlas` entry into
 * the existing file text without disturbing anything else. Pure text in, text out: reading and writing
 * files is init-files.ts. Imports node: built-ins only (adapter rule).
 */
import path from 'node:path';

import { detectHomeFile } from './init-files.ts';
import type { Eol, UserFile } from './init-files.ts';

export type AgentId = 'claude';

/** What the host must run to start the stdio server: absolute paths, supplied by the bin. */
export interface McpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export type RenderResult =
  | { readonly kind: 'ok'; readonly text: string; readonly changed: boolean }
  | { readonly kind: 'refused'; readonly reason: string };

/** `file`: the config file exists. `folder`: only the host's folder exists. `unusable`: the file path is not a file. */
export type Detection = 'file' | 'folder' | 'none' | 'unusable';

export interface Target {
  readonly agent: AgentId;
  /** The user scope config file under the injected home. */
  file(home: string): string;
  detect(home: string): Promise<Detection>;
  /** False when the host creates its own file and init must not (it prints a manual command instead). */
  readonly createsFile: boolean;
  /** The new file text for `existing` (null when the file is absent). */
  render(existing: UserFile | null, launch: McpLaunch): RenderResult;
  /** The command a user can run to register by hand; only for hosts whose file init does not create. */
  manualCommand?(launch: McpLaunch, platform: NodeJS.Platform): string;
}

/** The key of our entry in every host's server table. */
export const SERVER_NAME = 'gsd-atlas';

const refused = (reason: string): RenderResult => ({ kind: 'refused', reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return a === b;
}

/** The first indented line of a pretty-printed file shows its indent; two spaces when there is none. */
function detectIndent(text: string): string {
  const match = /^([ \t]+)\S/m.exec(text);
  return match?.[1] === undefined ? '  ' : match[1];
}

/**
 * Set `mcpServers["gsd-atlas"]` in a JSON config. The file is parsed first; anything that is not a
 * JSON object, or whose `mcpServers` is not an object, is refused. The entry already present is
 * compared with the wanted one so an identical entry leaves the file untouched.
 */
function renderJsonServers(existing: UserFile | null, entry: Record<string, unknown>): RenderResult {
  let root: Record<string, unknown> = {};
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.text);
    } catch (error) {
      return refused(`the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!isPlainObject(parsed)) {
      return refused('the top-level JSON value is not an object');
    }
    root = parsed;
  }
  const servers = root['mcpServers'];
  if (servers !== undefined && !isPlainObject(servers)) {
    return refused('"mcpServers" exists but is not a JSON object');
  }
  if (existing !== null && servers !== undefined && Object.hasOwn(servers, SERVER_NAME) && jsonEqual(servers[SERVER_NAME], entry)) {
    return { kind: 'ok', text: existing.text, changed: false };
  }
  const table = servers ?? {};
  table[SERVER_NAME] = entry;
  root['mcpServers'] = table;

  const eol: Eol = existing?.eol ?? '\n';
  const trailingNewline = existing === null || /\n$/.test(existing.text);
  let text = JSON.stringify(root, null, existing === null ? 2 : detectIndent(existing.text));
  if (trailingNewline) {
    text += '\n';
  }
  return { kind: 'ok', text: eol === '\n' ? text : text.replace(/\n/g, eol), changed: true };
}

async function detectBy(file: string, folders: readonly string[]): Promise<Detection> {
  const kind = await detectHomeFile(file);
  if (kind === 'file') {
    return 'file';
  }
  if (kind !== 'missing') {
    return 'unusable';
  }
  for (const folder of folders) {
    if ((await detectHomeFile(folder)) === 'directory') {
      return 'folder';
    }
  }
  return 'none';
}

/** A token as a shell word for the manual command: bare when safe, quoted otherwise. */
function shellWord(token: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(token)) {
    return token;
  }
  return platform === 'win32' ? `"${token}"` : `"${token.replace(/(["\\$`])/g, '\\$1')}"`;
}

const claude: Target = {
  agent: 'claude',
  file: (home) => path.join(home, '.claude.json'),
  detect: (home) => detectBy(path.join(home, '.claude.json'), [path.join(home, '.claude')]),
  // Claude Code creates and rewrites ~/.claude.json itself; init only edits a file that is already there.
  createsFile: false,
  render: (existing, launch) => renderJsonServers(existing, { type: 'stdio', command: launch.command, args: [...launch.args] }),
  manualCommand: (launch, platform) =>
    ['claude', 'mcp', 'add', '--scope', 'user', SERVER_NAME, '--', launch.command, ...launch.args]
      .map((token) => shellWord(token, platform))
      .join(' '),
};

export const TARGETS: readonly Target[] = [claude];

export const AGENT_IDS: readonly AgentId[] = TARGETS.map((target) => target.agent);
