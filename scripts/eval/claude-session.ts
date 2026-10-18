// The one place that talks to `claude -p` (D-03, D-06). Eval tooling: it must never import from
// src/ (D-02). Live use on Windows is unsupported: npm shims (.cmd) are not spawnable without a
// shell, and a shell would break the argument-array rule. Tests drive a Node script through
// process.execPath instead (`executable` and `prefixArgs`).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export type SessionStatus = 'ok' | 'error' | 'timeout' | 'budget' | 'killed';

export interface SessionSpec {
  prompt: string;
  cwd: string;
  tools: string[];
  allowedTools: string[];
  mcpConfigPath: string;
  pluginDirs: string[];
  jsonSchema?: string;
  model?: string;
  maxBudgetUsd: number;
  wallClockMs: number;
  executable?: string;
  prefixArgs?: string[];
  env?: Record<string, string>;
  maxStdoutBytes?: number;
  rawStreamPath?: string;
}

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface McpServerInfo {
  name: string;
  status: string;
}

export interface PluginInfo {
  name: string;
  path: string;
  source: string;
}

export interface InitEvent {
  tools: string[];
  mcpServers: McpServerInfo[];
  skills: string[];
  plugins: PluginInfo[];
  agents: string[];
  model: string;
  cwd: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface ResultEvent {
  isError: boolean;
  subtype: string;
  text: string;
  usage: Usage;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  /** The event exactly as the program wrote it, for fields this module does not model. */
  raw: StreamEvent;
}

export interface SessionOutcome {
  status: SessionStatus;
  init: InitEvent | null;
  result: ResultEvent | null;
  toolCalls: Record<string, number>;
  toolCallTotal: number;
  wallMs: number;
  ignoredLines: number;
  stderrTail: string;
}

// Event types the parser reads. Anything else is counted as ignored, never trusted.
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'system',
  'assistant',
  'user',
  'result',
  'rate_limit_event',
  'stream_event',
]);

export const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
export const STDERR_TAIL_CHARS = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** The full argv after the executable. The prompt is not part of it: it goes on stdin. */
export function buildClaudeArgs(spec: SessionSpec): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    spec.mcpConfigPath,
  ];
  for (const dir of spec.pluginDirs) args.push('--plugin-dir', dir);
  args.push('--tools', spec.tools.join(','));
  if (spec.allowedTools.length > 0) args.push('--allowedTools', spec.allowedTools.join(','));
  args.push('--max-budget-usd', String(spec.maxBudgetUsd));
  if (spec.jsonSchema !== undefined) args.push('--json-schema', spec.jsonSchema);
  if (spec.model !== undefined) args.push('--model', spec.model);
  args.push('--no-session-persistence');
  return args;
}

/**
 * Parse stream-json text. A line that is empty is skipped; a line that is not a JSON object with a
 * known string `type` (including a final line cut off mid-write) is counted in `ignoredLines`.
 */
export function parseStreamText(text: string): { events: StreamEvent[]; ignoredLines: number } {
  const events: StreamEvent[] = [];
  let ignoredLines = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      ignoredLines += 1;
      continue;
    }
    if (isRecord(parsed) && typeof parsed['type'] === 'string' && KNOWN_EVENT_TYPES.has(parsed['type'])) {
      events.push(parsed as StreamEvent);
    } else {
      ignoredLines += 1;
    }
  }
  return { events, ignoredLines };
}

/** The `system` event with subtype `init`, or null when none arrived. */
export function extractInit(events: readonly StreamEvent[]): InitEvent | null {
  const event = events.find((e) => e.type === 'system' && e['subtype'] === 'init');
  if (event === undefined) return null;
  const mcpServers: McpServerInfo[] = [];
  if (Array.isArray(event['mcp_servers'])) {
    for (const entry of event['mcp_servers']) {
      if (isRecord(entry) && typeof entry['name'] === 'string') {
        mcpServers.push({ name: entry['name'], status: str(entry['status']) });
      }
    }
  }
  const plugins: PluginInfo[] = [];
  if (Array.isArray(event['plugins'])) {
    for (const entry of event['plugins']) {
      if (isRecord(entry) && typeof entry['name'] === 'string') {
        plugins.push({ name: entry['name'], path: str(entry['path']), source: str(entry['source']) });
      }
    }
  }
  return {
    tools: stringList(event['tools']),
    mcpServers,
    skills: stringList(event['skills']),
    plugins,
    agents: stringList(event['agents']),
    model: str(event['model']),
    cwd: str(event['cwd']),
  };
}

