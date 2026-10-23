// Reads a recorded `claude -p --output-format stream-json` stream into an ordered list of tool calls.
// Offline analysis only: this file never starts a model session and never touches the network.

export interface Call {
  /** The tool_use id. */
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Index of the assistant message (distinct message id, in order of first appearance) that issued the call. */
  readonly turn: number;
  /** Position of the call among all calls of the session. */
  readonly order: number;
  /** The text of the tool result, or null when the stream holds none. */
  result: string | null;
}

export interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly calls: Call[];
  /** The input of the final StructuredOutput call, when there is one. */
  readonly answer: Record<string, unknown> | null;
}

const ATLAS_PREFIX = 'mcp__gsd-atlas__';

export const isAtlasCall = (call: Call): boolean => call.name.startsWith(ATLAS_PREFIX);
export const atlasTool = (call: Call): string => call.name.slice(ATLAS_PREFIX.length);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/** Parses the text of one stream file. Lines that are not JSON are skipped. */
export function parseStream(id: string, text: string): Session {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  const turnOf = new Map<string, number>();
  let cwd = '';
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init' && typeof event.cwd === 'string') cwd = event.cwd;
    const message = event.message as { id?: unknown; content?: unknown } | undefined;
    if (event.type === 'assistant' && message !== undefined && Array.isArray(message.content)) {
      const messageId = typeof message.id === 'string' ? message.id : `anon-${String(calls.length)}`;
      if (!turnOf.has(messageId)) turnOf.set(messageId, turnOf.size);
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
        if (byId.has(block.id)) continue;
        const call: Call = {
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
          turn: turnOf.get(messageId) as number,
          order: calls.length,
          result: null,
        };
        calls.push(call);
        byId.set(call.id, call);
      }
    }
    if (event.type === 'user' && message !== undefined && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = byId.get(block.tool_use_id);
        if (call !== undefined) call.result = textOf(block.content);
      }
    }
  }
  const finals = calls.filter((call) => call.name === 'StructuredOutput');
  const last = finals.length > 0 ? finals[finals.length - 1] : undefined;
  return { id, cwd, calls, answer: last === undefined ? null : last.input };
}

/** Repo-relative form of a path an agent used: the session working directory is stripped, `./` is dropped. */
export function repoRelative(raw: string, cwd: string): string {
  let out = raw;
  if (cwd !== '' && out.startsWith(`${cwd}/`)) out = out.slice(cwd.length + 1);
  if (cwd !== '' && out.startsWith(`${cwd}`) && out.length === cwd.length) out = '.';
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}
