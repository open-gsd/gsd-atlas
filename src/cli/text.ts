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
