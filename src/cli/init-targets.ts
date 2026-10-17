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

// Cursor and Codex file shapes were checked on 2026-10-17 against the primary documentation recorded in
// .planning/research/MCP-HOST-CONFIGS.md (the Cursor MCP page, the Codex config reference and
// mcp_types.rs); the shapes began as the ones gsd-graph's installer uses. Cursor keeps its user scope
// servers in ~/.cursor/mcp.json; Codex keeps its in ~/.codex/config.toml. Still unconfirmed there: the
// Windows paths of both files (path.join(home, ...) gives the conventional location), whether Cursor
// tolerates unknown keys, and whether either host needs a restart (init therefore never says so).
// The Cursor docs list `type` as "stdio" in the field table while their own example omits it; writing
// it satisfies both readings. The Codex entry has no `type` key: its transport is inferred from `command`.
const cursor: Target = {
  agent: 'cursor',
  file: (home) => path.join(home, '.cursor', 'mcp.json'),
  detect: (home) => detectBy(path.join(home, '.cursor', 'mcp.json'), [path.join(home, '.cursor')]),
  createsFile: true,
  render: (existing, launch) => renderJsonServers(existing, { type: 'stdio', command: launch.command, args: [...launch.args] }),
};

const CODEX_HEADER = '[mcp_servers.gsd-atlas]';
/** The key path of our table. Any spelling of it (spaces, quotes, a trailing comment) is the same table in TOML. */
const CODEX_TABLE: readonly string[] = ['mcp_servers', SERVER_NAME];

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
  const state: ScanState = { open: 'none', depth: 0 };
  for (const [number, line] of lines.entries()) {
    if (scanIsClean(state) && line.trimStart().startsWith('[')) {
      headers.add(number);
      continue;
    }
    scanLine(line, state);
  }
  return headers;
}

/** What the line scan carries from one line to the next: the open multi-line string, and the array / inline-table depth. */
interface ScanState {
  open: TomlString;
  depth: number;
}

/** True between statements: no multi-line string and no array or inline table is open. */
const scanIsClean = (state: ScanState): boolean => state.open === 'none' && state.depth === 0;

/** Advance `state` over one line: strings and comments are skipped, brackets and braces outside them move the depth. */
function scanLine(line: string, state: ScanState): void {
  let index = 0;
  while (index < line.length) {
    if (state.open !== 'none') {
      const quote = state.open === 'basic' ? '"' : "'";
      const char = line[index];
      if (state.open === 'basic' && char === '\\') {
        index += 2;
      } else if (char === quote && line.startsWith(quote.repeat(3), index)) {
        index = quoteRunEnd(line, index, quote);
        state.open = 'none';
      } else {
        index += 1;
      }
      continue;
    }
    const char = line[index]!;
    if (char === '#') {
      return;
    }
    if (char === '"' || char === "'") {
      if (line.startsWith(char.repeat(3), index)) {
        state.open = char === '"' ? 'basic' : 'literal';
        index += 3;
      } else {
        index = singleLineStringEnd(line, index, char);
      }
    } else {
      if (char === '[' || char === '{') {
        state.depth += 1;
      } else if ((char === ']' || char === '}') && state.depth > 0) {
        state.depth -= 1;
      }
      index += 1;
    }
  }
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;

/** The text of a basic string's body with its escapes decoded; null for an escape TOML does not define. */
function unescapeBasic(body: string): string | null {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[index + 1];
    const simple: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (next !== undefined && simple[next] !== undefined) {
      out += simple[next];
      index += 1;
    } else if (next === 'u' || next === 'U') {
      const width = next === 'u' ? 4 : 8;
      const hex = body.slice(index + 2, index + 2 + width);
      const code = hex.length === width && /^[0-9A-Fa-f]+$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
      if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return null;
      }
      out += String.fromCodePoint(code);
      index += 1 + width;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Read a dotted key (`a`, `a.b`, `"a b".'c'`, spaces allowed around the dots) that starts at `from`. Returns its
 * decoded parts and the index just past it (and past any spaces after it), or null when no valid key starts there.
 */
function readKey(text: string, from: number): { readonly parts: string[]; readonly next: number } | null {
  const parts: string[] = [];
  let index = from;
  for (;;) {
    while (text[index] === ' ' || text[index] === '\t') {
      index += 1;
    }
    const char = text[index];
    if (char === '"' || char === "'") {
      const end = singleLineStringEnd(text, index, char);
      if (text[end - 1] !== char || end - index < 2) {
        return null; // unterminated
      }
      const body = text.slice(index + 1, end - 1);
      const value = char === '"' ? unescapeBasic(body) : body;
      if (value === null) {
        return null;
      }
      parts.push(value);
      index = end;
    } else {
      const start = index;
      while (index < text.length && BARE_KEY_CHAR.test(text[index]!)) {
        index += 1;
      }
      if (index === start) {
        return null;
      }
      parts.push(text.slice(start, index));
    }
    while (text[index] === ' ' || text[index] === '\t') {
      index += 1;
    }
    if (text[index] !== '.') {
      return { parts, next: index };
    }
    index += 1;
  }
}

/** The key path of a table header line and whether it is `[[array of tables]]`; null when the line is not a closed header with a valid key. */
export function tomlHeaderKey(line: string): { readonly parts: readonly string[]; readonly array: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }
  const array = trimmed.startsWith('[[');
  const key = readKey(trimmed, array ? 2 : 1);
  if (key === null) {
    return null;
  }
  const close = array ? ']]' : ']';
  if (!trimmed.startsWith(close, key.next)) {
    return null;
  }
  const rest = trimmed.slice(key.next + close.length).trimStart();
  if (rest !== '' && !rest.startsWith('#')) {
    return null;
  }
  return { parts: key.parts, array };
}

/** One `key = value` statement of a table body: its first and last line (zero-based, inclusive) and its key path (null when unreadable). */
export interface TomlStatement {
  readonly start: number;
  readonly end: number;
  readonly key: readonly string[] | null;
}

/**
 * The statements in `lines[from..to)`, which must lie inside one table body (no header among them). A statement
 * starts on a line that is neither blank nor a comment while nothing is open, and runs to the line that closes its
 * last array, inline table or multi-line string. Blank lines, comment lines and the lines between statements belong
 * to none.
 */
export function tomlStatements(lines: readonly string[], from: number, to: number): TomlStatement[] {
  const found: TomlStatement[] = [];
  const state: ScanState = { open: 'none', depth: 0 };
  let index = from;
  while (index < to) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      index += 1;
      continue;
    }
    const start = index;
    const read = readKey(line, 0);
    const key = read !== null && line[read.next] === '=' ? read.parts : null;
    scanLine(line, state);
    index += 1;
    while (!scanIsClean(state) && index < to) {
      scanLine(lines[index]!, state);
      index += 1;
    }
    found.push({ start, end: index - 1, key });
  }
  return found;
}

