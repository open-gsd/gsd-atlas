/**
 * The agent hosts `gsd-atlas init` can register the MCP server with: where each host keeps its user
 * scope configuration, how to tell the host is installed, and how to put the `gsd-atlas` entry into
 * the existing file text without disturbing anything else. Pure text in, text out: reading and writing
 * files is init-files.ts. Imports node: built-ins only (adapter rule).
 */
import path from 'node:path';

import { detectHomeFile } from './init-files.ts';
import type { Eol, UserFile } from './init-files.ts';

export type AgentId = 'claude' | 'cursor' | 'codex';

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

// Cursor and Codex file shapes follow the shapes gsd-graph's installer uses; they are not checked against
// current host documentation (research assumption A3). Cursor keeps its user scope servers in
// ~/.cursor/mcp.json; Codex keeps its in ~/.codex/config.toml.
const cursor: Target = {
  agent: 'cursor',
  file: (home) => path.join(home, '.cursor', 'mcp.json'),
  detect: (home) => detectBy(path.join(home, '.cursor', 'mcp.json'), [path.join(home, '.cursor')]),
  createsFile: true,
  render: (existing, launch) => renderJsonServers(existing, { command: launch.command, args: [...launch.args] }),
};

const CODEX_HEADER = '[mcp_servers.gsd-atlas]';
/** The same table spelled with a quoted key: it is the same table in TOML, so a second one would be a duplicate. */
const CODEX_QUOTED_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*["']gsd-atlas["']\s*\]/;

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

/** A TOML basic string: backslash, double quote and control characters escaped. */
function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (TOML_ESCAPES[char] !== undefined) {
      out += TOML_ESCAPES[char];
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/** The index just past the run of `quote` characters that starts at `from` (at most 5 count: 3 close, 2 are content). */
function quoteRunEnd(line: string, from: number, quote: string): number {
  let end = from;
  while (end < line.length && end - from < 5 && line[end] === quote) {
    end += 1;
  }
  return end;
}

/** The index just past the closing `quote` of a single-line string that opens at `from`; the line end when unterminated. */
function singleLineStringEnd(line: string, from: number, quote: string): number {
  for (let index = from + 1; index < line.length; index += 1) {
    if (quote === '"' && line[index] === '\\') {
      index += 1; // an escaped character, including an escaped quote
    } else if (line[index] === quote) {
      return index + 1;
    }
  }
  return line.length;
}

type TomlString = 'none' | 'basic' | 'literal';

/**
 * The zero-based indexes of the lines of `lines` that are real TOML table headers (`[a]` and `[[a]]`).
 * A small line scan, not a TOML parser: it carries across lines whether a multi-line basic string
 * (three double quotes) or a multi-line literal string (three single quotes) is open and how deeply
 * arrays and inline tables are nested, and inside a line it skips single-line strings and comments. A
 * line is a header only when, outside any string and at depth zero, its first non-blank character is
 * `[`. A header line is consumed whole: its brackets never count toward the depth. Exported for tests.
 */
export function tomlHeaderLines(lines: readonly string[]): ReadonlySet<number> {
  const headers = new Set<number>();
  let open: TomlString = 'none';
  let depth = 0;
  for (const [number, line] of lines.entries()) {
    if (open === 'none' && depth === 0 && line.trimStart().startsWith('[')) {
      headers.add(number);
      continue;
    }
    let index = 0;
    while (index < line.length) {
      if (open !== 'none') {
        const quote = open === 'basic' ? '"' : "'";
        const char = line[index];
        if (open === 'basic' && char === '\\') {
          index += 2;
        } else if (char === quote && line.startsWith(quote.repeat(3), index)) {
          index = quoteRunEnd(line, index, quote);
          open = 'none';
        } else {
          index += 1;
        }
        continue;
      }
      const char = line[index]!;
      if (char === '#') {
        break;
      }
      if (char === '"' || char === "'") {
        if (line.startsWith(char.repeat(3), index)) {
          open = char === '"' ? 'basic' : 'literal';
          index += 3;
        } else {
          index = singleLineStringEnd(line, index, char);
        }
      } else {
        if (char === '[' || char === '{') {
          depth += 1;
        } else if ((char === ']' || char === '}') && depth > 0) {
          depth -= 1;
        }
        index += 1;
      }
    }
  }
  return headers;
}

/**
 * Put the `[mcp_servers.gsd-atlas]` table into a Codex config by text edit (no TOML parser is a
 * dependency). A new table is appended after a blank line. An existing one is replaced from its header
 * to the next real table header (see `tomlHeaderLines`; blank lines before that header stay), so a
 * line that merely starts with `[` inside a multi-line array or string neither ends nor blocks the
 * replacement; every other byte is kept.
 */
function renderCodex(existing: UserFile | null, launch: McpLaunch): RenderResult {
  const eol: Eol = existing?.eol ?? '\n';
  const block = [CODEX_HEADER, `command = ${tomlString(launch.command)}`, `args = [${launch.args.map(tomlString).join(', ')}]`];
  if (existing === null) {
    return { kind: 'ok', text: `${block.join(eol)}${eol}`, changed: true };
  }
  const text = existing.text;
  if (text.includes('\0')) {
    return refused('the file contains a NUL byte');
  }
  const lines = text.split('\n'); // a CR stays attached to its line, so untouched lines keep their endings
  const headers = tomlHeaderLines(lines);
  for (const index of headers) {
    const line = lines[index]!;
    if (!line.includes(']')) {
      return refused(`line ${index + 1} starts a table header without a closing bracket`);
    }
    if (CODEX_QUOTED_HEADER.test(line)) {
      return refused(`line ${index + 1} writes the ${CODEX_HEADER} table with a quoted key; edit it by hand`);
    }
  }

  const start = lines.findIndex((line, index) => headers.has(index) && line.trim() === CODEX_HEADER);
  if (start === -1) {
    let base = text;
    if (base.length > 0) {
      if (!base.endsWith('\n')) {
        base += eol;
      }
      if (!/\n\r?\n$/.test(base)) {
        base += eol; // the blank line before the new table
      }
    }
    return { kind: 'ok', text: `${base}${block.join(eol)}${eol}`, changed: true };
  }

  let end = lines.findIndex((_line, index) => index > start && headers.has(index));
  if (end === -1) {
    end = lines.length;
  }
  let contentEnd = end;
  while (contentEnd > start + 1 && lines[contentEnd - 1]?.trim() === '') {
    contentEnd -= 1;
  }
  const current = lines.slice(start, contentEnd).map((line) => line.trimEnd());
  if (current.length === block.length && current.every((line, index) => line === block[index])) {
    return { kind: 'ok', text, changed: false };
  }
  const cr = eol === '\r\n' ? '\r' : '';
  const next = [...lines.slice(0, start), ...block.map((line) => `${line}${cr}`), ...lines.slice(contentEnd)];
  return { kind: 'ok', text: next.join('\n'), changed: true };
}

const codex: Target = {
  agent: 'codex',
  file: (home) => path.join(home, '.codex', 'config.toml'),
  detect: (home) => detectBy(path.join(home, '.codex', 'config.toml'), [path.join(home, '.codex')]),
  createsFile: true,
  render: renderCodex,
};

export const TARGETS: readonly Target[] = [claude, cursor, codex];

export const AGENT_IDS: readonly AgentId[] = TARGETS.map((target) => target.agent);
