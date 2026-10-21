/**
 * P4, offline: how large are the tool results in a set of session streams, and how much of the session's
 * tokens do they carry? A result is measured by the growth of the next request over the previous one
 * (minus the previous output), split by bytes when several results arrive together. A result stays in
 * the context of every later request, so `carriedTokens` = tokens x later requests. Estimates, not billing.
 */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface Payload {
  tool: string;
  bytes: number;
  tokens: number;
  laterRequests: number;
}

interface Turn {
  id: string;
  inTotal: number;
  out: number;
}

export function payloadsOf(text: string): Payload[] {
  const turns: Turn[] = [];
  const turnIndex = new Map<string, number>();
  const names = new Map<string, string>();
  // Ordered items: a turn or a result.
  const order: ({ turn: number } | { id: string; bytes: number })[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let e: unknown;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(e) || !isRecord(e['message'])) continue;
    const message = e['message'];
    if (e['type'] === 'assistant' && typeof message['id'] === 'string') {
      const u = isRecord(message['usage']) ? message['usage'] : {};
      const turn: Turn = {
        id: message['id'],
        inTotal: num(u['input_tokens']) + num(u['cache_creation_input_tokens']) + num(u['cache_read_input_tokens']),
        out: num(u['output_tokens']),
      };
      const known = turnIndex.get(turn.id);
      if (known === undefined) {
        turnIndex.set(turn.id, turns.length);
        order.push({ turn: turns.length });
        turns.push(turn);
      } else turns[known] = turn;
      if (Array.isArray(message['content'])) {
        for (const b of message['content']) if (isRecord(b) && b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') names.set(b['id'], b['name']);
      }
    } else if (e['type'] === 'user' && Array.isArray(message['content'])) {
      for (const b of message['content']) {
        if (!isRecord(b) || b['type'] !== 'tool_result' || typeof b['tool_use_id'] !== 'string') continue;
        const c = b['content'];
        const bytes =
          typeof c === 'string'
            ? Buffer.byteLength(c, 'utf8')
            : Array.isArray(c)
              ? c.reduce((a: number, p: unknown) => a + (isRecord(p) && typeof p['text'] === 'string' ? Buffer.byteLength(p['text'], 'utf8') : 0), 0)
              : 0;
        order.push({ id: b['tool_use_id'], bytes });
      }
    }
  }
  const out: Payload[] = [];
  let lastTurn = -1;
  let pending: { id: string; bytes: number }[] = [];
  const flush = (nextTurn: number): void => {
    if (pending.length === 0) return;
    const prev = turns[lastTurn];
    const next = turns[nextTurn];
    const total = pending.reduce((a, p) => a + p.bytes, 0);
    const delta = prev !== undefined && next !== undefined ? Math.max(0, next.inTotal - prev.inTotal - prev.out) : 0;
    for (const p of pending) {
      out.push({
        tool: names.get(p.id) ?? 'unknown',
        bytes: p.bytes,
        tokens: total === 0 ? 0 : Math.round((delta * p.bytes) / total),
        laterRequests: turns.length - 1 - lastTurn,
      });
    }
    pending = [];
  };
  for (const item of order) {
    if ('turn' in item) {
      flush(item.turn);
      lastTurn = item.turn;
    } else pending.push(item);
  }
  // Results after the last request were never sent back: not counted.
  return out;
}

export interface ToolSummary {
  calls: number;
  medianBytes: number;
  maxBytes: number;
  totalBytes: number;
  overBytes: Record<number, number>;
  tokens: number;
  carriedTokens: number;
}

export interface Summary {
  sessions: number;
  sessionTokens: number;
  byTool: Record<string, ToolSummary>;
}

function sessionTokensOf(text: string): number {
  let tokens = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const e: unknown = JSON.parse(raw);
      if (isRecord(e) && e['type'] === 'result' && isRecord(e['usage'])) {
        const u = e['usage'];
        tokens = num(u['input_tokens']) + num(u['cache_creation_input_tokens']) + num(u['cache_read_input_tokens']) + num(u['output_tokens']);
      }
    } catch {
      // ignore
    }
  }
  return tokens;
}

export function summarize(streams: readonly string[], thresholds: readonly number[]): Summary {
  const bytesBy: Record<string, number[]> = {};
  const tokensBy: Record<string, number> = {};
  const carriedBy: Record<string, number> = {};
  let sessionTokens = 0;
  for (const text of streams) {
    sessionTokens += sessionTokensOf(text);
    for (const p of payloadsOf(text)) {
      (bytesBy[p.tool] ??= []).push(p.bytes);
      tokensBy[p.tool] = (tokensBy[p.tool] ?? 0) + p.tokens;
      carriedBy[p.tool] = (carriedBy[p.tool] ?? 0) + p.tokens * p.laterRequests;
    }
  }
  const byTool: Record<string, ToolSummary> = {};
  for (const [tool, bytes] of Object.entries(bytesBy)) {
    const over: Record<number, number> = {};
    for (const t of thresholds) over[t] = bytes.filter((b) => b > t).length;
    byTool[tool] = {
      calls: bytes.length,
      medianBytes: median(bytes),
      maxBytes: Math.max(...bytes),
      totalBytes: bytes.reduce((a, b) => a + b, 0),
      overBytes: over,
      tokens: tokensBy[tool] ?? 0,
      carriedTokens: carriedBy[tool] ?? 0,
    };
  }
  return { sessions: streams.length, sessionTokens, byTool };
}