/** Where our table can no longer be edited safely by text, or null when it can. A reason names the line and says to edit by hand. */
function codexUnsafeForm(lines: readonly string[], headers: ReadonlySet<number>): string | null {
  const sorted = [...headers].sort((a, b) => a - b);
  const bodyEnd = (after: number): number => sorted.find((index) => index > after) ?? lines.length;
  const byHand = (line: number, what: string): string => `line ${String(line + 1)} ${what}; edit it by hand`;

  // The root table: `mcp_servers = { ... }` or `mcp_servers.gsd-atlas.command = ...` defines our table by dotted keys.
  for (const statement of tomlStatements(lines, 0, sorted[0] ?? lines.length)) {
    const [first, second] = statement.key ?? [];
    if (first === CODEX_TABLE[0] && (statement.key?.length === 1 || second === SERVER_NAME)) {
      return byHand(statement.start, `defines mcp_servers or ${SERVER_NAME} with a key instead of the ${CODEX_HEADER} table`);
    }
  }
  // The [mcp_servers] table: `gsd-atlas = { ... }` or `gsd-atlas.command = ...` inside it.
  for (const index of sorted) {
    const key = tomlHeaderKey(lines[index]!);
    if (key === null || key.array || key.parts.length !== 1 || key.parts[0] !== CODEX_TABLE[0]) {
      continue;
    }
    for (const statement of tomlStatements(lines, index + 1, bodyEnd(index))) {
      if (statement.key?.[0] === SERVER_NAME) {
        return byHand(statement.start, `defines ${SERVER_NAME} as a key of [mcp_servers] instead of the ${CODEX_HEADER} table`);
      }
    }
  }
  return null;
}

/**
 * Put the `[mcp_servers.gsd-atlas]` table into a Codex config by text edit (no TOML parser is a dependency).
 *
 * A table is ours when its header's key path is `mcp_servers.gsd-atlas`, however it is spelled (spaces, quoted keys,
 * a trailing comment); its header line is never rewritten. No table: ours is appended after a blank line. A table:
 * PRESERVE. Only its `command` and `args` statements are managed. Each is replaced in place (a multi-line array
 * as a whole), a missing one is inserted directly after the header, or after the other managed key, and every
 * other line stays byte for byte: user keys such as `startup_timeout_sec` or `env`, comments, blank lines, and
 * sub-tables such as `[mcp_servers.gsd-atlas.env]`. Refusing a table the user has tuned would block `init` for good
 * and gain nothing a rewrite could keep; preserving cannot lose data. Refused, never edited: a `url` key (Codex
 * rejects a server with both a command and a url), a managed key written twice or as a dotted key, and a table that
 * is defined twice, by a `[[array of tables]]` header, by an inline table or by dotted keys (a second table would
 * duplicate it, and a text edit cannot tell which one wins). The scan is line based (see `tomlHeaderLines`), so a line
 * that only starts with `[` inside a multi-line array or string never ends or blocks the table. Inserted lines carry
 * the file's line ending.
 */
