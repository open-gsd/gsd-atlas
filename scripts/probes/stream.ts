/**
 * Reduces one raw `claude -p --output-format stream-json` stream to the compact record the probes keep.
 * Counts, names, numbers and file lists only: no answer prose, no tool-result text, no secrets.
 * Unscored and exploratory.
 */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function eventsOf(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // A line cut off mid-write is ignored.
    }
  }
  return out;
}

export interface FirstRequest {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  billable: number;
}

export interface SessionFacts {
  status: 'ok' | 'error' | 'no_result';
  claudeCodeVersion: string | null;
  apiKeySource: string | null;
  init: { toolCount: number; mcpToolCount: number; tools: string[]; skills: string[]; mcpServers: string[] } | null;
  firstRequest: FirstRequest | null;
  usage: Usage;
  numTurns: number;
  toolCalls: number;
  toolCallsExStructured: number;
  atlasCalls: number;
  byTool: Record<string, number>;
  skillLoaded: boolean;
  costUsd: number | null;
  wallMs: number;
  answerFiles: string[] | null;
}

const ZERO: Usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, billable: 0 };
const ATLAS_PREFIX = 'mcp__gsd-atlas__';

function usageOf(u: unknown): Usage {
  const r = isRecord(u) ? u : {};
  const input = num(r['input_tokens']);
  const cacheCreation = num(r['cache_creation_input_tokens']);
  const cacheRead = num(r['cache_read_input_tokens']);
  const output = num(r['output_tokens']);
  return { input, cacheCreation, cacheRead, output, billable: input + cacheCreation + cacheRead + output };
}

/** A path as repo-relative: leading `./` and any absolute prefix up to a known repo marker removed. */
export function normaliseFile(file: string, roots: readonly string[] = []): string {
  let f = file.trim();
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (f.startsWith(prefix)) f = f.slice(prefix.length);
  }
  while (f.startsWith('./')) f = f.slice(2);
  return f;
}

function answerFilesOf(result: Record<string, unknown> | undefined, roots: readonly string[]): string[] | null {
  if (result === undefined) return null;
  let answer: unknown = result['structured_output'];
  if (!isRecord(answer) && typeof result['result'] === 'string') {
    try {
      answer = JSON.parse(result['result']);
    } catch {
      answer = undefined;
    }
  }
  if (!isRecord(answer) || !Array.isArray(answer['items'])) return null;
  const files: string[] = [];
  for (const item of answer['items']) if (isRecord(item) && typeof item['file'] === 'string') files.push(normaliseFile(item['file'], roots));
  return [...new Set(files)].sort();
}

export function recordOf(text: string, extra: { wallMs: number; repoRoots?: readonly string[] }): SessionFacts {
  const events = eventsOf(text);
  const initEvent = events.find((e) => e['type'] === 'system' && e['subtype'] === 'init');
  const toolsList = initEvent !== undefined && Array.isArray(initEvent['tools']) ? initEvent['tools'].filter((t): t is string => typeof t === 'string') : [];
  const skills = initEvent !== undefined && Array.isArray(initEvent['skills']) ? initEvent['skills'].filter((t): t is string => typeof t === 'string') : [];
  const mcpServers =
    initEvent !== undefined && Array.isArray(initEvent['mcp_servers'])
      ? initEvent['mcp_servers'].flatMap((s) => (isRecord(s) && typeof s['name'] === 'string' ? [s['name']] : []))
      : [];

  const byTool: Record<string, number> = {};
  const seen = new Set<string>();
  let firstRequest: FirstRequest | null = null;
  const perMessage = new Map<string, Usage>();
  for (const e of events) {
    if (e['type'] !== 'assistant' || !isRecord(e['message'])) continue;
    const message = e['message'];
    if (firstRequest === null && isRecord(message['usage'])) {
      const u = usageOf(message['usage']);
      firstRequest = { input: u.input, cacheCreation: u.cacheCreation, cacheRead: u.cacheRead, total: u.input + u.cacheCreation + u.cacheRead };
    }
    if (typeof message['id'] === 'string' && isRecord(message['usage'])) perMessage.set(message['id'], usageOf(message['usage']));
    const content = message['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue;
      const id = block['id'];
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      byTool[block['name']] = (byTool[block['name']] ?? 0) + 1;
    }
  }
  let result: Record<string, unknown> | undefined;
  for (const e of events) if (e['type'] === 'result') result = e;
  let usage: Usage = { ...ZERO };
  if (result !== undefined && isRecord(result['usage'])) usage = usageOf(result['usage']);
  else {
    for (const u of perMessage.values()) {
      usage.input += u.input;
      usage.cacheCreation += u.cacheCreation;
      usage.cacheRead += u.cacheRead;
      usage.output += u.output;
      usage.billable += u.billable;
    }
  }
  const toolCalls = Object.values(byTool).reduce((a, b) => a + b, 0);
  const structured = byTool['StructuredOutput'] ?? 0;
  return {
    status: result === undefined ? 'no_result' : result['is_error'] === true ? 'error' : 'ok',
    claudeCodeVersion: initEvent !== undefined && typeof initEvent['claude_code_version'] === 'string' ? initEvent['claude_code_version'] : null,
    apiKeySource: initEvent !== undefined && typeof initEvent['apiKeySource'] === 'string' ? initEvent['apiKeySource'] : null,
    init:
      initEvent === undefined
        ? null
        : { toolCount: toolsList.length, mcpToolCount: toolsList.filter((t) => t.startsWith('mcp__')).length, tools: toolsList, skills, mcpServers },
    firstRequest,
    usage,
    numTurns: result === undefined ? 0 : num(result['num_turns']),
    toolCalls,
    toolCallsExStructured: toolCalls - structured,
    atlasCalls: Object.entries(byTool).reduce((a, [name, n]) => (name.startsWith(ATLAS_PREFIX) ? a + n : a), 0),
    byTool,
    skillLoaded: (byTool['Skill'] ?? 0) > 0,
    costUsd: result === undefined ? null : num(result['total_cost_usd']),
    wallMs: extra.wallMs,
    answerFiles: answerFilesOf(result, extra.repoRoots ?? []),
  };
}

