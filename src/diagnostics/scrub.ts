/**
 * Scrubbing of the user's own note (docs/DIAGNOSTICS.md principle 5 and section 3.10): a note is free text, so before it is
 * shown for review, and again when a report is rendered, anything that looks like a path, a URL, an e-mail address, a host
 * name, an IP address, a mention or a secret is replaced by `[removed]`. The rest of the user's words stay.
 *
 * This is a safety net, not a promise to find every identifier: the note is the user's text, it is always shown to them
 * before anything is sent, and it is never part of anything automatic. The order of the replacements matters (a URL goes
 * before the paths and host names inside it), each pattern is anchored by what must precede it, and none can backtrack
 * badly: the input is cut to a bounded length before it is scanned.
 */

/** What a removed fragment becomes. */
export const REMOVED = '[removed]';

/** The most characters of a note that are kept (after scrubbing). */
export const NOTE_MAX_CHARS = 500;

/** Appended when a note was cut. */
export const NOTE_CUT_MARKER = ' [cut]';

/** The most characters read from a note before scanning, so a huge paste cannot make the scan slow. */
const NOTE_INPUT_MAX_CHARS = 20_000;

/** The characters a path, URL or host name can contain; a match ends at whitespace or a quote. */
const STOP = '\\s<>"\'`';
/** A final character that is sentence punctuation rather than part of the thing: `see https://x.example/y, then`. */
const NOT_LAST = `${STOP}.,;:!?)\\]}`;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // URLs, before the paths and host names inside them.
  [new RegExp(`\\b[a-z][a-z0-9+.-]*:\\/\\/[^${STOP}]*[^${NOT_LAST}]`, 'gi'), REMOVED],
  [new RegExp(`\\bwww\\.[^${STOP}]*[^${NOT_LAST}]`, 'gi'), REMOVED],
  // E-mail addresses.
  [/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, REMOVED],
  // Secret shapes: JSON web tokens, AWS keys, GitHub tokens, `sk-` keys, Slack tokens, bearer tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REMOVED],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, REMOVED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REMOVED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REMOVED],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, REMOVED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, REMOVED],
  // A secret named before its value: `password: x`, `token=x`, `the password is x`. The name stays, the value goes.
  [/\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|auth)\b(\s*[:=]\s*)(\S+)/gi, `$1$2${REMOVED}`],
  [/\b(password|passwd|pwd|passphrase)\b(\s+(?:is\s+)?)(?!\[removed\])(\S+)/gi, `$1$2${REMOVED}`],
  // Paths: Windows drives, UNC shares, home folders, absolute POSIX paths of two or more segments, relative ones.
  [new RegExp(`\\b[a-z]:[\\\\/][^${STOP}]*`, 'gi'), REMOVED],
  [/\\\\[^\s\\]+(?:\\[^\s\\]+)*/g, REMOVED],
  [new RegExp(`(?<![\\w.])~[\\w-]*[\\\\/][^${STOP}]*`, 'g'), REMOVED],
  [/(?<![\w.:/\\-])\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]*/g, REMOVED],
  [/(?<![\w.@/\\-])\.{1,2}\/[\w.@%+~/-]+/g, REMOVED],
  [/(?<![\w.@/\\-])(?:[\w.@%+~-]+\/)+[\w@%+~-][\w.@%+~-]*\.[a-z0-9]{1,8}\b/gi, REMOVED],
  [/(?<![\w.@/\\-])(?:[\w.@%+~-]+\/){2,}[\w.@%+~-]+/g, REMOVED],
  // Host names under the usual suffixes (including the ones private networks use), and IP addresses.
  [/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|app|cloud|example|internal|corp|local|lan|intranet|test|invalid|localhost)\b/gi, REMOVED],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, REMOVED],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, REMOVED],
  // Long hexadecimal strings (hashes, keys) and any other long opaque token.
  [/\b[0-9a-f]{32,}\b/gi, REMOVED],
  [/(?<![\w+/=-])[A-Za-z0-9_+/=-]{40,}(?![\w+/=-])/g, REMOVED],
  // @mentions notify people on GitHub.
  [/(?<![\w@])@[A-Za-z0-9][A-Za-z0-9_-]*/g, REMOVED],
];

/** Control characters, C1 controls and the Unicode line and paragraph separators and bidi overrides. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * The note made safe to show and to put in a report: control characters become spaces, backticks become apostrophes (so a
 * note cannot close the code fence of the report), sensitive shapes become `[removed]`, whitespace runs collapse, and the
 * result is cut at {@link NOTE_MAX_CHARS} characters with {@link NOTE_CUT_MARKER}. Scrubbing comes before the cut, so a secret
 * cannot survive as a fragment at the cut. Scrubbing a scrubbed note changes nothing.
 */
export function scrubNote(text: string): string {
  let out = (text.length > NOTE_INPUT_MAX_CHARS ? text.slice(0, NOTE_INPUT_MAX_CHARS) : text).replace(CONTROL, ' ').replaceAll('`', "'");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  const chars = [...out];
  return chars.length <= NOTE_MAX_CHARS ? out : `${chars.slice(0, NOTE_MAX_CHARS).join('').trimEnd()}${NOTE_CUT_MARKER}`;
}