function renderCodex(existing: UserFile | null, launch: McpLaunch): RenderResult {
  const eol: Eol = existing?.eol ?? '\n';
  const managedCommand = `command = ${tomlString(launch.command)}`;
  const managedArgs = `args = [${launch.args.map(tomlString).join(', ')}]`;
  if (existing === null) {
    return { kind: 'ok', text: `${[CODEX_HEADER, managedCommand, managedArgs].join(eol)}${eol}`, changed: true };
  }
  const text = existing.text;
  if (text.includes('\0')) {
    return refused('the file contains a NUL byte');
  }
  const lines = text.split('\n'); // a CR stays attached to its line, so untouched lines keep their endings
  const headers = tomlHeaderLines(lines);
  const ours: number[] = [];
  for (const index of [...headers].sort((a, b) => a - b)) {
    const line = lines[index]!;
    if (!line.includes(']')) {
      return refused(`line ${String(index + 1)} starts a table header without a closing bracket`);
    }
    const key = tomlHeaderKey(line);
    if (key !== null && key.parts.length === CODEX_TABLE.length && key.parts.every((part, at) => part === CODEX_TABLE[at])) {
      if (key.array) {
        return refused(`line ${String(index + 1)} makes ${SERVER_NAME} an array of tables; edit it by hand`);
      }
      ours.push(index);
    }
  }
  if (ours.length > 1) {
    return refused(`line ${String((ours[1] ?? 0) + 1)} defines the ${CODEX_HEADER} table a second time (first at line ${String((ours[0] ?? 0) + 1)}); edit it by hand`);
  }
  const unsafe = codexUnsafeForm(lines, headers);
  if (unsafe !== null) {
    return refused(unsafe);
  }

  const header = ours[0];
  if (header === undefined) {
    let base = text;
    if (base.length > 0) {
      if (!base.endsWith('\n')) {
        base += eol;
      }
      if (!/\n\r?\n$/.test(base)) {
        base += eol; // the blank line before the new table
      }
    }
    return { kind: 'ok', text: `${base}${[CODEX_HEADER, managedCommand, managedArgs].join(eol)}${eol}`, changed: true };
  }

  // Edit as if the file ended with a newline, so an insertion after the last line is a line like any other; the
  // added ending is taken off again at the end.
  const cr = eol === '\r\n' ? '\r' : '';
  const addedFinalEol = !text.endsWith('\n');
  const work = [...lines];
  if (addedFinalEol) {
    if (cr !== '' && !work[work.length - 1]!.endsWith('\r')) {
      work[work.length - 1] += '\r';
    }
    work.push('');
  }
  const end = [...headers].sort((a, b) => a - b).find((index) => index > header) ?? work.length;

  let command: TomlStatement | undefined;
  let args: TomlStatement | undefined;
  for (const statement of tomlStatements(work, header + 1, end)) {
    const [first] = statement.key ?? [];
    const named = `line ${String(statement.start + 1)}`;
    if (first === 'url') {
      return refused(`${named} sets url in the ${CODEX_HEADER} table; Codex rejects a server with both a command and a url, so edit it by hand`);
    }
    if (first !== 'command' && first !== 'args') {
      continue;
    }
    if ((statement.key?.length ?? 0) > 1) {
      return refused(`${named} writes ${first} as a dotted key, which cannot be edited safely; edit it by hand`);
    }
    if ((first === 'command' ? command : args) !== undefined) {
      return refused(`${named} writes ${first} a second time in the ${CODEX_HEADER} table; edit it by hand`);
    }
    if (first === 'command') {
      command = statement;
    } else {
      args = statement;
    }
  }

  // One splice per managed statement, applied from the bottom up so the indexes above stay true.
  const splices: Array<{ at: number; remove: number; add: string[] }> = [];
  const replaceWith = (statement: TomlStatement, line: string): void => {
    const same = statement.start === statement.end && work[statement.start]!.replace(/\r$/, '').trimEnd() === line;
    if (!same) {
      splices.push({ at: statement.start, remove: statement.end - statement.start + 1, add: [`${line}${cr}`] });
    }
  };
  if (command !== undefined) {
    replaceWith(command, managedCommand);
  }
  if (args !== undefined) {
    replaceWith(args, managedArgs);
  }
  if (command === undefined && args === undefined) {
    splices.push({ at: header + 1, remove: 0, add: [`${managedCommand}${cr}`, `${managedArgs}${cr}`] });
  } else if (command === undefined) {
    splices.push({ at: header + 1, remove: 0, add: [`${managedCommand}${cr}`] });
  } else if (args === undefined) {
    splices.push({ at: command.end + 1, remove: 0, add: [`${managedArgs}${cr}`] });
  }
  splices.sort((a, b) => b.at - a.at || b.remove - a.remove);
  for (const splice of splices) {
    work.splice(splice.at, splice.remove, ...splice.add);
  }

  let next = work.join('\n');
  if (addedFinalEol && next.endsWith(eol)) {
    next = next.slice(0, -eol.length);
  }
  return next === text ? { kind: 'ok', text, changed: false } : { kind: 'ok', text: next, changed: true };
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
