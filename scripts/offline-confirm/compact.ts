// The proposed compact, file-grouped rendering of an atlas tool result (measurement A of
// `docs/eval/offline-confirmation-2026-10.md`). It re-renders a RECORDED envelope as text; it is
// not product code and nothing under `src/` uses it.
//
// Format (one page):
//
//   code_refs target=stringify function packages/core/src/util/stringify.ts:9 rows=8 total=38 more=<cursor>
//   BEGIN-UNTRUSTED-<nonce>
//   packages/core/src/animation/utils.ts
//    12:5 call fooBar P | the matched source line
//   END-UNTRUSTED-<nonce>
//
// - One header line: tool, the target(s) or seed(s), the row count, `more=` (the unchanged cursor,
//   needed to page), and `truncated`, `stale=`, `degraded=` only when present.
// - Diagnostics, when present, as `! code: message` lines before the fence.
// - One fence around the whole body (every path, name and source line is repo-derived text), with the
//   page's nonce. The nonce fence is kept; it is written once per page, not once per entry.
// - One header line per file, then one line per reference: `line:col`, the kind and the enclosing
//   symbol (or the name), flags, and `| matched line`.
// - Dropped: `schema`, `ok`, the `citations` records (ids, endLine/endCol, `debug` handles,
//   `text_ref`), the per-row `target`/`from`/`handle`/`citation`/`edge` fields, `hints`, `answer_id`,
//   the `watermark.seq`, and the `untrusted_text` entry wrapper (`ref`).

import type { Call } from './stream.ts';

type Json = Record<string, unknown>;

export interface Compact {
  /** The rendered page. */
  readonly text: string;
  /** Rows that carry a path and a line: the references of the page. */
  readonly references: number;
  /** The tool the envelope came from (`code_refs`, ...), or null when it could not be told. */
  readonly tool: string | null;
}

const BEGIN = /^BEGIN-UNTRUSTED-[0-9a-f]+$/;
const END = /^END-UNTRUSTED-[0-9a-f]+$/;
const SEPARATE = new Set(['results', 'targets', 'seeds']);
const DROP_KEYS = new Set(['citation', 'handle', 'target', 'from', 'edge', 'candidates', 'chain_confidence']);

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** The matched source text of an `untrusted_text` entry, with the fence lines removed and line breaks folded. */
export function unfence(text: string): string {
  return text
    .split('\n')
    .filter((line) => !BEGIN.test(line.trim()) && !END.test(line.trim()))
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ⏎ ');
}

/** The tool name of a recorded call, from the call when known, else from the envelope `schema`. */
export function toolOf(call: Call | undefined, envelope: Json): string | null {
  if (call !== undefined && call.name.startsWith('mcp__gsd-atlas__')) return call.name.slice('mcp__gsd-atlas__'.length);
  const schema = str(envelope.schema);
  const match = /^gsd-atlas\.([a-z-]+)\//.exec(schema);
  return match === null ? null : match[1].replace('-', '_');
}

function tierFlag(row: Json): string {
  const tier = str(row.tier);
  const letter = tier === '' ? '' : tier === 'precise' ? 'P' : tier === 'grammar' ? 'G' : tier[0].toUpperCase();
  const ambiguous = row.ambiguous === true ? '?' : '';
  const inferred = str(row.confidence) === 'INFERRED' ? '~' : '';
  return `${letter}${ambiguous}${inferred}`;
}

function labelOf(tool: string | null, row: Json): string {
  const parts: string[] = [];
  if (row.hop !== undefined) parts.push(`h${str(row.hop)}`);
  if (row.via !== undefined) parts.push(str(row.via));
  if (row.kind !== undefined) parts.push(str(row.kind));
  const path = str(row.path);
  const name = row.enclosing === null ? '-' : str(row.enclosing !== undefined ? row.enclosing : row.name);
  if (name !== '' && name !== path) parts.push(name);
  if (typeof row.attachedTo === 'string') parts.push(`in:${row.attachedTo}`);
  if (tool === 'code_find' && row.exported === true) parts.push('exp');
  const flag = tierFlag(row);
  if (flag !== '') parts.push(flag);
  const candidates = typeof row.candidates === 'number' && row.candidates > 1 ? `c${String(row.candidates)}` : '';
  if (candidates !== '') parts.push(candidates);
  return parts.join(' ');
}

function stripped(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripped);
  if (isObject(value)) {
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (!DROP_KEYS.has(key)) out[key] = stripped(item);
    }
    return out;
  }
  return value;
}

