/**
 * Tables for the probe note: per group n, means and medians of the measured quantities. Descriptive only;
 * with n this small no test of significance is attempted and no verdict is computed.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { median } from './payload.ts';

export interface ReportRecord {
  config: string;
  firstRequest: { total: number } | null;
  usage: { input: number; cacheCreation: number; cacheRead: number; output: number; billable: number };
  atlasCalls: number;
  toolCallsExStructured: number;
  costUsd: number | null;
  wallMs: number;
  skillLoaded: boolean;
  answer: { equal: boolean } | null;
  [extra: string]: unknown;
}

export const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

interface Agg {
  mean: number;
  median: number;
}
const agg = (values: readonly number[]): Agg => ({ mean: mean(values), median: median(values) });

export interface GroupStats {
  n: number;
  firstRequest: Agg;
  billable: Agg;
  input: Agg;
  cacheCreation: Agg;
  cacheRead: Agg;
  output: Agg;
  toolCalls: Agg;
  wallMs: Agg;
  costUsd: Agg & { sum: number };
  atlasSessions: number;
  skillLoaded: number;
  answerEqual: number;
  answerScored: number;
}

export function groupStats(records: readonly ReportRecord[], keyOf: (r: ReportRecord) => string): Map<string, GroupStats> {
  const groups = new Map<string, ReportRecord[]>();
  for (const r of records) {
    const k = keyOf(r);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [r]);
    else list.push(r);
  }
  const out = new Map<string, GroupStats>();
  for (const [k, list] of groups) {
    const cost = list.map((r) => r.costUsd ?? 0);
    const scored = list.filter((r) => r.answer !== null);
    out.set(k, {
      n: list.length,
      firstRequest: agg(list.map((r) => r.firstRequest?.total ?? 0)),
      billable: agg(list.map((r) => r.usage.billable)),
      input: agg(list.map((r) => r.usage.input)),
      cacheCreation: agg(list.map((r) => r.usage.cacheCreation)),
      cacheRead: agg(list.map((r) => r.usage.cacheRead)),
      output: agg(list.map((r) => r.usage.output)),
      toolCalls: agg(list.map((r) => r.toolCallsExStructured)),
      wallMs: agg(list.map((r) => r.wallMs)),
      costUsd: { ...agg(cost), sum: cost.reduce((a, b) => a + b, 0) },
      atlasSessions: list.filter((r) => r.atlasCalls > 0).length,
      skillLoaded: list.filter((r) => r.skillLoaded).length,
      answerEqual: scored.filter((r) => r.answer?.equal === true).length,
      answerScored: scored.length,
    });
  }
  return out;
}

const f0 = (n: number): string => String(Math.round(n));
const f2 = (n: number): string => n.toFixed(2);
const f3 = (n: number): string => n.toFixed(3);

/** One row per group: tokens (mean / median), split of the mean, tool calls, atlas sessions, cost. */
export function renderTable(stats: ReadonlyMap<string, GroupStats>, label: string): string {
  const header = [label, 'n', 'first request (mean)', 'billable (mean / median)', 'in / cache-create / cache-read / out (mean)', 'tool calls (mean)', 'sessions with atlas call', 'skill loaded', 'answer = key', 'wall s (mean)', 'cost USD (mean / sum)'];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const [k, s] of stats) {
    lines.push(
      `| ${[
        k,
        String(s.n),
        f0(s.firstRequest.mean),
        `${f0(s.billable.mean)} / ${f0(s.billable.median)}`,
        `${f0(s.input.mean)} / ${f0(s.cacheCreation.mean)} / ${f0(s.cacheRead.mean)} / ${f0(s.output.mean)}`,
        f2(s.toolCalls.mean),
        `${String(s.atlasSessions)}/${String(s.n)}`,
        `${String(s.skillLoaded)}/${String(s.n)}`,
        s.answerScored === 0 ? 'n/a' : `${String(s.answerEqual)}/${String(s.answerScored)}`,
        f2(s.wallMs.mean / 1000),
        `${f3(s.costUsd.mean)} / ${f3(s.costUsd.sum)}`,
      ].join(' | ')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { by: { type: 'string', default: 'config' } }, allowPositionals: true });
  const records: ReportRecord[] = [];
  for (const file of positionals) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim() !== '') records.push(JSON.parse(line) as ReportRecord);
  }
  const by = values.by as string;
  process.stdout.write(renderTable(groupStats(records, (r) => String(r[by] ?? 'n/a')), by));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
