/**
 * The flight recorder (plan 03-17, D-16, DIAGNOSTICS.md section 9.1): a small local file beside a repository's store
 * that remembers the last tool answers, so a later `gsd-atlas rate` or `gsd-atlas bug` (a different process from the
 * MCP server that answered) can name an answer without the answer being kept.
 *
 * An event holds codes, counts and handles only: the answer id, the time, the tool, the request arguments (string
 * values cut at 200 characters), the outcome code, a latency bucket label, the degraded codes, the result count and up
 * to 20 citation handles. It never holds an answer's data or any repository text the answer fenced as untrusted.
 *
 * The file is JSON lines, appended to by whichever process answered, one `appendFileSync` of one whole line at a time.
 * Writing never throws: a failure is dropped, because recording must not alter or delay an answer (the MET-02 rule).
 * Reading skips any line that does not parse, so a torn or foreign line costs one event, never a read.
 *
 * Imports only `node:` built-ins and types, so a child process can load this file on its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../facts/index.ts';

/** One remembered answer, or the marker that a session (one Tenant's run of answers) began. */
export interface FlightEvent {
  /** Epoch milliseconds, from the injected clock. */
  readonly t: number;
  readonly kind: 'answer' | 'session';
  /** The answer id (`a_` and 16 hex digits) or the session id (`s_` and 16 hex digits). */
  readonly id: string;
  readonly tool?: string;
  /** The request arguments, string values cut at {@link ARG_MAX_CHARS} characters. */
  readonly args?: Record<string, unknown>;
  /** `ok`, or the first diagnostic code of a refused request. */
  readonly outcome?: string;
  /** The latency bucket label of the metrics histogram (`le50`, `inf`), never a measured number. */
  readonly ms?: string;
  readonly degraded?: readonly string[];
  /** The number of citations in the answer. */
  readonly count?: number;
  /** The citations' debug handles, at most {@link HANDLES_MAX}. */
  readonly handles?: readonly string[];
}

/** What a caller appends: the time is optional and defaults to the recorder's clock. */
export type FlightEventInput = Omit<FlightEvent, 't'> & { readonly t?: number };

/** The file operations the recorder uses, so a test can make every one of them fail. */
export interface FlightFs {
  mkdirSync(dir: string, options: { readonly recursive: true; readonly mode: number }): unknown;
  appendFileSync(file: string, data: string, options: { readonly mode: number }): void;
  readFileSync(file: string, encoding: 'utf8'): string;
  renameSync(from: string, to: string): void;
  rmSync(target: string, options: { readonly force: true }): void;
  statSync(file: string): { readonly size: number };
}

export interface FlightRecorderOptions {
  /** The folder of the recorder: `<store dir>/flight`. Created on the first append. */
  readonly dir: string;
  /** Events kept (`recorder.maxEvents`, 03-CONSTANTS.md). */
  readonly maxEvents: number;
  /** Bytes kept (`recorder.maxBytes`, 03-CONSTANTS.md). */
  readonly maxBytes: number;
  readonly clock: Clock;
  readonly fs?: FlightFs;
}

export interface FlightRecorder {
  /** Add one event. Never throws, never blocks beyond one small synchronous write. */
  append(event: FlightEventInput): void;
  /** The newest `n` events (of `kind`, when given; else answers and session markers), oldest first. Never throws. */
  recent(n: number, kind?: FlightEvent['kind']): FlightEvent[];
  /** The newest answer event, or null. */
  lastAnswer(): FlightEvent | null;
  /** The id of the newest session marker, or null. */
  sessionId(): string | null;
  close(): void;
}

/** Characters kept of a string value in `args`. */
export const ARG_MAX_CHARS = 200;
/** Citation handles kept in one event. */
export const HANDLES_MAX = 20;

const SHORT_MAX_CHARS = 64;
const DEGRADED_MAX = 16;
const ARG_KEYS_MAX = 32;
const ARG_ITEMS_MAX = 20;
const ARG_DEPTH_MAX = 3;

export const CURRENT_FILE = 'flight.jsonl';

