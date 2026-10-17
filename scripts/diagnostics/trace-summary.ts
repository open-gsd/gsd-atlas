/**
 * node scripts/diagnostics/trace-summary.ts <trace file>
 *
 * Prints a short summary of a trace written by `trace-spawns.mjs` (plan 02-46): per git subcommand the count and the
 * median, 95th percentile and maximum spawn milliseconds; per save kind (edit, add) the median number of spawns per
 * save and the median write-to-event and write-to-commit milliseconds; and the median and maximum SQL COMMIT
 * milliseconds. Percentiles use the nearest-rank rule of `scripts/freshness-gate.ts` (written here again so a
 * diagnostic never imports the product): the p-th percentile of n values is the value at rank ceil(p * n / 100).
 *
 * A save is everything from one `WRITE edit|add` line to the next, counting only writes after the first spawn (the gate
 * writes its whole synthetic repository before the first process the product starts; those are set-up, not saves). Its event time is the first `EVENT` line after the
 * write; its commit time is the first `SQL COMMIT` line after that event (the write itself when no event was seen), because a commit can land
 * between the write and the event that belongs to something else. Lines that do not parse are skipped and
 * counted. The output holds no path (the trace holds none). It always exits 0: it is a diagnostic, not a gate.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The p-th percentile (0 < p <= 100) of already sorted `sorted`, by nearest rank. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1] as number;
}

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);
const median = (values: readonly number[]): number => percentile(ascending(values), 50);
const fixed = (value: number): string => value.toFixed(1);
/** SQL statements are short: two decimals keep a sub-millisecond COMMIT from printing as 0.0. */
const fixed2 = (value: number): string => value.toFixed(2);

const LINE = /^(\d+(?:\.\d+)?) T(\d+) (SPAWN|SPAWNED|CLOSE|WRITE|EVENT|SQL)(?: (.*))?$/;
const CLOSE_DETAIL = /^#\d+ exit=(-?\d+|null) total=(\d+(?:\.\d+)?)ms (\S+) (\S+)$/;
const SQL_DETAIL = /^([A-Z?]+) (\d+(?:\.\d+)?)ms$/;

interface Save {
  readonly kind: 'edit' | 'add';
  readonly at: number;
  spawns: number;
  event: number | undefined;
  /** Times of every SQL COMMIT line between this write and the next. */
  readonly commits: number[];
}

/** The summary lines of one trace text. */
export function summarize(text: string): string[] {
  let malformed = 0;
  const closes: Array<{ readonly sub: string; readonly ms: number }> = [];
  const commitMs: number[] = [];
  const saves: Save[] = [];
  let current: Save | undefined;
  let started = false;

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const match = LINE.exec(raw);
    if (match === null) {
      malformed += 1;
      continue;
    }
    const at = Number(match[1]);
    const kind = match[3] as string;
    const detail = match[4] ?? '';
    if (kind === 'CLOSE') {
      const close = CLOSE_DETAIL.exec(detail);
      if (close === null) {
        malformed += 1;
        continue;
      }
      closes.push({ sub: close[4] as string, ms: Number(close[2]) });
    } else if (kind === 'SPAWN') {
      if (!/^#\d+ \S+ \S+$/.test(detail)) {
        malformed += 1;
        continue;
      }
      started = true;
      if (current !== undefined) current.spawns += 1;
    } else if (kind === 'WRITE') {
      if (detail !== 'edit' && detail !== 'add') {
        malformed += 1;
        continue;
      }
      if (!started) continue; // set-up writes of the gate's repository
      current = { kind: detail, at, spawns: 0, event: undefined, commits: [] };
      saves.push(current);
    } else if (kind === 'EVENT') {
      if (current !== undefined && current.event === undefined) current.event = at - current.at;
    } else if (kind === 'SQL') {
      const sql = SQL_DETAIL.exec(detail);
      if (sql === null) {
        malformed += 1;
        continue;
      }
      if (sql[1] === 'COMMIT') {
        commitMs.push(Number(sql[2]));
        current?.commits.push(at);
      }
    }
  }

  const out: string[] = [];
  if (closes.length === 0) {
    out.push('no spawns recorded');
  } else {
    out.push('spawns by git subcommand: count median p95 max (ms, nearest rank)');
    const bySub = new Map<string, number[]>();
    for (const { sub, ms } of closes) bySub.set(sub, [...(bySub.get(sub) ?? []), ms]);
    for (const sub of [...bySub.keys()].sort()) {
      const sorted = ascending(bySub.get(sub) as number[]);
      out.push(`${sub} ${String(sorted.length)} ${fixed(percentile(sorted, 50))} ${fixed(percentile(sorted, 95))} ${fixed(sorted[sorted.length - 1] as number)}`);
    }
    if (saves.length === 0) {
      out.push('saves by kind: none recorded');
    } else {
      out.push('saves by kind: saves median-spawns median-write-to-event-ms median-write-to-commit-ms');
      for (const kind of ['add', 'edit'] as const) {
        const of = saves.filter((save) => save.kind === kind);
        if (of.length === 0) continue;
        const events = of.flatMap((save) => (save.event === undefined ? [] : [save.event]));
        const commits = of.flatMap((save) => {
          const eventAt = save.at + (save.event ?? 0);
          const first = save.commits.find((time) => time >= eventAt);
          return first === undefined ? [] : [first - save.at];
        });
        out.push(
          `${kind} ${String(of.length)} ${String(median(of.map((save) => save.spawns)))} ${events.length === 0 ? 'n/a' : fixed(median(events))} ${commits.length === 0 ? 'n/a' : fixed(median(commits))}`,
        );
      }
    }
    out.push(
      commitMs.length === 0
        ? 'commit statements: none recorded'
        : `commit statements: ${String(commitMs.length)} median ${fixed2(median(commitMs))} ms max ${fixed2(Math.max(...commitMs))} ms`,
    );
  }
  if (malformed > 0) out.push(`malformed lines skipped: ${String(malformed)}`);
  return out;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  const file = process.argv[2];
  let text = '';
  try {
    if (file !== undefined) text = fs.readFileSync(file, 'utf8');
  } catch {
    text = ''; // a diagnostic never fails: an unreadable trace summarises as empty
  }
  process.stdout.write(`${summarize(text).join('\n')}\n`);
}
