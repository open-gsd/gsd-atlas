/**
 * Repo text on its way to an agent (QRY-05, trust-boundaries ADR, research Pattern 9, PITFALLS B11).
 *
 * Everything that comes from the repository (matched source lines, symbol names, paths) is attacker-influenced
 * and reaches a model's context. Two defences live here: `normalizeText` removes what hides or forges content
 * (escape sequences, zero-width and bidirectional controls, line separators, lone surrogates), and `fenceText`
 * wraps a matched line in a fence that carries an unguessable per-response nonce. The fence reduces prompt
 * injection and cannot prevent it; the tool descriptions say so.
 */
import { randomBytes } from 'node:crypto';

/** The width structured repo strings (symbol names, kinds, paths) are capped at, in UTF-16 code units. */
export const FIELD_MAX_CHARS = 200;

/** What replaces a line that contains the response's own nonce, inside the same fence. */
export const OMITTED_LINE = '[line omitted]';

const ELLIPSIS = '...';

/** A full ANSI control sequence: ESC, `[`, parameter bytes, intermediate bytes, one final byte. */
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Control (Cc), format (Cf), line separator (Zl) and paragraph separator (Zp) code points. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A high surrogate with no low surrogate after it, or a low surrogate with no high one before it. Written
 * without the `u` flag so the pattern sees code units. (`String.prototype.toWellFormed` does the same, but the
 * project's TypeScript library target is ES2023, which does not declare it.)
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A fresh 128-bit nonce, 32 hexadecimal characters. One per response; never reused. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, maxChars));
  let end = maxChars - ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  // Never cut between the two halves of a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}

/**
 * Make one piece of repo text safe to show: strip ANSI sequences first (otherwise `[31m` is left behind), turn
 * tabs into spaces, replace lone surrogates with U+FFFD, remove the Cc, Cf, Zl and Zp categories, then cut to
 * `maxChars` code units with a trailing three-dot ellipsis that fits inside that width.
 */
export function normalizeText(text: string, maxChars: number): string {
  const stripped = text.replace(ANSI_CSI, '').replace(/\t/g, ' ');
  return truncate(stripped.replace(LONE_SURROGATE, '�').replace(INVISIBLE, ''), maxChars);
}

/**
 * One matched line as an `untrusted_text` entry: `BEGIN-UNTRUSTED-{nonce}`, the normalized line, then
 * `END-UNTRUSTED-{nonce}`, each on its own line. A line that contains the nonce (before or after
 * normalization) is replaced by the omission marker, so text can never close the fence it sits in; text that
 * merely imitates a marker is harmless because the real markers carry the unguessable nonce.
 */
export function fenceText(raw: string, nonce: string, maxChars: number): string {
  const clean = normalizeText(raw, maxChars);
  const body = raw.includes(nonce) || clean.includes(nonce) ? OMITTED_LINE : clean;
  return `BEGIN-UNTRUSTED-${nonce}\n${body}\nEND-UNTRUSTED-${nonce}`;
}