/** The first `max` code points of `text`; never splits a surrogate pair, and stops reading a huge string early. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  let count = 0;
  for (const char of text) {
    if (count >= max) break;
    out += char;
    count += 1;
  }
  return out;
}

/** A request argument made safe to keep: bounded in depth, width and string length, scalars only at the leaves. */
function boundedArg(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return cut(value, ARG_MAX_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= ARG_DEPTH_MAX) return null;
  if (Array.isArray(value)) return value.slice(0, ARG_ITEMS_MAX).map((item) => boundedArg(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, ARG_KEYS_MAX)) {
      out[cut(key, SHORT_MAX_CHARS)] = boundedArg((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return null;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The event as it is written: only the known fields, each bounded. Anything else a caller passed is dropped here. */
function normalise(event: FlightEventInput, now: number): FlightEvent {
  const out: { -readonly [K in keyof FlightEvent]: FlightEvent[K] } = {
    t: typeof event.t === 'number' && Number.isFinite(event.t) ? event.t : now,
    kind: event.kind === 'session' ? 'session' : 'answer',
    id: cut(String(event.id), SHORT_MAX_CHARS),
  };
  if (typeof event.tool === 'string') out.tool = cut(event.tool, SHORT_MAX_CHARS);
  if (typeof event.args === 'object' && event.args !== null && !Array.isArray(event.args)) {
    out.args = boundedArg(event.args, 0) as Record<string, unknown>;
  }
  if (typeof event.outcome === 'string') out.outcome = cut(event.outcome, SHORT_MAX_CHARS);
  if (typeof event.ms === 'string') out.ms = cut(event.ms, SHORT_MAX_CHARS);
  if (Array.isArray(event.degraded)) {
    out.degraded = (event.degraded as readonly unknown[])
      .filter((code): code is string => typeof code === 'string')
      .slice(0, DEGRADED_MAX)
      .map((code) => cut(code, SHORT_MAX_CHARS));
  }
  if (isCount(event.count)) out.count = event.count;
  if (Array.isArray(event.handles)) {
    out.handles = (event.handles as readonly unknown[])
      .filter((handle): handle is string => typeof handle === 'string')
      .slice(0, HANDLES_MAX)
      .map((handle) => cut(handle, ARG_MAX_CHARS));
  }
  return out;
}

/** The event a line holds, or null for a line that is not one. */
function parseLine(line: string): FlightEvent | null {
  if (line === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { t, kind, id } = value as Record<string, unknown>;
    if (typeof t !== 'number' || !Number.isFinite(t)) return null;
    if (kind !== 'answer' && kind !== 'session') return null;
    if (typeof id !== 'string' || id === '') return null;
    return value as FlightEvent;
  } catch {
    return null;
  }
}

export function createFlightRecorder(options: FlightRecorderOptions): FlightRecorder {
  const io: FlightFs = options.fs ?? fs;
  const current = path.join(options.dir, CURRENT_FILE);
  let dirReady = false;

  function ensureDir(): void {
    if (dirReady) return;
    io.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    dirReady = true;
  }

  /** Every event on disk, oldest first. A missing or unreadable file is empty. */
  function readAll(): FlightEvent[] {
    let text: string;
    try {
      text = io.readFileSync(current, 'utf8');
    } catch {
      return [];
    }
    const events: FlightEvent[] = [];
    for (const line of text.split('\n')) {
      const event = parseLine(line);
      if (event !== null) events.push(event);
    }
    // Stable: equal times keep file order.
    return events.map((event, index) => ({ event, index })).sort((a, b) => a.event.t - b.event.t || a.index - b.index).map((entry) => entry.event);
  }

  const newest = (kind: FlightEvent['kind']): FlightEvent | null => {
    const events = readAll();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as FlightEvent;
      if (event.kind === kind) return event;
    }
    return null;
  };

  return {
    append(event) {
      try {
        const line = `${JSON.stringify(normalise(event, options.clock.now()))}\n`;
        ensureDir();
        io.appendFileSync(current, line, { mode: 0o600 });
      } catch {
        // Recording never alters an answer: a write that fails is dropped.
        dirReady = false;
      }
    },
    recent(n, kind) {
      if (!Number.isInteger(n) || n <= 0) return [];
      try {
        const events = readAll();
        return (kind === undefined ? events : events.filter((event) => event.kind === kind)).slice(-n);
      } catch {
        return [];
      }
    },
    lastAnswer: () => newest('answer'),
    sessionId: () => newest('session')?.id ?? null,
    close() {
      // Nothing is held open between appends.
    },
  };
}
