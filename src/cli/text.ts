/**
 * Small text helpers shared by the CLI's commands: a message on one line, and the printing of an envelope with its
 * reasons. They import nothing but the host-client seam (adapter rule).
 */
import type { Envelope } from '../host-client/index.ts';

/** Control characters, C1 controls and the Unicode line and paragraph separators. */
export const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** A message on one line: a stray newline must not turn one reason into several (stderr is line-oriented). */
export function oneLine(text: string): string {
  let clean = '';
  for (const char of text) clean += isControl(char.codePointAt(0) as number) ? ' ' : char;
  return clean;
}

/** Where output goes. The CLI is given its streams; it never writes to the process's own. */
export interface Sinks {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

/** Print an envelope exactly as returned (one JSON line), then one reason line per error or warning diagnostic. */
export function printEnvelope(sinks: Sinks, envelope: Envelope): void {
  sinks.stdout.write(`${JSON.stringify(envelope)}\n`);
  for (const d of envelope.diagnostics) {
    if (d.severity === 'error' || d.severity === 'warning') {
      // A busy answer says when to come back; that number lives on the envelope, so the reason line repeats it.
      const wait = d.code === 'busy' && typeof envelope.retry_after === 'number' ? ` (retry after ${String(envelope.retry_after)} ms)` : '';
      sinks.stderr.write(`gsd-atlas: ${d.severity} ${d.code}: ${oneLine(d.message)}${wait}\n`);
    }
  }
}

/** A value as the person sees it: JSON-quoted, with the characters JSON leaves raw (C1 controls, line separators) escaped too. */
export function show(text: string): string {
  let out = '';
  for (const char of JSON.stringify(text)) {
    const code = char.codePointAt(0) as number;
    out += isControl(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return out;
}

/**
 * The line that tells the person what a confirmed `allow` approved: the executable and its arguments, each quoted and
 * escaped. Null when the reply carries no command (an error reply, or a reply from a Host that does not echo it).
 */
export function approvedLine(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const { executable, args } = data as Record<string, unknown>;
  if (typeof executable !== 'string' || !Array.isArray(args) || !args.every((each): each is string => typeof each === 'string')) return null;
  return `gsd-atlas: approved command: ${show(executable)} [${args.map(show).join(', ')}]\n`;
}

/**
 * The one line that tells the person a `rate` was recorded: the value and what it was for (the answer, the session or
 * a feature by name). It never repeats an id. A reply without the expected words still gets a plain confirmation.
 */
export function ratedLine(data: unknown): string {
  const { value, scope, feature } = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (value !== 'up' && value !== 'meh' && value !== 'down') return 'gsd-atlas: rating recorded\n';
  const what =
    scope === 'feature' && typeof feature === 'string' ? `feature ${show(feature)}` : scope === 'session' ? 'the session' : 'the last answer';
  return `gsd-atlas: recorded "${value}" for ${what}\n`;
}
