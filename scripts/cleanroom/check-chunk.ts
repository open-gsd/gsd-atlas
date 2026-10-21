/**
 * node scripts/cleanroom/check-chunk.ts --out-dir <dir> [--final] [--streams-only] [--max-seven-day 0.93]
 *     [--max-five-hour 0.75] [--discard-after <n> --reason <text> [--yes]]
 *
 * The between-chunk check of the clean-room replication (plan 03-39): infrastructure failures, contamination and
 * Max-allowance headroom of a results directory. It reads `results.jsonl`, `attempts.jsonl`,
 * `sessions.meta.jsonl` and `streams/` and writes nothing, except for `--discard-after ... --yes`, which moves
 * the rows of one chunk (and their streams and sidecar records) into a `discarded-<stamp>/` directory.
 *
 * Why it exists: the harness records a rate-limit or infrastructure failure as an INCORRECT answer after two
 * retries and never reruns it, so a quiet failure would become data. Every finding below is a stop for the
 * human; a finding detail names cells and codes, never a stream's answer text and never a path.
 *
 * Replication tooling: Node built-ins and the registered `scripts/eval` modules only, never `src/` (D-02).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseStreamText } from '../eval/claude-session.ts';
import { ResultRowSchema } from '../eval/rows.ts';
import type { ResultRow } from '../eval/rows.ts';
import { cellId } from '../eval/schedule.ts';
import { diffSignature, isInitEvent, signatureOf } from './init-signature.ts';

/**
 * The mean session wall time of the original scored run, in milliseconds (450 rows of docs/eval/results/results.jsonl:
 * atlas 7,910.0, grep 7,627.0). A replication session slower than three times this is a warning.
 */
export const ORIGINAL_MEAN_WALL_MS = 7768.48;

/** Chunk-start ceilings of the Max allowance (plan 03-39, edge Max window). */
export const DEFAULT_MAX_SEVEN_DAY = 0.93;
export const DEFAULT_MAX_FIVE_HOUR = 0.75;

/** The registered number of cells (75 questions, 2 arms, 3 runs). */
export const REGISTERED_ROWS = 450;

/** A session slower than this many times the original mean wall time makes `wall_slow` warn. */
const WALL_SLOW_FACTOR = 3;
/** More than this share of sessions with a permission denial makes `permission_denied_high` warn. */
const PERMISSION_DENIED_SHARE = 0.05;
/** How many cells a finding names before it says "and N more". */
const NAMED_CELLS = 5;

export type Severity = 'stop' | 'warning';

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly detail: string;
}

export interface Headroom {
  readonly fiveHour: number | null;
  readonly sevenDay: number | null;
  readonly fiveHourResetsAt: string | null;
  readonly sevenDayResetsAt: string | null;
  readonly status: string | null;
}

export interface CheckOptions {
  readonly outDir: string;
  readonly originalMeanWallMs?: number;
  readonly now?: Date;
  /** Read only `streams/`: the probe directory has no results files. */
  readonly streamsOnly?: boolean;
  /** Require all 450 rows. */
  readonly final?: boolean;
  readonly maxSevenDay?: number;
  readonly maxFiveHour?: number;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly counts: { readonly rows: number; readonly invalidRows: number; readonly attempts: number; readonly streams: number };
  readonly headroom: Headroom;
  readonly wall: { readonly meanMs: number | null; readonly sessions: number };
  readonly checkedAt: string;
}

const STOP_CODES: readonly string[] = [
  'row_invalid',
  'duplicate_cell',
  'non_ok_session',
  'infrastructure_failure',
  'retry_used',
  'contaminated',
  'prep_failed',
  'init_mismatch',
  'hook_event',
  'rate_limit_rejected',
  'overage_in_use',
  'overage_enabled',
  'headroom_low',
  'credential_access',
  'stream_missing',
];
const WARNING_CODES: readonly string[] = ['cleanup_failed', 'wall_slow', 'permission_denied_high', 'stale_headroom'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Collects the cells behind each code and turns them into one finding per code. */
class Findings {
  private readonly byCode = new Map<string, string[]>();

  add(code: string, detail: string): void {
    const list = this.byCode.get(code) ?? [];
    list.push(detail);
    this.byCode.set(code, list);
  }

  list(): Finding[] {
    const out: Finding[] = [];
    for (const code of [...STOP_CODES, ...WARNING_CODES]) {
      const details = this.byCode.get(code);
      if (details === undefined) continue;
      const shown = details.slice(0, NAMED_CELLS).join('; ');
      const more = details.length > NAMED_CELLS ? ` and ${String(details.length - NAMED_CELLS)} more` : '';
      out.push({ severity: STOP_CODES.includes(code) ? 'stop' : 'warning', code, detail: `${shown}${more}` });
    }
    return out;
  }
}

/** The complete lines of a JSONL text: the text after the last newline (empty, or an incomplete line) is dropped. */
function completeLines(text: string): string[] {
  const lines = text.split('\n');
  lines.pop();
  return lines;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parsed objects of a sidecar file; a line that is not a JSON object is skipped (the sidecars carry no row). */
function readRecords(file: string): Array<Record<string, unknown>> {
  const text = readText(file);
  if (text === null) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of completeLines(text)) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) out.push(value);
    } catch {
      // Not valid JSON: nothing to read from it.
    }
  }
  return out;
}