function headOf(data: Json): string {
  const named = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter(isObject).map((item) => `${str(item.name)} ${str(item.kind)} ${str(item.path)}:${str(item.line)}`.trim())
      : [];
  const targets = named(data.targets);
  const seeds = named(data.seeds);
  const out: string[] = [];
  if (targets.length > 0) out.push(`target=${targets.join('; ')}`);
  if (seeds.length > 0) out.push(`seed=${seeds.join('; ')}`);
  for (const [key, value] of Object.entries(data)) {
    if (SEPARATE.has(key)) continue;
    out.push(`${key}=${JSON.stringify(stripped(value))}`);
  }
  return out.join(' ');
}

/**
 * Renders one recorded envelope in the compact format. `withText` false gives the lean form of the
 * design note (position, kind and enclosing symbol only, no matched line). Returns null when the text
 * is not an atlas envelope.
 */
export function renderCompact(raw: string, call?: Call, withText = true): Compact | null {
  let envelope: Json;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    envelope = parsed;
  } catch {
    return null;
  }
  if (typeof envelope.schema !== 'string') return null;
  const tool = toolOf(call, envelope);
  const data = isObject(envelope.data) ? envelope.data : {};
  const results = Array.isArray(data.results) ? data.results.filter(isObject) : [];

  const citations = new Map<string, Json>();
  for (const citation of Array.isArray(envelope.citations) ? envelope.citations : []) {
    if (isObject(citation) && typeof citation.id === 'string') citations.set(citation.id, citation);
  }
  const untrusted = isObject(envelope.untrusted_text) ? envelope.untrusted_text : null;
  const entries = new Map<string, string>();
  for (const entry of untrusted !== null && Array.isArray(untrusted.entries) ? untrusted.entries : []) {
    if (isObject(entry) && typeof entry.ref === 'string' && typeof entry.text === 'string') entries.set(entry.ref, entry.text);
  }

  const groups = new Map<string, string[]>();
  let references = 0;
  for (const row of results) {
    const path = str(row.path);
    if (path === '') continue;
    const line = typeof row.line === 'number' ? row.line : null;
    if (line !== null) references += 1;
    const citation = citations.get(str(row.citation));
    const ref = citation === undefined ? undefined : str(citation.text_ref);
    const found = ref === undefined || ref === '' ? undefined : entries.get(ref);
    const matched = withText && found !== undefined ? unfence(found) : '';
    const position = line === null ? '' : `${String(line)}:${str(row.col)}`;
    const body = [position, labelOf(tool, row)].filter((part) => part !== '').join(' ');
    const lineText = matched === '' ? ` ${body}` : ` ${body} | ${matched}`;
    const list = groups.get(path);
    if (list === undefined) groups.set(path, [lineText]);
    else list.push(lineText);
  }

  const header = [`${tool ?? 'atlas'}`, headOf(data), `rows=${String(results.length)}`];
  const more = str(envelope.more);
  if (more !== '') header.push(`more=${more}`);
  if (envelope.truncated === true) header.push('truncated');
  const watermark = isObject(envelope.watermark) ? envelope.watermark : null;
  const stale = watermark !== null && Array.isArray(watermark.stalePaths) ? watermark.stalePaths : [];
  if (stale.length > 0) header.push(`stale=${stale.map(str).join(',')}`);
  const degraded = Array.isArray(envelope.degraded) ? envelope.degraded : [];
  if (degraded.length > 0) header.push(`degraded=${degraded.map(str).join(',')}`);

  const lines: string[] = [header.filter((part) => part !== '').join(' ')];
  for (const diagnostic of Array.isArray(envelope.diagnostics) ? envelope.diagnostics : []) {
    if (isObject(diagnostic)) lines.push(`! ${str(diagnostic.code)}: ${str(diagnostic.message)}`);
  }
  if (groups.size > 0) {
    const nonce = untrusted === null ? '' : str(untrusted.nonce);
    if (nonce !== '') lines.push(`BEGIN-UNTRUSTED-${nonce}`);
    for (const [path, rows] of groups) {
      lines.push(path);
      lines.push(...rows);
    }
    if (nonce !== '') lines.push(`END-UNTRUSTED-${nonce}`);
  }
  return { text: lines.join('\n'), references, tool };
}

export const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
/** The bytes/4 token estimate used by `gsd-atlas status` and the design note. */
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);
