/**
 * Census rows for rule v2 (UNSCORED, UNREGISTERED): the full output of `census.ts --with-tests` (no 150-file ceiling),
 * plus the date of the last commit that touched each declaring file and the kinds of the other declarations.
 *
 *   node scripts/angular-pilot/census-v2.ts --census <census.json> --history <full-history git dir> --sha <pin> --out <json>
 *
 * `--history` is a clone with the pin's history (`git log -1` needs it; a depth-1 clone gives every file the same date).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import type { CensusKind } from './select.ts';
import type { CensusRowV2 } from './select-v2.ts';

export interface RawCensusRow {
  name: string;
  files: string[];
  declFile: string;
  declKind: string;
  grepFiles: number;
  callSiteFiles: number;
  subtypeCount: number;
}

export function rowsFromCensus(raw: readonly RawCensusRow[], dates: ReadonlyMap<string, string>): CensusRowV2[] {
  return raw.map((r) => {
    const others = raw.filter((o) => o.name === r.name && o.declFile !== r.declFile);
    return {
      name: r.name,
      kind: r.declKind as CensusKind,
      file: r.declFile,
      otherDeclFiles: new Set(others.map((o) => o.declFile)).size,
      otherKinds: others.map((o) => o.declKind),
      grepFiles: r.grepFiles,
      callSiteFiles: r.callSiteFiles,
      directSubtypes: r.subtypeCount,
      fileLastChanged: dates.get(r.declFile) ?? '',
    };
  });
}

function main(): void {
  const { values } = parseArgs({ options: { census: { type: 'string' }, history: { type: 'string' }, sha: { type: 'string' }, out: { type: 'string' } } });
  if (values.census === undefined || values.history === undefined || values.sha === undefined || values.out === undefined) throw new Error('usage: --census <json> --history <git dir> --sha <pin> --out <json>');
  const census = JSON.parse(fs.readFileSync(values.census, 'utf8')) as { rows: RawCensusRow[] };
  const dates = new Map<string, string>();
  for (const file of new Set(census.rows.map((r) => r.declFile))) {
    const r = spawnSync('git', ['-C', values.history, 'log', '-1', '--format=%cs', values.sha, '--', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git log failed for ${file}`);
    dates.set(file, r.stdout.trim());
  }
  const rows = rowsFromCensus(census.rows, dates);
  fs.writeFileSync(values.out, `${JSON.stringify({ pin: values.sha, scope: 'all ambiguous exported top-level declarations of tracked packages/**/*.ts non-test sources; grep files = whole-word git grep -l over the whole tree; call sites, subtypes and references searched in spec and test files too; no grep ceiling', rows }, null, 1)}\n`);
  process.stdout.write(`wrote ${String(rows.length)} rows\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