export interface RateLimit {
  fiveHour: number | null;
  sevenDay: number | null;
  isUsingOverage: boolean | null;
  overageStatus: string | null;
}

/** The last rate-limit event of a stream: the two utilisation fractions and the overage flags. */
export function rateLimitOf(text: string): RateLimit {
  const out: RateLimit = { fiveHour: null, sevenDay: null, isUsingOverage: null, overageStatus: null };
  for (const e of eventsOf(text)) {
    if (e['type'] !== 'rate_limit_event' || !isRecord(e['rate_limit_info'])) continue;
    const info = e['rate_limit_info'];
    const windows = isRecord(info['unifiedWindows']) ? info['unifiedWindows'] : {};
    const five = isRecord(windows['five_hour']) ? windows['five_hour'] : undefined;
    const seven = isRecord(windows['seven_day']) ? windows['seven_day'] : undefined;
    if (five !== undefined && typeof five['utilization'] === 'number') out.fiveHour = five['utilization'];
    if (seven !== undefined && typeof seven['utilization'] === 'number') out.sevenDay = seven['utilization'];
    if (typeof info['isUsingOverage'] === 'boolean') out.isUsingOverage = info['isUsingOverage'];
    if (typeof info['overageStatus'] === 'string') out.overageStatus = info['overageStatus'];
  }
  return out;
}

function contentBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) if (isRecord(part) && typeof part['text'] === 'string') total += Buffer.byteLength(part['text'], 'utf8');
    return total;
  }
  return 0;
}

/** Bytes of each tool result, paired with the name of the tool call it answers, in stream order. */
export function resultBytesByTool(text: string): { tool: string; bytes: number }[] {
  const names = new Map<string, string>();
  const out: { tool: string; bytes: number }[] = [];
  for (const e of eventsOf(text)) {
    if (e['type'] === 'assistant' && isRecord(e['message']) && Array.isArray(e['message']['content'])) {
      for (const block of e['message']['content']) {
        if (isRecord(block) && block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') names.set(block['id'], block['name']);
      }
    } else if (e['type'] === 'user' && isRecord(e['message']) && Array.isArray(e['message']['content'])) {
      for (const block of e['message']['content']) {
        if (isRecord(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
          out.push({ tool: names.get(block['tool_use_id']) ?? 'unknown', bytes: contentBytes(block['content']) });
        }
      }
    }
  }
  return out;
}

export interface KeyComparison {
  equal: boolean;
  matched: number;
  missing: number;
  extra: number;
}

/** Descriptive only: set equality of the distinct answer files against the distinct key files. */
export function compareToKey(answer: readonly string[], key: readonly string[]): KeyComparison {
  const a = new Set(answer);
  const k = new Set(key);
  let matched = 0;
  for (const f of a) if (k.has(f)) matched += 1;
  const missing = k.size - matched;
  const extra = a.size - matched;
  return { equal: a.size > 0 && missing === 0 && extra === 0, matched, missing, extra };
}
