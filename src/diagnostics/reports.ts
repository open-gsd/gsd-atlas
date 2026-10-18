/**
 * Reports kept on this machine (docs/DIAGNOSTICS.md section 7): `diagnostics preview --save` writes the rendered report
 * to `<state dir>/diagnostics/reports/<name>.md`, `diagnostics history` lists them, and `diagnostics disable` removes the
 * whole `diagnostics` folder. They are local files in the user's own state directory, mode 0600 in a 0700 folder, and a
 * report is never overwritten. Nothing here sends anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DiagnosticsFs } from './io.ts';

/** The folder inside the state directory that holds everything diagnostics keeps. */
export const STATE_FOLDER = 'diagnostics';

/** The most reports `history` lists. */
export const REPORTS_MAX = 200;

/** The most characters of a title `history` returns. */
const TITLE_MAX_CHARS = 300;

/** How much of a saved report is read to find its title. */
const HEAD_BYTES = 4096;

/** A name a person's clock makes: letters, digits, `-`, `_` and `.` inside, no leading dot, short. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export const reportsDir = (stateDir: string): string => path.join(stateDir, STATE_FOLDER, 'reports');

export interface SavedReport {
  readonly title: string;
  readonly labels: readonly string[];
  readonly body: string;
}

/** The file's text: the title and the labels on a line each, a blank line, then the body exactly as it would be posted. */
export const formatSavedReport = (report: SavedReport): string => `Title: ${report.title}\nLabels: ${report.labels.join(', ')}\n\n${report.body}`;

export type SaveReportResult = { readonly ok: true; readonly file: string } | { readonly ok: false };

/** Write `report` as `<name>.md` (else `<name>-1.md` and so on): exclusive create, so an earlier report is never replaced. */
export function saveReport(stateDir: string, name: string, report: SavedReport, io: DiagnosticsFs = fs): SaveReportResult {
  if (!NAME.test(name)) return { ok: false };
  const dir = reportsDir(stateDir);
  try {
    io.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false };
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const file = path.join(dir, attempt === 0 ? `${name}.md` : `${name}-${String(attempt)}.md`);
    let fd: number;
    try {
      fd = io.openSync(file, 'wx', 0o600);
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === 'EEXIST') continue;
      return { ok: false };
    }
    try {
      io.writeFileSync(fd, formatSavedReport(report));
    } catch {
      return { ok: false };
    } finally {
      io.closeSync(fd);
    }
    return { ok: true, file };
  }
  return { ok: false };
}

export interface ReportEntry {
  readonly file: string;
  readonly title: string;
  readonly bytes: number;
}

/** A title made safe to print on one line: no control characters, capped. */
function oneLine(text: string): string {
  let clean = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    clean += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }
  return clean.length <= TITLE_MAX_CHARS ? clean : clean.slice(0, TITLE_MAX_CHARS);
}

/** The saved reports, newest first (names are timestamps), at most {@link REPORTS_MAX}; a file without a title line is skipped. */
export function listReports(stateDir: string, io: DiagnosticsFs = fs): ReportEntry[] {
  const dir = reportsDir(stateDir);
  let names: string[];
  try {
    names = io.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  names.sort().reverse();
  const entries: ReportEntry[] = [];
  for (const name of names.slice(0, REPORTS_MAX)) {
    const file = path.join(dir, name);
    // Only the first line is wanted, so only the first bytes are read, whatever the size of the report.
    const first = headOf(io, file)?.split('\n', 1)[0];
    if (first === undefined || !first.startsWith('Title: ')) continue;
    entries.push({ file: name, title: oneLine(first.slice('Title: '.length)), bytes: sizeOf(io, file) });
  }
  return entries;
}

/** The first bytes of a file that is larger than the bounded read allows. */
function headOf(io: DiagnosticsFs, file: string): string | null {
  let fd: number;
  try {
    fd = io.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = io.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    io.closeSync(fd);
  }
}

function sizeOf(io: DiagnosticsFs, file: string): number {
  try {
    return io.statSync(file).size;
  } catch {
    return 0;
  }
}

export interface RemovedState {
  /** Saved reports that were deleted. */
  readonly reports: number;
  /** True when the `diagnostics` folder existed and was removed. */
  readonly folder: boolean;
}

/** Delete the `diagnostics` folder of the state directory, with every report in it. Other files of the state directory stay. */
export function removeState(stateDir: string, io: DiagnosticsFs = fs): RemovedState {
  const folder = path.join(stateDir, STATE_FOLDER);
  let reports = 0;
  try {
    reports = io.readdirSync(reportsDir(stateDir)).filter((name) => name.endsWith('.md')).length;
  } catch {
    reports = 0;
  }
  let existed = false;
  try {
    existed = io.statSync(folder).isDirectory();
  } catch {
    existed = false;
  }
  if (!existed) return { reports: 0, folder: false };
  try {
    io.rmSync(folder, { recursive: true, force: true });
  } catch {
    return { reports, folder: false };
  }
  return { reports, folder: true };
}