interface StreamFile {
  readonly file: string;
  readonly name: string;
  readonly mtimeMs: number;
  readonly cell: string | null;
  readonly arm: 'atlas' | 'grep' | null;
}

const STREAM_NAME = /^(.+)\.(atlas|grep|control)\.(\d+)\.a(\d+)\.jsonl$/;

function listStreams(outDir: string): StreamFile[] {
  const dir = path.join(outDir, 'streams');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return names
    .map((name): StreamFile => {
      const match = STREAM_NAME.exec(name);
      const file = path.join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        // Listed a moment ago and gone now: treated as oldest.
      }
      if (match === null) return { file, name, mtimeMs, cell: null, arm: null };
      const arm = match[2] === 'control' ? null : (match[2] as 'atlas' | 'grep');
      return { file, name, mtimeMs, cell: `${match[1] as string}|${match[2] as string}|${match[3] as string}`, arm };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// One stream

const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['credentials file', /\.credentials\.json/],
  ['global config file', /(?:^|[^A-Za-z0-9_.-])\.claude\.json(?![A-Za-z0-9_-])/],
  ['user config directory', /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s"'\\]+|\/Users\/[^/\s"'\\]+|\/root)\/\.claude(?![A-Za-z0-9_.-])/],
];

const INFRASTRUCTURE_TEXT =
  /rate[ _-]?limit|usage limit|limit reached|hit your .{0,40}limit|overloaded|\b429\b|\b529\b|quota|credit|expired|invalid (?:api )?key|invalid (?:authentication|credentials)|not logged in|\/login|log ?in\b|unauthori[sz]ed|authorization|billing/i;

export interface RateInfo {
  readonly status: string | null;
  readonly rateLimitType: string | null;
  readonly isUsingOverage: boolean;
  readonly overageEnabled: boolean;
  readonly windows: ReadonlyArray<{ readonly name: 'five_hour' | 'seven_day'; readonly utilization: number; readonly resetsAt: number | null }>;
}

interface StreamFacts {
  readonly initDiffs: string[] | null;
  readonly hasHook: boolean;
  readonly rates: RateInfo[];
  readonly credentialClasses: string[];
  readonly infrastructureResult: boolean;
  readonly permissionDenials: boolean;
  readonly hasResult: boolean;
}

/** The fields of a `rate_limit_event` that the checks read; null when the event carries no `rate_limit_info`. */
export function rateInfoOf(event: Record<string, unknown>): RateInfo | null {
  const info = event['rate_limit_info'];
  if (!isRecord(info)) return null;
  const windows: Array<{ name: 'five_hour' | 'seven_day'; utilization: number; resetsAt: number | null }> = [];
  const unified = info['unifiedWindows'];
  if (isRecord(unified)) {
    for (const name of ['five_hour', 'seven_day'] as const) {
      const entry = unified[name];
      if (isRecord(entry) && typeof entry['utilization'] === 'number') {
        windows.push({ name, utilization: entry['utilization'], resetsAt: typeof entry['resetsAt'] === 'number' ? entry['resetsAt'] : null });
      }
    }
  } else if ((info['rateLimitType'] === 'five_hour' || info['rateLimitType'] === 'seven_day') && typeof info['utilization'] === 'number') {
    windows.push({
      name: info['rateLimitType'],
      utilization: info['utilization'],
      resetsAt: typeof info['resetsAt'] === 'number' ? info['resetsAt'] : null,
    });
  }
  return {
    status: typeof info['status'] === 'string' ? info['status'] : null,
    rateLimitType: typeof info['rateLimitType'] === 'string' ? info['rateLimitType'] : null,
    isUsingOverage: info['isUsingOverage'] === true || event['isUsingOverage'] === true,
    overageEnabled: info['overageEnabled'] === true || event['overageEnabled'] === true,
    windows,
  };
}

function analyzeStream(textOf: string, arm: 'atlas' | 'grep' | null): StreamFacts {
  const { events } = parseStreamText(textOf);
  const result = events.filter((event) => event.type === 'result').at(-1);
  const resultIsError = result !== undefined && result['is_error'] === true;
  let initDiffs: string[] | null = null;
  if (arm !== null) {
    const init = events.find(isInitEvent);
    if (init === undefined) initDiffs = resultIsError ? [] : ['init event absent'];
    else initDiffs = diffSignature(arm, signatureOf(init));
  }
  const credentialClasses = new Set<string>();
  for (const event of events) {
    if (event.type !== 'assistant' || !isRecord(event['message'])) continue;
    const content = event['message']['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue;
      const input = JSON.stringify(block['input'] ?? null);
      for (const [name, pattern] of CREDENTIAL_PATTERNS) if (pattern.test(input)) credentialClasses.add(name);
    }
  }
  let infrastructureResult = false;
  if (result !== undefined && resultIsError) {
    const apiStatus = result['api_error_status'];
    const body = typeof result['result'] === 'string' ? result['result'] : '';
    infrastructureResult = apiStatus === 429 || apiStatus === 529 || INFRASTRUCTURE_TEXT.test(body);
  }
  const denials = result === undefined ? null : result['permission_denials'];
  return {
    initDiffs,
    hasHook: events.some((event) => event.type === 'system' && typeof event['subtype'] === 'string' && event['subtype'].startsWith('hook')),
    rates: events.filter((event) => event.type === 'rate_limit_event').flatMap((event) => rateInfoOf(event) ?? []),
    credentialClasses: [...credentialClasses].sort(),
    infrastructureResult,
    permissionDenials: Array.isArray(denials) && denials.length > 0,
    hasResult: result !== undefined,
  };
}

/** An epoch (seconds, or milliseconds when it is that large) as an ISO time; null when absent. */
export const iso = (seconds: number | null): string | null => {
  if (seconds === null) return null;
  const ms = seconds > 1e11 ? seconds : seconds * 1000;
  return new Date(ms).toISOString();
};

// ---------------------------------------------------------------------------------------------
// The check

/** Reads a results directory without writing and returns every finding of the section "Replication checks". */
export function checkResultsDir(options: CheckOptions): CheckResult {
  const now = options.now ?? new Date();
  const maxSevenDay = options.maxSevenDay ?? DEFAULT_MAX_SEVEN_DAY;
  const maxFiveHour = options.maxFiveHour ?? DEFAULT_MAX_FIVE_HOUR;
  const findings = new Findings();
  const streamsOnly = options.streamsOnly === true;

  // Rows, attempts and meta records.
  const rows: Array<{ row: ResultRow; id: string }> = [];
  let invalidRows = 0;
  let attemptCount = 0;
  if (!streamsOnly) {
    const resultsText = readText(path.join(options.outDir, 'results.jsonl'));
    if (resultsText !== null) {
      const seen = new Map<string, number>();
      completeLines(resultsText).forEach((line, index) => {
        if (line.trim() === '') return;
        const at = `line ${String(index + 1)}`;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          invalidRows += 1;
          findings.add('row_invalid', `${at}: not valid JSON`);
          return;
        }
        const parsed = ResultRowSchema.safeParse(value);
        if (!parsed.success) {
          invalidRows += 1;
          const issue = parsed.error.issues[0];
          findings.add('row_invalid', `${at}: ${issue === undefined ? 'not a result row' : `${issue.path.join('.') || '(row)'}: ${issue.message}`}`);
          return;
        }
        const id = cellId(parsed.data);
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if ((seen.get(id) as number) > 1) findings.add('duplicate_cell', id);
        rows.push({ row: parsed.data, id });
      });
    }
    if (options.final === true && rows.length + invalidRows !== REGISTERED_ROWS) {
      findings.add('row_invalid', `expected ${String(REGISTERED_ROWS)} rows, found ${String(rows.length + invalidRows)}`);
    }
    for (const { row, id } of rows) {
      if (row.status !== 'ok') findings.add('non_ok_session', `${id} (${row.status})`);
    }

    const rowsOf = new Map<string, number>();
    for (const { id } of rows) rowsOf.set(id, (rowsOf.get(id) ?? 0) + 1);
    const attemptsOf = new Map<string, number>();
    for (const record of readRecords(path.join(options.outDir, 'attempts.jsonl'))) {
      attemptCount += 1;
      const id = typeof record['cellId'] === 'string' ? record['cellId'] : null;
      if (id === null) continue;
      attemptsOf.set(id, (attemptsOf.get(id) ?? 0) + 1);
      if (record['infrastructureFailure'] === true) {
        findings.add('infrastructure_failure', `${id} attempt ${String(record['attempt'] ?? '?')}`);
      }
    }
    for (const [id, count] of attemptsOf) {
      if (count > Math.max(1, rowsOf.get(id) ?? 0)) findings.add('retry_used', `${id} (${String(count)} attempts)`);
    }
    for (const record of readRecords(path.join(options.outDir, 'sessions.meta.jsonl'))) {
      const id = typeof record['cellId'] === 'string' ? record['cellId'] : 'run';
      if (record['kind'] === 'contaminated') findings.add('contaminated', id);
      else if (record['kind'] === 'prep_failed') findings.add('prep_failed', id);
      else if (record['kind'] === 'cleanup_failed') findings.add('cleanup_failed', id);
    }
  }

  // Streams.
  const streams = listStreams(options.outDir);
  let sessionsWithResult = 0;
  let deniedSessions = 0;
  const rateOrder: RateInfo[] = [];
  for (const stream of streams) {
    const text = readText(stream.file);
    const label = stream.cell ?? stream.name;
    if (text === null) {
      findings.add('stream_missing', `${label} (unreadable)`);
      continue;
    }
    const facts = analyzeStream(text, stream.arm);
    if (facts.initDiffs !== null && facts.initDiffs.length > 0) findings.add('init_mismatch', `${label}: ${facts.initDiffs.join(', ')}`);
    if (facts.hasHook) findings.add('hook_event', label);
    if (facts.credentialClasses.length > 0) findings.add('credential_access', `${label}: ${facts.credentialClasses.join(', ')}`);
    if (facts.infrastructureResult) findings.add('infrastructure_failure', `${label}: the session result names a limit, overload, quota, login or billing error`);
    if (facts.hasResult) {
      sessionsWithResult += 1;
      if (facts.permissionDenials) deniedSessions += 1;
    }
    for (const rate of facts.rates) {
      if (rate.status !== null && rate.status !== 'allowed' && rate.status !== 'allowed_warning') findings.add('rate_limit_rejected', `${label} (${rate.status})`);
      if (rate.isUsingOverage) findings.add('overage_in_use', label);
      if (rate.overageEnabled) findings.add('overage_enabled', label);
      rateOrder.push(rate);
    }
  }

  // Every row needs a stream (or, with no rows, there must be some stream).
  const streamCells = new Set(streams.flatMap((stream) => (stream.cell === null ? [] : [stream.cell])));
  if (!streamsOnly) {
    for (const id of new Set(rows.map((entry) => entry.id))) {
      if (!streamCells.has(id)) findings.add('stream_missing', id);
    }
  }
  if (streams.length === 0 && (streamsOnly || rows.length === 0)) findings.add('stream_missing', 'no stream files in the streams directory');

  // Headroom: the latest value of each window, in file order.
  let status: string | null = null;
  let fiveHour: number | null = null;
  let sevenDay: number | null = null;
  let fiveHourResets: number | null = null;
  let sevenDayResets: number | null = null;
  for (const rate of rateOrder) {
    if (rate.status !== null) status = rate.status;
    for (const window of rate.windows) {
      if (window.name === 'five_hour') {
        fiveHour = window.utilization;
        fiveHourResets = window.resetsAt;
      } else {
        sevenDay = window.utilization;
        sevenDayResets = window.resetsAt;
      }
    }
  }
  const headroom: Headroom = { fiveHour, sevenDay, fiveHourResetsAt: iso(fiveHourResets), sevenDayResetsAt: iso(sevenDayResets), status };
  if (streams.length > 0 && rateOrder.length === 0) findings.add('stale_headroom', 'no rate_limit_event in the streams of this directory');
  if (sevenDay !== null && sevenDay >= maxSevenDay) {
    findings.add('headroom_low', `seven-day utilization ${String(sevenDay)} is at or above ${String(maxSevenDay)}`);
  }
  if (fiveHour !== null && fiveHour >= maxFiveHour) {
    findings.add('headroom_low', `five-hour utilization ${String(fiveHour)} is at or above ${String(maxFiveHour)}`);
  }

  // Warnings that need totals.
  let meanMs: number | null = null;
  if (rows.length > 0) {
    meanMs = rows.reduce((total, entry) => total + entry.row.wallMs, 0) / rows.length;
    if (options.originalMeanWallMs !== undefined && meanMs > WALL_SLOW_FACTOR * options.originalMeanWallMs) {
      findings.add('wall_slow', `mean session wall time ${String(Math.round(meanMs))} ms is above ${String(WALL_SLOW_FACTOR)} times the original ${String(options.originalMeanWallMs)} ms`);
    }
  }
  if (sessionsWithResult > 0 && deniedSessions / sessionsWithResult > PERMISSION_DENIED_SHARE) {
    findings.add('permission_denied_high', `${String(deniedSessions)} of ${String(sessionsWithResult)} sessions had a permission denial`);
  }

  const list = findings.list();
  return {
    ok: !list.some((finding) => finding.severity === 'stop'),
    findings: list,
    counts: { rows: rows.length, invalidRows, attempts: attemptCount, streams: streams.length },
    headroom,
    wall: { meanMs, sessions: rows.length },
    checkedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Discarding one chunk

export interface DiscardOptions {
  readonly outDir: string;
  /** Keep this many lines of `results.jsonl`; the rest are moved. */
  readonly after: number;
  readonly reason: string;
  readonly yes: boolean;
  readonly now?: Date;
}

export interface DiscardReport {
  /** True when files were moved; false for a dry run. */
  readonly moved: boolean;
  readonly rows: number;
  readonly cells: readonly string[];
  readonly streams: number;
  readonly dir: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function cellOfLine(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (isRecord(value) && typeof value['questionId'] === 'string' && typeof value['arm'] === 'string' && typeof value['run'] === 'number') {
      return cellId({ questionId: value['questionId'], arm: value['arm'], run: value['run'] });
    }
  } catch {
    // Not a row.
  }
  return null;
}

/**
 * Moves the rows of `results.jsonl` after line `after`, the streams of those cells and the attempt and meta
 * records of those cells into `discarded-<stamp>/`, and leaves the earlier rows untouched. Without `yes` it
 * reports what it would move and changes nothing. The sidecar records go with the rows so that a rerun of a
 * discarded cell is not read as a retry.
 */
export function discardAfter(options: DiscardOptions): DiscardReport {
  const resultsFile = path.join(options.outDir, 'results.jsonl');
  const text = readText(resultsFile);
  if (text === null) throw new Error('results.jsonl not found in the results directory');
  if (options.reason.trim() === '') throw new Error('a reason is required to discard a chunk');
  const lines = completeLines(text);
  if (!Number.isInteger(options.after) || options.after < 0 || options.after > lines.length) {
    throw new RangeError(`--discard-after must be a whole number from 0 to ${String(lines.length)}`);
  }
  const keep = lines.slice(0, options.after);
  const move = lines.slice(options.after);
  const cells = new Set<string>();
  for (const line of move) {
    const id = cellOfLine(line);
    if (id !== null) cells.add(id);
  }
  const streamFiles = listStreams(options.outDir).filter((stream) => stream.cell !== null && cells.has(stream.cell));
  const dir = path.join(options.outDir, `discarded-${stamp(options.now ?? new Date())}`);
  const report = { rows: move.length, cells: [...cells], streams: streamFiles.length, dir };
  if (!options.yes) return { moved: false, ...report };
  if (fs.existsSync(dir)) throw new Error(`${path.basename(dir)} already exists`);
  fs.mkdirSync(path.join(dir, 'streams'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.jsonl'), move.length === 0 ? '' : `${move.join('\n')}\n`);
  for (const [file, target] of [
    ['attempts.jsonl', 'attempts.jsonl'],
    ['sessions.meta.jsonl', 'sessions.meta.jsonl'],
  ] as const) {
    const sidecar = readText(path.join(options.outDir, file));
    if (sidecar === null) continue;
    const kept: string[] = [];
    const moved: string[] = [];
    for (const line of completeLines(sidecar)) {
      let owner: string | null = null;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value) && typeof value['cellId'] === 'string') owner = value['cellId'];
      } catch {
        // A line that is not JSON stays where it is.
      }
      (owner !== null && cells.has(owner) ? moved : kept).push(line);
    }
    fs.writeFileSync(path.join(dir, target), moved.length === 0 ? '' : `${moved.join('\n')}\n`);
    fs.writeFileSync(path.join(options.outDir, file), kept.length === 0 ? '' : `${kept.join('\n')}\n`);
  }
  for (const stream of streamFiles) fs.renameSync(stream.file, path.join(dir, 'streams', stream.name));
  fs.writeFileSync(resultsFile, keep.length === 0 ? '' : `${keep.join('\n')}\n`);
  fs.writeFileSync(
    path.join(dir, 'discarded.json'),
    `${JSON.stringify({ reason: options.reason, at: (options.now ?? new Date()).toISOString(), keptLines: keep.length, rows: move.length, cells: [...cells], streams: streamFiles.length }, null, 2)}\n`,
  );
  return { moved: true, ...report };
}

// ---------------------------------------------------------------------------------------------
// Command line

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const USAGE =
  'usage: node scripts/cleanroom/check-chunk.ts --out-dir <dir> [--final] [--streams-only] [--max-seven-day 0.93] [--max-five-hour 0.75]\n' +
  '       node scripts/cleanroom/check-chunk.ts --out-dir <dir> --discard-after <n> --reason <text> [--yes]\n' +
  '\n' +
  'Checks a results directory after a chunk and prints one line per finding, then `check: ok` (exit 0) or `check: stop` (exit 1).\n' +
  '--streams-only reads only streams/ (the probe directory). --discard-after moves the rows after line n and their streams into\n' +
  'discarded-<stamp>/; without --yes it only reports what it would move.\n';

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${name} must be a number, got ${value}`);
  return parsed;
}

/** The command body with injectable output; returns the exit code (0 ok, 1 stop, 2 usage). */
export function runCli(argv: string[], io: Io): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        'out-dir': { type: 'string' },
        final: { type: 'boolean' },
        'streams-only': { type: 'boolean' },
        'max-seven-day': { type: 'string' },
        'max-five-hour': { type: 'string' },
        'discard-after': { type: 'string' },
        reason: { type: 'string' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`check-chunk: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values['help'] === true) {
    io.out(USAGE);
    return 0;
  }
  const outDir = values['out-dir'];
  if (typeof outDir !== 'string') {
    io.err(`check-chunk: --out-dir is required\n${USAGE}`);
    return 2;
  }
  try {
    if (values['discard-after'] !== undefined) {
      const reason = values['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') {
        io.err('check-chunk: --discard-after needs --reason <text>\n');
        return 2;
      }
      const report = discardAfter({
        outDir: path.resolve(outDir),
        after: Number(values['discard-after']),
        reason,
        yes: values['yes'] === true,
      });
      const where = path.basename(report.dir);
      if (report.moved) {
        io.out(`discard: moved ${String(report.rows)} rows, ${String(report.streams)} streams for ${String(report.cells.length)} cells into ${where}\n`);
      } else {
        io.out(`discard: would move ${String(report.rows)} rows, ${String(report.streams)} streams for ${String(report.cells.length)} cells into ${where}; nothing changed (add --yes)\n`);
      }
      return 0;
    }
    const maxSeven = number(values['max-seven-day'] as string | undefined, '--max-seven-day');
    const maxFive = number(values['max-five-hour'] as string | undefined, '--max-five-hour');
    const result = checkResultsDir({
      outDir: path.resolve(outDir),
      originalMeanWallMs: ORIGINAL_MEAN_WALL_MS,
      streamsOnly: values['streams-only'] === true,
      final: values['final'] === true,
      ...(maxSeven === undefined ? {} : { maxSevenDay: maxSeven }),
      ...(maxFive === undefined ? {} : { maxFiveHour: maxFive }),
    });
    const h = result.headroom;
    const show = (value: number | null): string => (value === null ? 'n/a' : String(value));
    io.out(`counts: rows ${String(result.counts.rows)}, attempts ${String(result.counts.attempts)}, streams ${String(result.counts.streams)}\n`);
    io.out(
      `headroom: five-hour ${show(h.fiveHour)} (resets ${h.fiveHourResetsAt ?? 'n/a'}), seven-day ${show(h.sevenDay)} (resets ${h.sevenDayResetsAt ?? 'n/a'}), status ${h.status ?? 'n/a'}\n`,
    );
    for (const finding of result.findings) io.out(`${finding.severity} ${finding.code}: ${finding.detail}\n`);
    io.out(`check: ${result.ok ? 'ok' : 'stop'}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    io.err(`check-chunk: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