/**
 * The last `result` event, or null when none arrived. A usage field that is absent reads as 0; one
 * that is present is passed through as given so `billableTokens` can reject a wrong report.
 */
export function extractResult(events: readonly StreamEvent[]): ResultEvent | null {
  let event: StreamEvent | undefined;
  for (const candidate of events) if (candidate.type === 'result') event = candidate;
  if (event === undefined) return null;
  const usage = isRecord(event['usage']) ? event['usage'] : {};
  return {
    isError: event['is_error'] === true,
    subtype: str(event['subtype']),
    text: str(event['result']),
    usage: {
      input: num(usage['input_tokens']),
      output: num(usage['output_tokens']),
      cacheCreation: num(usage['cache_creation_input_tokens']),
      cacheRead: num(usage['cache_read_input_tokens']),
    },
    totalCostUsd: num(event['total_cost_usd']),
    numTurns: num(event['num_turns']),
    durationMs: num(event['duration_ms']),
    raw: event,
  };
}

/** `tool_use` blocks inside assistant events, per tool name, deduplicated on the block id. */
export function countToolCalls(events: readonly StreamEvent[]): Record<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'assistant' || !isRecord(event['message'])) continue;
    const content = event['message']['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue;
      const id = block['id'];
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      counts.set(block['name'], (counts.get(block['name']) ?? 0) + 1);
    }
  }
  return Object.fromEntries(counts);
}

export function sumToolCalls(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

interface ChildSummary {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  capExceeded: boolean;
  spawnError: string | null;
}

function statusOfTask1(summary: ChildSummary, result: ResultEvent | null): SessionStatus {
  if (result === null) {
    if (summary.timedOut) return 'timeout';
    if (summary.capExceeded) return 'killed';
    return 'error';
  }
  return result.isError ? 'error' : 'ok';
}

export async function runClaudeSession(spec: SessionSpec): Promise<SessionOutcome> {
  const started = Date.now();
  const cap = spec.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const summary = await runChild(spec, cap);
  const wallMs = Date.now() - started;
  if (spec.rawStreamPath !== undefined) writeFileSync(spec.rawStreamPath, summary.stdout);
  const { events, ignoredLines } = parseStreamText(summary.stdout.toString('utf8'));
  const result = extractResult(events);
  const toolCalls = countToolCalls(events);
  return {
    status: statusOfTask1(summary, result),
    init: extractInit(events),
    result,
    toolCalls,
    toolCallTotal: sumToolCalls(toolCalls),
    wallMs,
    ignoredLines,
    stderrTail: summary.spawnError ?? summary.stderr,
  };
}

function runChild(spec: SessionSpec, cap: number): Promise<ChildSummary> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let stderr = '';
    let timedOut = false;
    let capExceeded = false;
    let spawnError: string | null = null;
    let settled = false;

    const args = [...(spec.prefixArgs ?? []), ...buildClaudeArgs(spec)];
    const child = spawn(spec.executable ?? 'claude', args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(chunks),
        stderr,
        timedOut,
        capExceeded,
        spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, spec.wallClockMs);

    child.on('error', (err: Error) => {
      spawnError = err.message.slice(-STDERR_TAIL_CHARS);
      finish(null, null);
    });
    child.stdin.on('error', () => {
      // The child may exit before reading the prompt; its exit status tells the story.
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (capExceeded) return;
      const room = cap - kept;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kept = cap;
        capExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    child.on('close', (code, signal) => finish(code, signal));

    child.stdin.end(spec.prompt);
  });
}
