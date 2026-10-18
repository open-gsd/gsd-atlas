/**
 * The files of one eval run (D-03, EVL-02, EVL-03): the result rows, the log of every attempt and the
 * per-session metadata.
 *
 * - `results.jsonl`: one `ResultRow` per finished cell. A row is appended in a single write after the
 *   session has been scored, so a process killed at any moment leaves only complete lines, and the next
 *   start continues at the first missing cell. The store validates every row with `ResultRowSchema`
 *   before it writes and refuses a second row for the same cell.
 * - `attempts.jsonl`: one record per attempt of a session, including the infrastructure failures that
 *   were retried (the registered retry rule is in harness.ts).
 * - `sessions.meta.jsonl`: facts about a session that are not part of the scored row: preparation time,
 *   the path of the raw stream, the init event, contamination, cleanup failures.
 *
 * Nothing here imports the system under test.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ResultRowSchema } from './rows.ts';
import type { ResultRow } from './rows.ts';
import { cellId } from './schedule.ts';

export const RESULTS_FILE = 'results.jsonl';
export const ATTEMPTS_FILE = 'attempts.jsonl';
export const META_FILE = 'sessions.meta.jsonl';

export class ResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultsError';
  }
}

/** A record of the attempts and meta sidecars: a `kind` and whatever else the writer knows. */
export interface SidecarRecord {
  kind: string;
  cellId?: string;
  [key: string]: unknown;
}

/**
 * Cuts an incomplete final line (one without its newline) off a JSONL file. A row is appended in one
 * write that ends with a newline, so a line without one was cut off and its cell has no row.
 */
function dropIncompleteTail(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (text === '' || text.endsWith('\n')) return;
  const keep = text.lastIndexOf('\n') + 1;
  fs.truncateSync(file, Buffer.byteLength(text.slice(0, keep), 'utf8'));
}

/** The complete lines of a JSONL file, parsed. An incomplete final line is ignored. */
export function readJsonLines(file: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  lines.pop(); // the text after the last newline: empty, or an incomplete line
  const values: unknown[] = [];
  lines.forEach((line, index) => {
    if (line === '') return;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      throw new ResultsError(`${file}:${String(index + 1)}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return values;
}

export class ResultsStore {
  readonly dir: string;
  readonly resultsPath: string;
  readonly attemptsPath: string;
  readonly metaPath: string;
  /** Cell ids that have more than one row on disk (a hand-made corruption); `summary` reports them. */
  readonly duplicates: string[] = [];
  private readonly rows: ResultRow[] = [];
  private readonly ids = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
    this.resultsPath = path.join(dir, RESULTS_FILE);
    this.attemptsPath = path.join(dir, ATTEMPTS_FILE);
    this.metaPath = path.join(dir, META_FILE);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of [this.resultsPath, this.attemptsPath, this.metaPath]) dropIncompleteTail(file);
    for (const value of readJsonLines(this.resultsPath)) {
      const row = ResultRowSchema.parse(value);
      const id = cellId(row);
      if (this.ids.has(id)) this.duplicates.push(id);
      this.ids.add(id);
      this.rows.push(row);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Validates the row and appends it as one line in one write. */
  append(row: ResultRow): void {
    const valid = ResultRowSchema.parse(row);
    const id = cellId(valid);
    if (this.ids.has(id)) throw new ResultsError(`cell ${id} already has a row`);
    fs.appendFileSync(this.resultsPath, `${JSON.stringify(valid)}\n`);
    this.ids.add(id);
    this.rows.push(valid);
  }

  all(): ResultRow[] {
    return [...this.rows];
  }

  appendAttempt(record: SidecarRecord): void {
    fs.appendFileSync(this.attemptsPath, `${JSON.stringify(record)}\n`);
  }

  appendMeta(record: SidecarRecord): void {
    fs.appendFileSync(this.metaPath, `${JSON.stringify(record)}\n`);
  }
}
