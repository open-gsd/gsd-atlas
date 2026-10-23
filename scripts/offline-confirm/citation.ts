// H3 / N2 computability (measurement A, second half). The registered citation criterion reads the
// agent's FINAL ANSWER (`items[].file`, `items[].line`) and verifies each cited line on disk against
// the key's needles (scripts/eval/score.ts, oracle.ts `verifyCitation`). It reads no atlas record.
// What the compact format must keep is therefore whatever lets a model produce a correct `file` and
// `line`: the path and the line of each reference. This file checks that, on recorded sessions.
import { isAtlasCall } from './stream.ts';
import type { Session } from './stream.ts';

export interface Position {
  readonly path: string;
  readonly line: number;
}

/** (path, line) of every row of an envelope that carries both. */
export function positionsOfEnvelope(raw: string): Position[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return [];
  }
  const results = ((envelope as { data?: { results?: unknown } } | null)?.data?.results ?? []) as unknown;
  const out: Position[] = [];
  if (!Array.isArray(results)) return out;
  for (const row of results) {
    if (typeof row === 'object' && row !== null) {
      const { path, line } = row as { path?: unknown; line?: unknown };
      if (typeof path === 'string' && typeof line === 'number') out.push({ path, line });
    }
  }
  return out;
}

/** (path, line) read back out of a compact page: a path header line, then ` line:col ...` rows under it. */
export function positionsOfCompact(text: string): Position[] {
  const out: Position[] = [];
  let current: string | null = null;
  const lines = text.split('\n');
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith('BEGIN-UNTRUSTED-') || line.startsWith('END-UNTRUSTED-') || line.startsWith('!')) continue;
    if (line.startsWith(' ')) {
      const row = /^ (\d+):\d* /.exec(line);
      if (row !== null && current !== null) out.push({ path: current, line: Number(row[1]) });
    } else {
      current = line;
    }
  }
  return out;
}

export interface Provenance {
  /** Answer items that carry a line. */
  readonly itemsWithLine: number;
  /** ... whose (file, line) is a row an atlas call of the session returned. */
  readonly exactFromAtlas: number;
  /** ... whose file is a returned file but whose line is not a returned line of it. */
  readonly fileOnlyFromAtlas: number;
  /** ... whose file atlas did not return in that session. */
  readonly notFromAtlas: number;
}

export function provenanceOf(session: Session): Provenance | null {
  const atlas = session.calls.filter(isAtlasCall);
  if (atlas.length === 0 || session.answer === null) return null;
  const rows = new Set<string>();
  const files = new Set<string>();
  for (const call of atlas) {
    if (call.result === null) continue;
    for (const position of positionsOfEnvelope(call.result)) {
      rows.add(`${position.path}:${String(position.line)}`);
      files.add(position.path);
    }
  }
  const items = Array.isArray(session.answer.items) ? (session.answer.items as { file?: unknown; line?: unknown }[]) : [];
  let withLine = 0;
  let exact = 0;
  let fileOnly = 0;
  let none = 0;
  for (const item of items) {
    if (typeof item.line !== 'number' || typeof item.file !== 'string') continue;
    withLine += 1;
    const file = item.file.startsWith(`${session.cwd}/`) ? item.file.slice(session.cwd.length + 1) : item.file;
    if (rows.has(`${file}:${String(item.line)}`)) exact += 1;
    else if (files.has(file)) fileOnly += 1;
    else none += 1;
  }
  return { itemsWithLine: withLine, exactFromAtlas: exact, fileOnlyFromAtlas: fileOnly, notFromAtlas: none };
}
